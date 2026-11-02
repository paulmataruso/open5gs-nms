import { Router, Request, Response } from 'express';
import pino from 'pino';
import * as fs from 'fs/promises';
import { safeNsenter } from '../../infrastructure/system/safe-nsenter';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import {
  KEA_CONF_PATH, KEA_LEASES_PATH, KEA_SERVICE,
  buildKeaConfig, parseKeaConfig, parseDhcpInterfaces, validateDhcpConfig,
  parseKeaLeases, reservedIpsOf, EMPTY_DHCP_CONFIG,
  type DhcpConfig,
} from '../../domain/services/dhcp-config';

// DHCP server module — Kea DHCPv4.
//
// Host-side work goes through safeNsenter (CLAUDE.md pattern #20): nsenter -p
// forks internally, so a plain execFile + timeout orphans the real process.
//
// Host files are read/written at /proc/1/root/<path> from inside this container;
// commands run via nsenter already sit in the host's mount namespace and use the
// plain path. Same split as auto-config.ts.
const hostPath = (p: string) => `/proc/1/root${p}`;

const APT_PACKAGES = ['kea-dhcp4-server'];

async function readHostFile(p: string): Promise<string | null> {
  try { return await fs.readFile(hostPath(p), 'utf-8'); } catch { return null; }
}

async function serviceState(unit: string): Promise<{ active: boolean; enabled: boolean }> {
  const [a, e] = await Promise.all([
    safeNsenter('systemctl', ['is-active', unit]).catch(() => ({ stdout: '' })),
    safeNsenter('systemctl', ['is-enabled', unit]).catch(() => ({ stdout: '' })),
  ]);
  return { active: a.stdout.trim() === 'active', enabled: e.stdout.trim() === 'enabled' };
}

async function listInterfaces() {
  const [addr, dummy] = await Promise.all([
    safeNsenter('ip', ['-o', '-4', 'addr', 'show']).catch(() => ({ stdout: '' })),
    safeNsenter('ip', ['-o', 'link', 'show', 'type', 'dummy']).catch(() => ({ stdout: '' })),
  ]);
  return parseDhcpInterfaces(addr.stdout, dummy.stdout);
}

export function createDhcpRouter(logger: pino.Logger, auditLogger: IAuditLogger): Router {
  const router = Router();

  // GET /status — installed/running/enabled, plus whatever else is already
  // holding :67, which is the single most common reason Kea will not start.
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const [state, conf, binary, port] = await Promise.all([
        serviceState(KEA_SERVICE),
        readHostFile(KEA_CONF_PATH),
        safeNsenter('test', ['-x', '/usr/sbin/kea-dhcp4']).then(() => true).catch(() => false),
        safeNsenter('ss', ['-lnup']).catch(() => ({ stdout: '' })),
      ]);
      const cfg = conf ? parseKeaConfig(conf) : EMPTY_DHCP_CONFIG;
      const onPort67 = port.stdout.split('\n')
        .filter(l => /:67\s/.test(l))
        .map(l => l.match(/users:\(\("([^"]+)"/)?.[1] ?? 'unknown')
        .filter(n => !/^kea/.test(n));
      let version: string | null = null;
      if (binary) {
        version = await safeNsenter('kea-dhcp4', ['-v']).then(r => r.stdout.trim().split('\n')[0]).catch(() => null);
      }
      res.json({
        success: true,
        installed: binary,
        configured: !!conf && cfg.subnets.length > 0,
        running: state.active,
        enabled: state.enabled,
        version,
        interfaces: cfg.interfaces,
        subnetCount: cfg.subnets.length,
        reservationCount: cfg.subnets.reduce((n, s) => n + s.reservations.length, 0),
        // Non-Kea listeners on the DHCP port. Reported rather than acted on.
        conflictingListeners: [...new Set(onPort67)],
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'DHCP: status failed');
      res.status(500).json({ error: 'Failed to read DHCP status' });
    }
  });

  // GET /interfaces — what the binding UI offers, including dummy interfaces
  // (flagged, never hidden) and the UE tunnels (blocked, with the reason).
  router.get('/interfaces', async (_req: Request, res: Response) => {
    try {
      res.json(await listInterfaces());
    } catch (err) {
      logger.error({ err: String(err) }, 'DHCP: interface list failed');
      res.status(500).json({ error: 'Failed to list interfaces' });
    }
  });

  router.get('/config', async (_req: Request, res: Response) => {
    try {
      const raw = await readHostFile(KEA_CONF_PATH);
      const cfg = raw ? parseKeaConfig(raw) : EMPTY_DHCP_CONFIG;
      res.json({ success: true, config: cfg, exists: !!raw });
    } catch (err) {
      logger.error({ err: String(err) }, 'DHCP: config read failed');
      res.status(500).json({ error: 'Failed to read DHCP config' });
    }
  });

  // PUT /config — validate, write, then reload.
  //
  // Validation is blocking on anything Kea would reject at startup, because the
  // alternative is a service that silently fails to come back and a UI that
  // reported success. Warnings are returned alongside the saved config instead.
  router.put('/config', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const cfg = req.body?.config as DhcpConfig | undefined;
      if (!cfg || !Array.isArray(cfg.subnets) || !Array.isArray(cfg.interfaces)) {
        res.status(400).json({ error: 'A config with `interfaces` and `subnets` is required' });
        return;
      }
      const validation = validateDhcpConfig(cfg, await listInterfaces());
      if (validation.errors.length > 0) {
        res.status(400).json({ error: validation.errors[0], ...validation });
        return;
      }

      await safeNsenter('mkdir', ['-p', '/etc/kea', '/var/lib/kea', '/var/log/kea']);
      // Written to a temp file in the same directory and renamed, so Kea can
      // never read a half-written config if it reloads mid-write (the same
      // atomic-rename rule CLAUDE.md records for live .so swaps).
      const json = JSON.stringify(buildKeaConfig(cfg), null, 2) + '\n';
      await fs.writeFile(hostPath(`${KEA_CONF_PATH}.tmp`), json, 'utf-8');
      await safeNsenter('mv', [`${KEA_CONF_PATH}.tmp`, KEA_CONF_PATH]);

      // Only reload a server that is already up — writing config for a stopped
      // service should not start it behind the operator's back.
      const { active } = await serviceState(KEA_SERVICE);
      let reloaded = false;
      if (active) {
        try { await safeNsenter('systemctl', ['reload-or-restart', KEA_SERVICE]); reloaded = true; } catch { /* reported below */ }
      }
      const after = await serviceState(KEA_SERVICE);
      await auditLogger.log({ action: 'dhcp_config_save', user, details: `subnets=${cfg.subnets.length} interfaces=${cfg.interfaces.join(',')}`, success: true });
      logger.info({ user, interfaces: cfg.interfaces, subnets: cfg.subnets.length }, 'DHCP config saved');
      res.json({ success: true, config: cfg, warnings: validation.warnings, reloaded, running: after.active });
    } catch (err) {
      logger.error({ err: String(err) }, 'DHCP: config save failed');
      await auditLogger.log({ action: 'dhcp_config_save', user, details: String(err), success: false });
      res.status(500).json({ error: 'Failed to save DHCP config' });
    }
  });

  // GET /leases — read from Kea's memfile.
  //
  // Deliberately the file rather than the control socket: the file needs no
  // extra tooling in this container and works even when the daemon is stopped,
  // which is exactly when an operator wants to see what was leased. The socket
  // is still configured, for reloads.
  router.get('/leases', async (_req: Request, res: Response) => {
    try {
      const [csv, conf] = await Promise.all([readHostFile(KEA_LEASES_PATH), readHostFile(KEA_CONF_PATH)]);
      const cfg = conf ? parseKeaConfig(conf) : EMPTY_DHCP_CONFIG;
      const leases = parseKeaLeases(csv ?? '', Math.floor(Date.now() / 1000), reservedIpsOf(cfg));
      res.json({
        success: true,
        leases,
        activeCount: leases.filter(l => l.state === 'active').length,
        // Distinguishes "no leases yet" from "Kea has never run".
        leaseFileExists: csv !== null,
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'DHCP: lease read failed');
      res.status(500).json({ error: 'Failed to read leases' });
    }
  });

  // POST /install — streamed, because a real apt install of Kea pulls a dozen
  // packages and runs well past nginx's generic 120s /api/ read timeout. Its
  // path is in nginx's streaming-timeout regex (CLAUDE.md pattern #5).
  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const write = (s: string) => res.write(s);
    let ok = false;
    try {
      write('==STEP:apt-update==\n');
      const upd = await safeNsenter('apt-get', ['update'], 300_000);
      write(upd.stdout + upd.stderr);
      write('\n==STEP:install==\n');
      const ins = await safeNsenter(
        'env', ['DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', ...APT_PACKAGES],
        900_000,
      );
      write(ins.stdout + ins.stderr);

      // Kea's package starts and enables itself with its stock config, which
      // serves nothing and would hold :67. Stop it until the operator has
      // actually configured a subnet.
      write('\n==STEP:stop-until-configured==\n');
      await safeNsenter('systemctl', ['stop', KEA_SERVICE]).catch(() => undefined);
      await safeNsenter('systemctl', ['disable', KEA_SERVICE]).catch(() => undefined);
      write(`${KEA_SERVICE} installed but left stopped — configure a subnet, then Start.\n`);
      ok = true;
    } catch (err) {
      write(`\nINSTALL FAILED: ${String(err)}\n`);
      logger.error({ err: String(err) }, 'DHCP: install failed');
    }
    await auditLogger.log({ action: 'dhcp_install', user, details: `success=${ok}`, success: ok });
    res.end();
  });

  // Lifecycle. Start refuses on an unconfigured server rather than letting Kea
  // come up serving nothing, and every action re-reads the real state
  // afterwards rather than reporting the command's own exit code.
  for (const action of ['start', 'stop', 'restart'] as const) {
    router.post(`/${action}`, requireAdmin, async (req: Request, res: Response) => {
      const user = (req as any).user?.username ?? 'unknown';
      try {
        if (action === 'start') {
          const conf = await readHostFile(KEA_CONF_PATH);
          const cfg = conf ? parseKeaConfig(conf) : EMPTY_DHCP_CONFIG;
          if (cfg.subnets.length === 0 || cfg.interfaces.length === 0) {
            res.status(400).json({ error: 'Configure at least one subnet and one interface before starting' });
            return;
          }
        }
        await safeNsenter('systemctl', [action, KEA_SERVICE], 60_000);
        if (action === 'start')     await safeNsenter('systemctl', ['enable', KEA_SERVICE]).catch(() => undefined);
        else if (action === 'stop') await safeNsenter('systemctl', ['disable', KEA_SERVICE]).catch(() => undefined);

        const state = await serviceState(KEA_SERVICE);
        const expected = action === 'stop' ? !state.active : state.active;
        if (!expected) {
          // "systemctl start exited 0" is not "the service is running" — Kea
          // exits on a config it dislikes. Surface its own reason.
          const jr = await safeNsenter('journalctl', ['-u', KEA_SERVICE, '-n', '25', '--no-pager']).catch(() => ({ stdout: '' }));
          res.status(500).json({ error: `${KEA_SERVICE} did not ${action}`, journal: jr.stdout.split('\n').slice(-25) });
          return;
        }
        await auditLogger.log({ action: `dhcp_${action}`, user, details: `active=${state.active}`, success: true });
        res.json({ success: true, ...state });
      } catch (err) {
        logger.error({ err: String(err), action }, 'DHCP: lifecycle action failed');
        await auditLogger.log({ action: `dhcp_${action}`, user, details: String(err), success: false });
        res.status(500).json({ error: `Failed to ${action} ${KEA_SERVICE}` });
      }
    });
  }

  return router;
}
