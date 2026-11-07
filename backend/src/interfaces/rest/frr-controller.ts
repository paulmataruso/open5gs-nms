import { Router, Request, Response } from 'express';
import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import { nsenter, createDummyInterface, deleteDummyInterface, dummyNetdevPath } from '../../infrastructure/network/dummy-interface';
import { listHostInterfaces } from '../../infrastructure/network/main-interface';
import {
  ensureDaemonLine, parseEigrpNeighbors, buildFrrSourceScript, restoreFrrFromSnapshot,
  verifyFrr, DEFAULT_FRR_TAG,
} from '../../application/use-cases/frr-source-build';

const execFileAsync = promisify(execFile);

// systemctl needs D-Bus which uses Unix sockets — don't enter the network namespace
const nsenterSvc = async (cmd: string, args: string[] = [], timeoutMs = 20000): Promise<{ stdout: string; stderr: string }> => {
  return execFileAsync('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', cmd, ...args], {
    timeout: timeoutMs,
    encoding: 'utf-8',
    env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/var/run/dbus/system_bus_socket' },
  });
};

import { parseLiveRoutingProcess, ueNetworkStatementCommands } from '../../application/use-cases/frr/ue-subnet-mode';
import {
  buildFrrConfig, liveProtocolOf, generateTransitNetplan, generateDummyNetplan,
  generateEigrpTransitConfig, DEFAULT_FRR_LOG_LEVEL, FRR_LOG_LEVELS,
} from '../../application/use-cases/frr/frr-config-generator';
import type {
  UeSubnet, MigrationPhase, FrrLogLevel, Protocol, ServiceMapping, RouteFilter, MigrationState,
} from '../../application/use-cases/frr/frr-config-generator';
import { planUeNatRules, ueNatRuleArgs } from '../../application/use-cases/host-tuning';

const HOST_STATE_FILE = '/proc/1/root/etc/open5gs-nms/frr-migration-state.json';
const HOST_FRR_CONF   = '/proc/1/root/etc/frr/frr.conf';
const HOST_DAEMONS    = '/proc/1/root/etc/frr/daemons';
const BACKUP_DIR      = '/proc/1/root/etc/open5gs-nms/frr-backup';
const HOST_UPF_YAML   = '/proc/1/root/etc/open5gs/upf.yaml';

// ─── Applying a regenerated frr.conf ──────────────────────────────────────────

// Module-scope, so applyFrrConf() can log outside any one request's router.
const frrLogger = pino({ name: 'frr-apply' });

/**
 * Push a freshly-written /etc/frr/frr.conf into the running FRR.
 *
 * Deliberately `systemctl reload`, never `restart`, for any change an operator
 * can make on a live, converged deployment — see CLAUDE.md pattern #7. A
 * restart tears down the EIGRP adjacency and makes eigrpd reprocess the whole
 * topology during the resync, which is the confirmed trigger for the frr#943
 * crash: applying one new `network` statement by writing frr.conf and
 * restarting hit it twice in a row on this deployment (2026-08-26), and the
 * crash-guard patch that stops the assertion still leaves a corrupted topology
 * entry behind. `reload` runs FRR's own `frr-reload.py` (via the unit's
 * `ExecReload=/usr/lib/frr/frrinit.sh reload`), which diffs the running config
 * against the new file and applies only the delta over vtysh — the same
 * incremental path pattern #7 documents as safe, just driven from a whole-file
 * config instead of hand-typed commands, so the adjacency is never reset.
 *
 * Falls back to a restart when reload genuinely can't do the job:
 *  - `forceRestart` — the caller changed /etc/frr/daemons. Reload cannot start
 *    a daemon that isn't running, so a protocol switch has to restart.
 *  - FRR isn't running yet (initial bring-up — there is no adjacency to
 *    protect, and nothing to reload into).
 *  - The unit reports CanReload=no, or the reload itself fails. A half-applied
 *    running config is worse than taking the restart's risk, and the restart is
 *    also the documented recovery for an already-corrupted topology.
 */
async function applyFrrConf(
  write: (s: string) => void,
  opts: { forceRestart?: boolean; reason?: string } = {},
): Promise<'reloaded' | 'restarted'> {
  const restart = async (why: string) => {
    write(`Restarting FRR (${why})...\n`);
    await nsenterSvc('systemctl', ['restart', 'frr'], 120000);
    return 'restarted' as const;
  };

  if (opts.forceRestart) return restart(opts.reason ?? 'full restart required');

  // No point reloading into a dead FRR, and on initial bring-up there is no
  // established adjacency for a restart to disturb.
  const active = await nsenterSvc('systemctl', ['is-active', 'frr'])
    .then(r => r.stdout.trim() === 'active')
    .catch(() => false);
  if (!active) return restart('FRR not currently running');

  const canReload = await nsenterSvc('systemctl', ['show', 'frr', '-p', 'CanReload'])
    .then(r => r.stdout.includes('CanReload=yes'))
    .catch(() => false);
  if (!canReload) {
    frrLogger.warn('FRR unit reports CanReload=no — falling back to restart');
    return restart('this FRR build has no reload support');
  }

  try {
    write('Reloading FRR (incremental — avoids the frr#943 restart trigger)...\n');
    await nsenterSvc('systemctl', ['reload', 'frr'], 120000);
  } catch (err) {
    // frrinit.sh reload exits non-zero if frr-reload.py could not apply the
    // delta, which can leave the running config partly updated.
    frrLogger.warn({ err: String(err) }, 'FRR reload failed — falling back to restart');
    write(`Reload failed (${String(err)}) — falling back to a full restart.\n`);
    return restart('reload failed');
  }

  // Pattern: never trust the exit code alone (CLAUDE.md "Verify, don't trust success").
  const stillActive = await nsenterSvc('systemctl', ['is-active', 'frr'])
    .then(r => r.stdout.trim() === 'active')
    .catch(() => false);
  if (!stillActive) return restart('FRR went inactive after reload');

  return 'reloaded';
}

// ─── Types ────────────────────────────────────────────────────────────────────
// Defined alongside the generators that consume them, and re-exported here so
// existing importers of this module keep working.
export {
  FRR_LOG_LEVELS,
} from '../../application/use-cases/frr/frr-config-generator';
export type {
  UeSubnet, MigrationPhase, FrrLogLevel, Protocol, ServiceMapping, RouteFilter, MigrationState,
} from '../../application/use-cases/frr/frr-config-generator';

// ─── State helpers ────────────────────────────────────────────────────────────

function loadState(): MigrationState {
  try {
    if (fs.existsSync(HOST_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(HOST_STATE_FILE, 'utf-8'));
    }
  } catch {}
  return {
    phase: 'INIT', protocol: null, protocolConfig: null,
    mgmtInterface: null, transitInterface: null, transitCidr: null,
    servicePlaneInterface: null, serviceMappings: [], routeFilters: [],
    backupTimestamp: null, log: [], updatedAt: new Date().toISOString(),
  };
}

function saveState(state: MigrationState): void {
  const dir = path.dirname(HOST_STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(HOST_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function appendLog(state: MigrationState, phase: MigrationPhase, msg: string, ok: boolean): void {
  state.log.push({ ts: new Date().toISOString(), phase, msg, ok });
  if (state.log.length > 200) state.log = state.log.slice(-200);
}

// Keep the outbound permit prefix list in sync with serviceMappings.
// serviceMappings is the single source of truth for advertised VSI IPs.
function syncOutFilterFromMappings(state: MigrationState): void {
  if (!state.routeFilters) return;
  const outFilter = state.routeFilters.find(f => f.direction === 'out' && f.action === 'permit');
  if (outFilter) {
    outFilter.prefixes = state.serviceMappings.map(s => `${s.ip}/32`);
  }
}

// ─── FRR config generators ────────────────────────────────────────────────────

// Detect the installed FRR version string (e.g. "8.4.4", or
// "10.6.1-open5gsnms1" for this project's own source build) from vtysh output.
//
// Captures the WHOLE version token, not just the x.y.z prefix. `show
// running-config` renders `frr version` as the compiled-in version INCLUDING
// any packager suffix — `10.6.1-open5gsnms1` here, set by the FRR source build's
// --with-pkg-extra-version — but WITHOUT the trailing `-g<commit>` that `show
// version` appends. Emitting a bare `10.6.1` therefore left a permanent
// one-line difference between the generated config and the running one, so
// every regeneration and every `frr-reload.py --test` reported a pending
// change that would never go away. That is precisely the noise that hides a
// real delta, which is the whole reason the dry-run check is worth having.
async function detectFrrVersion(): Promise<string> {
  try {
    const { stdout } = await nsenter('vtysh', ['-c', 'show version']);
    const m = stdout.match(/FRRouting\s+(\S+)/);
    if (!m) return '9';
    return stripFrrGitSuffix(m[1]);
  } catch {
    return '9';
  }
}

/**
 * Drop the `-g<commit>` suffix `show version` adds (`-gUNKNOWN` when built
 * outside a git checkout, as this project's source build is). Deliberately
 * narrow — it must not eat a legitimate packager suffix that merely starts
 * with "-g", so it matches only a real hash or the literal UNKNOWN.
 */
export function stripFrrGitSuffix(version: string): string {
  return version.replace(/-g(?:[0-9a-f]{6,}|UNKNOWN)$/i, '');
}

// Get hostname for frr.conf
async function detectHostname(): Promise<string> {
  try {
    const { stdout } = await nsenter('hostname');
    return stdout.trim() || 'open5gs';
  } catch {
    return 'open5gs';
  }
}

// The generators themselves live in application/use-cases/frr/frr-config-generator.ts
// (pure, unit-tested, dry-runnable). This wrapper only supplies the two host
// facts they deliberately refuse to read for themselves.
async function generateFrrConfig(state: MigrationState): Promise<string> {
  return buildFrrConfig(state, {
    version: await detectFrrVersion(),
    hostname: await detectHostname(),
  });
}

// ── Guard against regenerating over a protocol the state does not know about ──
//
// loadState() returns whatever the migration wizard last recorded. If anything
// has been changed outside the wizard since — a hand-applied protocol
// migration, for instance — then a generated config describes a DIFFERENT
// router than the one running, and writing it is a self-inflicted outage.
//
// This is not hypothetical: between 2026-11-04 and 2026-11-06 this host ran
// OSPF while the state still said "eigrp", so any endpoint that regenerated
// frr.conf would have replaced a working OSPF process with an EIGRP one.
//
// Returns null when it is safe to proceed, or an operator-facing reason not to.
async function frrRegenerationBlocker(state: MigrationState): Promise<string | null> {
  const { stdout: running } = await nsenter('vtysh', ['-c', 'show running-config'])
    .catch(() => ({ stdout: '' }));
  const live = liveProtocolOf(running);

  // Nothing running yet (fresh install, or FRR down with no config): the
  // generated config is the first one, so there is nothing to contradict.
  if (!live) return null;

  if (state.protocol && state.protocol !== live) {
    return `stored routing protocol is "${state.protocol}" but FRR is running "${live}". `
      + `Writing a generated config would replace the live ${live} process. `
      + `Re-run the routing setup so the stored state matches the router, then retry.`;
  }
  return null;
}

// ── The ONE place a generated frr.conf is written ───────────────────────────
//
// Every regenerate-and-write path goes through here, so the staleness guard
// and the empty-config guard cannot be forgotten at a call site that gets added
// later. There were eight such sites and the guard would have had to be
// repeated at each — which is precisely how this project has lost fixes before
// (a correction living in one branch while another path deploys the old
// behaviour; see CLAUDE.md's stale-artifact entries).
//
// Returns true when frr.conf was replaced.
async function writeGeneratedFrrConf(
  state: MigrationState,
  config: string,
  write: (s: string) => void = () => {},
): Promise<boolean> {
  // buildFrrConfig() returns '' for a state it cannot render (no
  // protocolConfig, no transitInterface). Writing that straight out would
  // truncate frr.conf and leave the router with no routing process at all —
  // several call sites did exactly that with no check.
  if (!config.trim()) {
    const msg = 'Generated FRR config was empty — refusing to overwrite frr.conf.';
    write(`${msg}\n`);
    frrLogger.warn('Refused to write an empty frr.conf');
    return false;
  }

  const blocker = await frrRegenerationBlocker(state);
  if (blocker) {
    const msg = `Refusing to write frr.conf: ${blocker}`;
    write(`${msg}\n`);
    frrLogger.warn({ blocker }, 'Blocked an frr.conf regeneration that disagreed with the live router');
    return false;
  }

  if (fs.existsSync(HOST_FRR_CONF)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(HOST_FRR_CONF, `${HOST_FRR_CONF}.backup-${ts}`);
  }
  fs.writeFileSync(HOST_FRR_CONF, config, 'utf-8');
  return true;
}

// ─── Parsers ──────────────────────────────────────────────────────────────────
// parseEigrpNeighbors lives in application/use-cases/frr-source-build.ts (imported at the
// top of this file) so that module — shared with frr-source-build-controller.ts — doesn't
// have to import back into this file and create a circular dependency.

function parseOspfNeighbors(raw: string): any[] {
  // Format: Neighbor ID  Pri  State     Dead Time  Address         Interface
  //         10.0.0.1     1    Full/DR   00:00:35   192.168.1.2     ens20
  const result: any[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !/^\d+\.\d+\.\d+\.\d+/.test(trimmed)) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 6) continue;
    result.push({ id: parts[0], priority: parts[1], state: parts[2], deadTime: parts[3], address: parts[4], iface: parts[5] });
  }
  return result;
}

function parseBgpSummary(raw: string): any[] {
  // Format: Neighbor  V  AS  MsgRcvd  MsgSent  TblVer  InQ  OutQ  Up/Down  State/PfxRcd
  const result: any[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !/^\d+\.\d+\.\d+\.\d+/.test(trimmed)) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 9) continue;
    const state = parts.slice(8).join(' ');
    result.push({ peer: parts[0], as: parts[2], uptime: parts[8], state: isNaN(Number(state.trim())) ? state.trim() : 'Established' });
  }
  return result;
}

function parseEigrpTopology(raw: string): any[] {
  // Format: P  10.0.1.0/24, 1 successors, FD is 5376
  //              via 192.168.253.1 (5376/2816), ens20
  const result: any[] = [];
  let current: any = null;
  for (const line of raw.split('\n')) {
    const prefixMatch = line.match(/^[PAUQR]\s+(\S+),/);
    if (prefixMatch) {
      current = { prefix: prefixMatch[1], via: [] };
      result.push(current);
    } else if (current) {
      const viaMatch = line.match(/via\s+(\S+)\s+\(([^)]+)\),\s*(\S+)/);
      if (viaMatch) current.via.push({ nexthop: viaMatch[1], metric: viaMatch[2], iface: viaMatch[3] });
    }
  }
  return result;
}

function parseRoutes(raw: string): any[] {
  const result: any[] = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z>*\s]+)\s+(\S+\/\d+)/);
    if (m) result.push({ flags: m[1].trim(), prefix: m[2] });
  }
  return result;
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function createFrrRouter(logger: pino.Logger, auditLogger: IAuditLogger): Router {
  const router = Router();

  router.get('/detect', async (_req: Request, res: Response) => {
    try {
      const { stdout: which } = await nsenter('which', ['vtysh']).catch(() => ({ stdout: '' }));
      const installed = which.trim().length > 0;

      // Existing NMS deployments from before the source-build migration will still have FRR
      // installed via the distro's apt package (8.4.4, with known eigrpd crash bugs) — flag
      // this so the frontend can prompt those users to migrate, regardless of whether the
      // service is currently up.
      const { stdout: dpkgStatus } = await nsenter('dpkg-query', ['-W', '-f=${Status}', 'frr']).catch(() => ({ stdout: '' }));
      const viaApt = /install ok installed/.test(dpkgStatus);

      if (!installed) return res.json({ success: true, installed: false, active: false, protocol: null, neighbors: [], routes: [], viaApt });

      const activeOut = await new Promise<string>(resolve => {
        const c = exec(`nsenter -t 1 -m -u -i -p -- systemctl is-active frr`);
        let out = '';
        c.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
        c.on('close', () => resolve(out.trim()));
      });
      const active = activeOut === 'active';
      if (!active) return res.json({ success: true, installed: true, active: false, protocol: null, neighbors: [], routes: [], viaApt });

      const { stdout: runCfg } = await nsenter('vtysh', ['-c', 'show running-config']).catch(() => ({ stdout: '' }));
      let protocol: Protocol | null = null;
      if (/^router eigrp/m.test(runCfg))   protocol = 'eigrp';
      else if (/^router ospf/m.test(runCfg)) protocol = 'ospf';
      else if (/^router bgp/m.test(runCfg))  protocol = 'bgp';

      let neighbors: any[] = [];
      let topology: any[] = [];
      if (protocol === 'eigrp') {
        const { stdout: nbOut }   = await nsenter('vtysh', ['-c', 'show ip eigrp neighbors']).catch(() => ({ stdout: '' }));
        const { stdout: topoOut } = await nsenter('vtysh', ['-c', 'show ip eigrp topology']).catch(() => ({ stdout: '' }));
        neighbors = parseEigrpNeighbors(nbOut);
        topology  = parseEigrpTopology(topoOut);
      } else if (protocol === 'ospf') {
        const { stdout } = await nsenter('vtysh', ['-c', 'show ip ospf neighbor']).catch(() => ({ stdout: '' }));
        neighbors = parseOspfNeighbors(stdout);
      } else if (protocol === 'bgp') {
        const { stdout } = await nsenter('vtysh', ['-c', 'show bgp summary']).catch(() => ({ stdout: '' }));
        neighbors = parseBgpSummary(stdout);
      }

      const { stdout: routeOut } = await nsenter('vtysh', ['-c', 'show ip route']).catch(() => ({ stdout: '' }));
      res.json({ success: true, installed, active, protocol, runningConfig: runCfg, neighbors, topology, routes: parseRoutes(routeOut), viaApt });
    } catch (err) {
      logger.error({ err: String(err) }, 'frr detect error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // Moved to infrastructure/network/main-interface.ts's listHostInterfaces()
  // (same "which interface owns the default route" logic, now shared with
  // the IP Plan feature) — this handler is now a thin wrapper.
  router.get('/interfaces', async (_req: Request, res: Response) => {
    try {
      const { interfaces, mgmtInterface } = await listHostInterfaces();
      res.json({ success: true, interfaces, mgmtInterface });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.get('/state', (_req: Request, res: Response) => {
    try { res.json({ success: true, state: loadState() }); }
    catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });

  router.post('/state/reset', requireAdmin, (_req: Request, res: Response) => {
    try {
      const fresh: MigrationState = {
        phase: 'INIT', protocol: null, protocolConfig: null,
        mgmtInterface: null, transitInterface: null, transitCidr: null,
        servicePlaneInterface: null, serviceMappings: [], routeFilters: [],
        backupTimestamp: null, log: [], updatedAt: new Date().toISOString(),
      };
      saveState(fresh);
      res.json({ success: true, state: fresh });
    } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });

  router.get('/preview-config', async (_req: Request, res: Response) => {
    try { res.json({ success: true, config: await generateFrrConfig(loadState()) }); }
    catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });

  router.post('/migration/configure', requireAdmin, (req: Request, res: Response) => {
    try {
      const state = loadState();
      const { mgmtInterface, transitInterface, transitCidr, servicePlaneInterface, serviceMappings, protocol, protocolConfig } = req.body;
      state.mgmtInterface = mgmtInterface;
      state.transitInterface = transitInterface;
      state.transitCidr = transitCidr;
      state.servicePlaneInterface = servicePlaneInterface;
      state.serviceMappings = serviceMappings ?? [];
      state.protocol = protocol;
      state.protocolConfig = protocolConfig;
      saveState(state);
      res.json({ success: true, state });
    } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });

  router.post('/migration/backup', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const state = loadState();
    try {
      if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      // Backup netplan
      await nsenter('cp', ['-r', '/etc/netplan', `${BACKUP_DIR.replace('/proc/1/root', '')}/netplan-${ts}`]);
      // Backup FRR config + daemons if they exist
      if (fs.existsSync(HOST_FRR_CONF)) {
        fs.copyFileSync(HOST_FRR_CONF, `${BACKUP_DIR}/frr.conf-${ts}`);
      }
      if (fs.existsSync(HOST_DAEMONS)) {
        fs.copyFileSync(HOST_DAEMONS, `${BACKUP_DIR}/daemons-${ts}`);
      }
      // Backup routing table + interface state
      const { stdout: routeTable } = await nsenter('ip', ['route', 'show', 'table', 'all']);
      fs.writeFileSync(`${BACKUP_DIR}/routes-${ts}.txt`, routeTable);
      const { stdout: ifaceState } = await nsenter('ip', ['-j', 'addr', 'show']);
      fs.writeFileSync(`${BACKUP_DIR}/interfaces-${ts}.json`, ifaceState);
      state.phase = 'BACKUP_CREATED';
      state.backupTimestamp = ts;
      appendLog(state, 'BACKUP_CREATED', `Backup created at ${ts}`, true);
      saveState(state);
      await auditLogger.log({ action: 'frr_backup', user, details: `ts: ${ts}`, success: true });
      res.json({ success: true, state, backupTimestamp: ts });
    } catch (err) {
      appendLog(state, state.phase, `Backup failed: ${String(err)}`, false);
      saveState(state);
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/migration/install-frr', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const state = loadState();
    if (state.phase !== 'BACKUP_CREATED') return res.status(400).json({ success: false, error: `Invalid phase: ${state.phase}` });

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.flushHeaders();
    const write = (msg: string) => res.write(msg);

    // apt is not used to install FRR at all anymore — a fresh host gets a from-source build
    // (same shared script the standalone "Reinstall (Source)" tool uses), with the daemon
    // for this wizard's chosen protocol baked in up front so there's only one service start.
    const daemonOverrides: Record<string, boolean> = { zebra: true, mgmtd: true };
    if (state.protocol === 'eigrp') daemonOverrides.eigrpd = true;
    if (state.protocol === 'ospf')  daemonOverrides.ospfd = true;
    if (state.protocol === 'bgp')   daemonOverrides.bgpd = true;

    try {
      write('Checking if FRR is already installed...\n');
      const { stdout: which } = await nsenter('which', ['vtysh']).catch(() => ({ stdout: '' }));

      if (!which.trim()) {
        write(`Building FRR (${DEFAULT_FRR_TAG}) from source — this can take several minutes...\n`);
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const snapshotDir = `/etc/open5gs-nms/frr-migration-snapshots/${ts}`;
        const script = buildFrrSourceScript({
          targetTag: DEFAULT_FRR_TAG,
          snapshotDir,
          daemonOverrides,
        });
        const scriptHostDir = '/proc/1/root/opt/frr-build';
        fs.mkdirSync(scriptHostDir, { recursive: true });
        fs.writeFileSync(`${scriptHostDir}/run.sh`, script, { mode: 0o755 });

        await new Promise<void>((resolve, reject) => {
          const child = exec(`nsenter -t 1 -m -u -i -n -p -- bash /opt/frr-build/run.sh`, { maxBuffer: 1024 * 1024 * 64 });
          child.stdout?.on('data', (d: Buffer) => write(d.toString()));
          child.stderr?.on('data', (d: Buffer) => write(d.toString()));
          child.on('close', code => code === 0 ? resolve() : reject(new Error(`build exited with code ${code} — see log above`)));
        });
      } else {
        write('FRR already installed — enabling daemons and (re)starting.\n');
        if (fs.existsSync(HOST_DAEMONS)) {
          let d = fs.readFileSync(HOST_DAEMONS, 'utf-8');
          for (const [name, enabled] of Object.entries(daemonOverrides)) {
            d = ensureDaemonLine(d, name, enabled);
          }
          fs.writeFileSync(HOST_DAEMONS, d, 'utf-8');
        }
        await nsenter('systemctl', ['enable', 'frr']);
        await nsenter('systemctl', ['restart', 'frr']);
      }

      write('\nVerifying...\n');
      const { active } = await verifyFrr();
      if (!active) throw new Error('FRR service did not start');

      state.phase = 'FRR_INSTALLED';
      appendLog(state, 'FRR_INSTALLED', 'FRR installed and running', true);
      saveState(state);
      await auditLogger.log({ action: 'frr_install', user, details: 'success', success: true });
      write('\n✅ FRR installed and running.\n');
      res.end();
    } catch (err) {
      appendLog(state, state.phase, `Install failed: ${String(err)}`, false);
      saveState(state);
      write(`\n❌ Error: ${String(err)}\n`);
      res.end();
    }
  });

  router.post('/migration/transit', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const state = loadState();
    if (state.phase !== 'FRR_INSTALLED') return res.status(400).json({ success: false, error: `Invalid phase: ${state.phase}` });

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.flushHeaders();
    const write = (msg: string) => res.write(msg);

    try {
      const content = generateTransitNetplan(state.transitInterface!, state.transitCidr!);
      fs.writeFileSync('/proc/1/root/etc/netplan/60-open5gs-transit.yaml', content, { encoding: 'utf-8', mode: 0o600 });
      write(`Written netplan for ${state.transitInterface} → ${state.transitCidr}\n`);
      write('Applying via netplan apply...\n');
      await nsenter('netplan', ['apply']);

      // Retry up to 15s — netplan apply returns before kernel finishes bringing iface up
      const targetIp = state.transitCidr!.split('/')[0];
      let ipFound = false;
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise(r => setTimeout(r, 1000));
        const { stdout: ipCheck } = await nsenter('ip', ['addr', 'show', state.transitInterface!]).catch(() => ({ stdout: '' }));
        if (ipCheck.includes(targetIp)) { ipFound = true; break; }
        write(`Waiting for ${targetIp} on ${state.transitInterface}... (${attempt + 1}s)\n`);
      }
      if (!ipFound) throw new Error(`Timed out waiting for ${targetIp} on ${state.transitInterface} after 15s`);
      state.phase = 'TRANSIT_CONFIGURED';
      appendLog(state, 'TRANSIT_CONFIGURED', `${state.transitInterface} → ${state.transitCidr}`, true);
      saveState(state);
      await auditLogger.log({ action: 'frr_transit', user, details: `${state.transitInterface} ${state.transitCidr}`, success: true });
      write('\n✅ Transit interface configured.\n');
      res.end();
    } catch (err) {
      appendLog(state, state.phase, `Transit failed: ${String(err)}`, false);
      saveState(state);
      write(`\n❌ Error: ${String(err)}\n`);
      res.end();
    }
  });

  router.post('/migration/neighbor', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const state = loadState();
    if (state.phase !== 'TRANSIT_CONFIGURED') return res.status(400).json({ success: false, error: `Invalid phase: ${state.phase}` });

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.flushHeaders();
    const write = (msg: string) => res.write(msg);

    try {
      write('Generating FRR config (transit-only — VSIs not yet created)...\n');
      const version  = await detectFrrVersion();
      const hostname = await detectHostname();
      const transitNetCidr = (() => {
        const cidr = state.transitCidr ?? '192.168.253.0/30';
        const [ip, prefix] = cidr.split('/');
        const prefixLen = parseInt(prefix);
        const ipParts = ip.split('.').map(Number);
        const mask = ~((1 << (32 - prefixLen)) - 1) >>> 0;
        const ipInt = ((ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3]) >>> 0;
        const netInt = (ipInt & mask) >>> 0;
        const net = [(netInt >>> 24) & 0xff, (netInt >>> 16) & 0xff, (netInt >>> 8) & 0xff, netInt & 0xff].join('.');
        return `${net}/${prefixLen}`;
      })();
      const config = state.protocol === 'eigrp' && state.protocolConfig
        ? generateEigrpTransitConfig(state.protocolConfig, transitNetCidr, version, hostname, state.mgmtInterface ?? '', state.logLevel ?? DEFAULT_FRR_LOG_LEVEL)
        : await generateFrrConfig(state);
      write(config + '\n\n');

      write('Writing /etc/frr/frr.conf...\n');
      await writeGeneratedFrrConf(state, config);

      // Deliberately still a full restart, unlike every other site below: this
      // is the wizard's initial bring-up, so the `router <protocol>` block is
      // brand new rather than a delta, and no adjacency exists yet for the
      // restart to tear down and resync — the frr#943 trigger pattern #7
      // describes needs an already-established neighbor with a populated
      // topology, which this step is what creates in the first place.
      await applyFrrConf(write, {
        forceRestart: true,
        reason: 'new neighbor config on initial bring-up',
      });

      // Wait for FRR to come back up
      write('Waiting for FRR to start...\n');
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const isActive = await new Promise<boolean>(resolve => {
          const c = exec(`nsenter -t 1 -m -u -i -p -- systemctl is-active frr`);
          let out = '';
          c.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
          c.on('close', () => resolve(out.trim() === 'active'));
        });
        if (isActive) { write('FRR is active.\n'); break; }
        write(`  waiting... (${i + 1}s)\n`);
      }

      write('\nFRR config written and service restarted.\n');
      write('Click "Refresh" or wait — the wizard will poll for neighbor establishment every 5 seconds.\n');

      await auditLogger.log({ action: 'frr_neighbor_config', user, details: `protocol: ${state.protocol}`, success: true });
      res.end();
    } catch (err) {
      write(`\n\u274c Error: ${String(err)}\n`);
      res.end();
    }
  });

  router.post('/migration/validate-neighbor', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const state = loadState();
    try {
      let neighborUp = false;
      let detail = '';
      if (state.protocol === 'eigrp') {
        const { stdout } = await nsenter('vtysh', ['-c', 'show ip eigrp neighbors']).catch(() => ({ stdout: '' }));
        const n = parseEigrpNeighbors(stdout);
        neighborUp = n.length > 0;
        detail = neighborUp ? `${n.length} EIGRP neighbor(s)` : 'No EIGRP neighbors yet';
      } else if (state.protocol === 'ospf') {
        const { stdout } = await nsenter('vtysh', ['-c', 'show ip ospf neighbor']).catch(() => ({ stdout: '' }));
        const n = parseOspfNeighbors(stdout);
        neighborUp = n.some(x => x.state?.includes('Full'));
        detail = neighborUp ? 'OSPF FULL' : `OSPF: ${n[0]?.state ?? 'no neighbor'}`;
      } else if (state.protocol === 'bgp') {
        const { stdout } = await nsenter('vtysh', ['-c', 'show bgp summary']).catch(() => ({ stdout: '' }));
        const n = parseBgpSummary(stdout);
        neighborUp = n.some(x => x.state === 'Established');
        detail = neighborUp ? 'BGP Established' : `BGP: ${n[0]?.state ?? 'no peer'}`;
      }
      if (neighborUp && state.phase === 'TRANSIT_CONFIGURED') {
        state.phase = 'NEIGHBOR_UP';
        appendLog(state, 'NEIGHBOR_UP', detail, true);
        saveState(state);
        await auditLogger.log({ action: 'frr_neighbor_up', user, details: detail, success: true });
      }
      res.json({ success: true, neighborUp, detail, state });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/migration/dummies', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const state = loadState();
    if (state.phase !== 'NEIGHBOR_UP') return res.status(400).json({ success: false, error: `Invalid phase: ${state.phase}` });
    try {
      fs.writeFileSync('/proc/1/root/etc/netplan/61-open5gs-dummies.yaml', generateDummyNetplan(state.serviceMappings), { encoding: 'utf-8', mode: 0o600 });
      await nsenter('netplan', ['apply']);
      const { stdout: ipOut } = await nsenter('ip', ['addr', 'show']);
      const missing = state.serviceMappings.filter(svc => !ipOut.includes(svc.ip));
      if (missing.length > 0) throw new Error(`Missing: ${missing.map(m => m.dummyName).join(', ')}`);

      // Now that VSIs exist, write the full FRR config with network statements for each /32
      const fullConfig = await generateFrrConfig(state);
      await writeGeneratedFrrConf(state, fullConfig);
      // One /32 `network` statement per VSI — the exact change shape that
      // triggered frr#943 twice live, so this goes in incrementally.
      await applyFrrConf(() => { /* JSON route — no progress stream */ });
      // Wait for FRR to settle
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const isActive = await new Promise<boolean>(resolve => {
          const c = exec(`nsenter -t 1 -m -u -i -p -- systemctl is-active frr`);
          let out = ''; c.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
          c.on('close', () => resolve(out.trim() === 'active'));
        });
        if (isActive) break;
      }

      state.phase = 'DUMMY_INTERFACES_CREATED';
      appendLog(state, 'DUMMY_INTERFACES_CREATED', `${state.serviceMappings.length} dummies created`, true);
      saveState(state);
      await auditLogger.log({ action: 'frr_dummies', user, details: state.serviceMappings.map(s => s.dummyName).join(', '), success: true });
      res.json({ success: true, state });
    } catch (err) {
      appendLog(state, state.phase, `Dummies failed: ${String(err)}`, false);
      saveState(state);
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/migration/advertise', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const state = loadState();
    if (state.phase !== 'DUMMY_INTERFACES_CREATED') return res.status(400).json({ success: false, error: `Invalid phase: ${state.phase}` });
    try {
      // Check kernel routing table (ip route) for connected /32s
      const { stdout: kernelRoutes } = await nsenter('ip', ['route', 'show']).catch(() => ({ stdout: '' }));
      // Also check vtysh routing table
      const { stdout: frrRoutes } = await nsenter('vtysh', ['-c', 'show ip route']).catch(() => ({ stdout: '' }));
      const combined = kernelRoutes + '\n' + frrRoutes;

      const missing = state.serviceMappings.filter(s => !combined.includes(s.ip));

      // Management leak check — look in FRR routes only
      if (state.mgmtInterface) {
        const { stdout: mgmtOut } = await nsenter('ip', ['-j', 'addr', 'show', state.mgmtInterface]).catch(() => ({ stdout: '[]' }));
        try {
          const parsed = JSON.parse(mgmtOut);
          const mgmtIps = (parsed[0]?.addr_info ?? []).filter((a: any) => a.family === 'inet').map((a: any) => a.local);
          const leaked = mgmtIps.filter((ip: string) => frrRoutes.includes(ip));
          if (leaked.length > 0) {
            return res.status(400).json({ success: false, error: `Management IP ${leaked[0]} is being advertised via FRR — check passive-interface config.` });
          }
        } catch {}
      }

      if (missing.length > 0) {
        return res.json({
          success: false, advertised: false, missing: missing.map(m => m.ip),
          message: `These IPs not found in routing table: ${missing.map(m => m.ip).join(', ')}\n\nIf VSIs are up and FRR is redistributing connected routes, you can skip this check.`,
        });
      }

      state.phase = 'SERVICE_DUAL_STACK_ACTIVE';
      appendLog(state, 'SERVICE_DUAL_STACK_ACTIVE', `All ${state.serviceMappings.length} service IPs verified in routing table`, true);
      saveState(state);
      await auditLogger.log({ action: 'frr_advertise', user, details: 'verified', success: true });
      res.json({ success: true, state, advertised: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/migration/cutover', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const state = loadState();
    if (state.phase !== 'SERVICE_DUAL_STACK_ACTIVE') return res.status(400).json({ success: false, error: `Invalid phase: ${state.phase}` });

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.flushHeaders();
    const write = (msg: string) => res.write(msg);

    try {
      // Read all existing netplan files to understand current state
      const netplanHostDir = '/proc/1/root/etc/netplan';
      const files = fs.readdirSync(netplanHostDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
      write(`Found netplan files: ${files.join(', ')}\n`);

      // Collect all interface configs from existing files, excluding our generated ones
      const generatedFiles = ['60-open5gs-transit.yaml', '61-open5gs-dummies.yaml', '62-open5gs-cutover.yaml'];

      // Parse existing files to find mgmt interface config
      // We'll build a unified config that:
      //   1. Keeps mgmt interface exactly as-is
      //   2. Removes service IPs from the service plane interface
      //   3. Adds transit /30 to transit interface
      //   4. Adds dummy VSI interfaces
      // Then replaces ALL netplan files with this one unified file

      const mgmt  = state.mgmtInterface!;
      const transit = state.transitInterface!;
      const svcIface = state.servicePlaneInterface!;

      // Find how mgmt is configured (DHCP or static)
      let mgmtConfig = '      dhcp4: true';
      for (const f of files) {
        if (generatedFiles.includes(f)) continue;
        try {
          const content = fs.readFileSync(`${netplanHostDir}/${f}`, 'utf-8');
          // If this file configures the mgmt interface
          if (content.includes(mgmt + ':')) {
            const dhcp4 = content.match(new RegExp(`${mgmt}:[\\s\\S]*?dhcp4:\\s*(true|false)`));
            const staticAddrs = content.match(new RegExp(`${mgmt}:[\\s\\S]*?addresses:[\\s\\S]*?- ["']?([\\d./]+)["']?`));
            if (dhcp4) mgmtConfig = `      dhcp4: ${dhcp4[1]}`;
            else if (staticAddrs) mgmtConfig = `      dhcp4: false\n      addresses: [${staticAddrs[1]}]`;
          }
        } catch {}
      }

      write(`\nMgmt interface (${mgmt}): will preserve existing config\n`);
      write(`Transit interface (${transit}): ${state.transitCidr}\n`);
      write(`Service plane (${svcIface}): removing all service IPs\n`);
      write(`VSIs: ${state.serviceMappings.map(s => s.dummyName).join(', ')}\n\n`);

      // Build unified netplan
      const lines = [
        '# Managed by Open5GS NMS — generated at FRR L3 cutover',
        '# Do not manually edit; use the NMS FRR/L3 Routing page to reconfigure',
        'network:',
        '  version: 2',
        '  ethernets:',
        `    ${mgmt}:`,
        mgmtConfig,
        `    ${transit}:`,
        `      addresses: [${state.transitCidr}]`,
      ];

      // Keep svcIface defined but with no addresses (keeps it up for other uses)
      if (svcIface && svcIface !== transit && svcIface !== mgmt) {
        lines.push(`    ${svcIface}:`);
        lines.push('      dhcp4: false');
        lines.push('      addresses: []');
      }

      // Dummy VSI interfaces
      if (state.serviceMappings.length > 0) {
        lines.push('  dummy-devices:');
        for (const svc of state.serviceMappings) {
          lines.push(`    ${svc.dummyName}:`);
          lines.push(`      addresses: [${svc.ip}/32]`);
        }
      }

      lines.push('');
      const unified = lines.join('\n');
      write('Generated unified netplan:\n');
      write(unified + '\n');

      // Write unified config
      const unifiedPath = `${netplanHostDir}/60-open5gs-managed.yaml`;
      fs.writeFileSync(unifiedPath, unified, { encoding: 'utf-8', mode: 0o600 });
      write('Written 60-open5gs-managed.yaml\n');

      // Remove old files that would conflict:
      // - Any file that configures the service plane interface with the old IPs
      // - Our own generated migration files
      const toRemove = [...generatedFiles];
      for (const f of files) {
        if (f === '60-open5gs-managed.yaml') continue;
        if (generatedFiles.includes(f)) continue;
        try {
          const content = fs.readFileSync(`${netplanHostDir}/${f}`, 'utf-8');
          if (content.includes(svcIface + ':') && state.serviceMappings.some(s => content.includes(s.ip))) {
            toRemove.push(f);
          }
        } catch {}
      }

      for (const f of toRemove) {
        const fp = `${netplanHostDir}/${f}`;
        if (fs.existsSync(fp)) {
          // Backup before removing
          fs.copyFileSync(fp, `${BACKUP_DIR}/${f}.pre-cutover`);
          fs.unlinkSync(fp);
          write(`Removed ${f} (backed up)\n`);
        }
      }

      write('\nApplying unified netplan...\n');
      await nsenter('netplan', ['apply']);

      // Verify svc interface no longer has the old IPs
      await new Promise(r => setTimeout(r, 2000));
      const { stdout: ipOut } = await nsenter('ip', ['addr', 'show', svcIface]).catch(() => ({ stdout: '' }));
      const stillPresent = state.serviceMappings.filter(s => ipOut.includes(s.ip));
      if (stillPresent.length > 0) {
        write(`\n⚠️  Warning: ${stillPresent.map(s => s.ip).join(', ')} still on ${svcIface} — may need manual removal\n`);
      } else {
        write(`✅ Service IPs removed from ${svcIface}\n`);
      }

      state.phase = 'CUTOVER_COMPLETE';
      appendLog(state, 'CUTOVER_COMPLETE', `Unified netplan applied, service IPs removed from ${svcIface}`, true);
      saveState(state);
      await auditLogger.log({ action: 'frr_cutover', user, details: `unified netplan, removed ${svcIface} service IPs`, success: true });
      write('\n✅ Cutover complete. Unified netplan is now managing all interfaces.\n');
      res.end();
    } catch (err) {
      appendLog(state, state.phase, `Cutover failed: ${String(err)}`, false);
      saveState(state);
      write(`\n❌ Error: ${String(err)}\n`);
      res.end();
    }
  });

  router.post('/migration/confirm', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const state = loadState();
    try {
      await nsenter('netplan', ['apply']);
      state.phase = 'CUTOVER_COMPLETE';
      appendLog(state, 'CUTOVER_COMPLETE', 'Migration complete', true);
      saveState(state);
      await auditLogger.log({ action: 'frr_confirm', user, details: 'migration complete', success: true });
      res.json({ success: true, state });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/migration/rollback', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const state = loadState();
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.flushHeaders();
    const write = (msg: string) => res.write(msg);
    try {
      write(`Rolling back from phase: ${state.phase}\n`);
      for (const f of ['60-open5gs-transit.yaml', '61-open5gs-dummies.yaml', '62-open5gs-cutover.yaml']) {
        const fp = `/proc/1/root/etc/netplan/${f}`;
        if (fs.existsSync(fp)) { fs.unlinkSync(fp); write(`Removed ${f}\n`); }
      }
      await nsenter('netplan', ['apply']);
      write('Netplan restored.\n');
      if (!['INIT', 'BACKUP_CREATED'].includes(state.phase)) {
        await new Promise<void>(resolve => {
          exec(`nsenter -t 1 -m -u -i -p -- systemctl stop frr`, () => resolve());
        });
        write('FRR stopped.\n');
      }
      const fresh: MigrationState = {
        phase: 'INIT', protocol: state.protocol, protocolConfig: state.protocolConfig,
        mgmtInterface: state.mgmtInterface, transitInterface: state.transitInterface,
        transitCidr: state.transitCidr, servicePlaneInterface: state.servicePlaneInterface,
        serviceMappings: state.serviceMappings, routeFilters: state.routeFilters ?? [], backupTimestamp: null,
        log: [], updatedAt: new Date().toISOString(),
      };
      appendLog(fresh, 'INIT', `Rolled back from ${state.phase}`, true);
      saveState(fresh);
      await auditLogger.log({ action: 'frr_rollback', user, details: `from ${state.phase}`, success: true });
      write('\n✅ Rollback complete.\n');
      res.end();
    } catch (err) {
      write(`\n❌ Rollback error: ${String(err)}\n`);
      res.end();
    }
  });

  // ── POST /api/frr/migration/rewind ───────────────────────────────────────────
  // Step state back to a specific phase WITHOUT touching the system.
  // Lets the user re-run a phase with corrected parameters.
  router.post('/migration/rewind', requireAdmin, (req: Request, res: Response) => {
    const { phase } = req.body as { phase: MigrationPhase };
    const validPhases: MigrationPhase[] = [
      'INIT', 'BACKUP_CREATED', 'FRR_INSTALLED', 'TRANSIT_CONFIGURED',
      'NEIGHBOR_UP', 'DUMMY_INTERFACES_CREATED', 'SERVICE_DUAL_STACK_ACTIVE',
      'LEGACY_INTERFACES_REMOVED',
    ];
    if (!validPhases.includes(phase)) {
      return res.status(400).json({ success: false, error: `Invalid rewind phase: ${phase}` });
    }
    try {
      const state = loadState();
      const prev = state.phase;
      state.phase = phase;
      appendLog(state, phase, `Rewound from ${prev} to ${phase} for re-execution`, true);
      saveState(state);
      res.json({ success: true, state });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── POST /api/frr/route-filters ──────────────────────────────────────────────────────
  router.post('/route-filters', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const state = loadState();
      // Back up previous filters before overwriting
      state.routeFilterBackup = state.routeFilters ?? [];
      state.routeFilters = req.body.filters ?? [];
      saveState(state);

      // If FRR is already running, regenerate and reload config immediately
      const activeOut = await new Promise<string>(resolve => {
        const c = exec(`nsenter -t 1 -m -u -i -p -- systemctl is-active frr`);
        let out = ''; c.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
        c.on('close', () => resolve(out.trim()));
      });
      if (activeOut === 'active') {
        const config = await generateFrrConfig(state);
        await writeGeneratedFrrConf(state, config);
        await applyFrrConf(() => { /* JSON route — no progress stream */ });
        // Give FRR a moment to settle before reporting success
        await new Promise(r => setTimeout(r, 2000));
        await auditLogger.log({ action: 'frr_neighbor_config', user, details: 'route filters updated', success: true });
        res.json({ success: true, state, applied: true });
      } else {
        res.json({ success: true, state, applied: false });
      }
    } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });

  // ── POST /api/frr/route-filters/preview ──────────────────────────────────────────
  router.post('/route-filters/preview', requireAdmin, async (req: Request, res: Response) => {
    try {
      const state = { ...loadState(), routeFilters: req.body.filters ?? [] };
      const config = await generateFrrConfig(state);
      res.json({ success: true, config });
    } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });

  // ── POST /api/frr/route-filters/rollback ─────────────────────────────────────────
  router.post('/route-filters/rollback', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const state = loadState();
      if (!state.routeFilterBackup) return res.status(400).json({ success: false, error: 'No backup to roll back to' });
      state.routeFilters = state.routeFilterBackup;
      state.routeFilterBackup = undefined;
      saveState(state);
      // Reload FRR with previous filters
      const config = await generateFrrConfig(state);
      await writeGeneratedFrrConf(state, config);
      await applyFrrConf(() => { /* JSON route — no progress stream */ });
      await auditLogger.log({ action: 'frr_neighbor_config', user, details: 'route filters rolled back', success: true });
      res.json({ success: true, state, filters: state.routeFilters });
    } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });

  // ── GET /api/frr/parse-running-config ────────────────────────────────────────
  // Parse the running FRR config into structured form for pre-populating the wizard
  router.get('/parse-running-config', async (_req: Request, res: Response) => {
    try {
      const { stdout: raw } = await nsenter('vtysh', ['-c', 'show running-config']).catch(() => ({ stdout: '' }));
      if (!raw) return res.json({ success: true, parsed: null });

      const parsed: Record<string, any> = { protocol: null };

      // EIGRP
      const eigrpAs = raw.match(/^router eigrp (\d+)/m);
      if (eigrpAs) {
        parsed.protocol = 'eigrp';
        parsed.as = parseInt(eigrpAs[1]);
        const net = raw.match(/^\s+network (\S+)/m);
        parsed.transitCidr = net?.[1] ?? '';
      }

      // OSPF — matches both the plain `router ospf` form (the only valid one;
      // see generateOspfConfig()) and, for backward compat when parsing a
      // pre-fix config still on disk from before this was fixed, the old
      // `router ospf <id>` form (which FRR itself never actually accepted,
      // but the text may still be sitting in frr.conf from a prior failed
      // wizard run).
      const ospfMatch = raw.match(/^router ospf\b(?: (\d+))?/m);
      if (ospfMatch) {
        parsed.protocol = 'ospf';
        const rid = raw.match(/ospf router-id (\S+)/);
        parsed.routerId = rid?.[1] ?? '';
        const areaMatch = raw.match(/ip ospf area (\S+)/);
        parsed.area = areaMatch?.[1] ?? '0';
        parsed.networkType = raw.includes('point-to-point') ? 'point-to-point' : 'broadcast';
        parsed.redistributeMethod = raw.includes('redistribute connected') ? 'redistribute' : 'network';
        const passiveMatches = [...raw.matchAll(/passive-interface (\S+)/g)];
        parsed.passiveInterfaces = passiveMatches.map(m => m[1]);
      }

      // BGP
      const bgpAs = raw.match(/^router bgp (\d+)/m);
      if (bgpAs) {
        parsed.protocol = 'bgp';
        parsed.localAs = parseInt(bgpAs[1]);
        const neighbor = raw.match(/neighbor (\S+) remote-as (\d+)/);
        parsed.peerIp = neighbor?.[1] ?? '';
        parsed.peerAs = neighbor ? parseInt(neighbor[2]) : 0;
        const multihop = raw.match(/ebgp-multihop (\d+)/);
        parsed.ebgpMultihop = multihop ? parseInt(multihop[1]) : 1;
        parsed.nextHopSelf = raw.includes('next-hop-self');
      }

      res.json({ success: true, parsed });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── POST /api/frr/reconfigure ───────────────────────────────────────────
  // Apply new FRR config to an already-running instance (skips migration phases)
  router.post('/reconfigure', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.flushHeaders();
    const write = (msg: string) => res.write(msg);
    try {
      // Save new config to state
      const { mgmtInterface, transitInterface, transitCidr, servicePlaneInterface,
              serviceMappings, protocol, protocolConfig } = req.body;
      const state = loadState();
      state.mgmtInterface        = mgmtInterface;
      state.transitInterface     = transitInterface;
      state.transitCidr          = transitCidr;
      state.servicePlaneInterface = servicePlaneInterface;
      state.serviceMappings      = serviceMappings ?? [];
      state.protocol             = protocol;
      state.protocolConfig       = protocolConfig;
      saveState(state);

      // Backup current frr.conf first
      if (fs.existsSync(HOST_FRR_CONF)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        fs.copyFileSync(HOST_FRR_CONF, `${HOST_FRR_CONF}.backup-${ts}`);
        write(`Backed up existing frr.conf to frr.conf.backup-${ts}\n`);
      }

      write('Generating new FRR config...\n');
      const config = await generateFrrConfig(state);
      write(config + '\n\n');

      write('Writing /etc/frr/frr.conf...\n');
      await writeGeneratedFrrConf(state, config);

      // Enable correct daemon
      // Tracked so the apply below only pays for a full restart when the daemon
      // SET actually changed — reload can't start a daemon that isn't running,
      // but a same-protocol edit (log level, timers, networks) doesn't need one.
      let daemonSetChanged = false;
      if (fs.existsSync(HOST_DAEMONS)) {
        const daemonsBefore = fs.readFileSync(HOST_DAEMONS, 'utf-8');
        let d = daemonsBefore;
        d = ensureDaemonLine(d, 'zebra', true);
        // mgmtd is mandatory as of FRR 9.0+ ("mgmtd cannot be disabled") — always enable it
        // regardless of protocol; older daemons files predate this daemon entirely.
        d = ensureDaemonLine(d, 'mgmtd', true);
        if (protocol === 'eigrp') d = ensureDaemonLine(d, 'eigrpd', true);
        if (protocol === 'ospf')  d = ensureDaemonLine(d, 'ospfd', true);
        if (protocol === 'bgp')   d = ensureDaemonLine(d, 'bgpd', true);
        daemonSetChanged = d !== daemonsBefore;
        fs.writeFileSync(HOST_DAEMONS, d, 'utf-8');
        write(`Daemons file ${daemonSetChanged ? 'updated' : 'already correct'}.\n`);
      }

      await applyFrrConf(write, {
        forceRestart: daemonSetChanged,
        reason: 'the enabled daemon set changed',
      });

      write('\n✅ FRR reconfigured successfully.\n');
      await auditLogger.log({ action: 'frr_neighbor_config', user, details: `reconfigure: ${protocol}`, success: true });
      res.end();
    } catch (err) {
      write(`\n❌ Error: ${String(err)}\n`);
      res.end();
    }
  });

  // ── POST /api/frr/log-level ──────────────────────────────────────────────────
  // Changes just the "log syslog"/"log file" severity in frr.conf. Deliberately does NOT
  // restart frr (unlike /reconfigure) — a logging-verbosity change doesn't need the routing
  // daemons to bounce, and reloading via "vtysh -b" (same mechanism the daemons themselves
  // use to sync a config change) avoids an unnecessary EIGRP/OSPF/BGP neighbor flap.
  router.post('/log-level', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const { level } = req.body;
      if (!FRR_LOG_LEVELS.includes(level)) {
        return res.status(400).json({ success: false, error: `Invalid log level: ${level}` });
      }

      const state = loadState();
      state.logLevel = level;
      saveState(state);

      const config = await generateFrrConfig(state);
      if (!config) {
        return res.status(400).json({ success: false, error: 'FRR is not configured yet — complete the routing setup first' });
      }

      await writeGeneratedFrrConf(state, config);

      await nsenter('vtysh', ['-b']);

      await auditLogger.log({ action: 'frr_log_level', user, details: `level: ${level}`, success: true });
      res.json({ success: true, level });
    } catch (err) {
      await auditLogger.log({ action: 'frr_log_level', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── GET /api/frr/ue-subnets ──────────────────────────────────────────────────
  // Read UE subnets from the host's upf.yaml and return IPv4 session pools.
  router.get('/ue-subnets', async (_req: Request, res: Response) => {
    try {
      if (!fs.existsSync(HOST_UPF_YAML)) {
        return res.json({ success: true, subnets: [], stored: loadState().ueSubnets ?? [] });
      }
      const content = fs.readFileSync(HOST_UPF_YAML, 'utf-8');
      const parsed  = yaml.load(content) as any;
      const sessions: any[] = parsed?.upf?.session ?? [];
      const subnets: UeSubnet[] = sessions
        .filter((s: any) => s?.subnet && !s.subnet.includes(':'))  // skip IPv6
        .map((s: any): UeSubnet => ({
          subnet:  s.subnet,
          gateway: s.gateway,
          dnn:     s.dnn,
          dev:     s.dev || 'ogstun',
        }));
      res.json({ success: true, subnets, stored: loadState().ueSubnets ?? [] });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── UE subnet mode helpers ──────────────────────────────────────────────────
  // Shared by apply (routed) and rollback (host-NAT), which are the two halves
  // of one mutually-exclusive choice. See ue-subnet-mode.ts for why the routing
  // protocol is read from FRR rather than from the stored migration state.

  const frrIsActive = () =>
    nsenter('systemctl', ['is-active', 'frr'])
      .then(r => r.stdout.trim() === 'active')
      .catch(() => false);

  // Edits only the UE `network` statements, against the already-established
  // adjacency. Deliberately NOT a frr.conf regeneration + reload: the stored
  // state's protocol can be stale (it is, on this deployment), and a wholesale
  // rewrite is the documented frr#943 trigger.
  const applyUeNetworkStatements = async (
    subnets: string[], op: 'add' | 'remove', write: (s: string) => void,
  ): Promise<void> => {
    if (subnets.length === 0) return;

    const { stdout: running } = await nsenter('vtysh', ['-c', 'show running-config'])
      .catch(() => ({ stdout: '' }));
    const proc = parseLiveRoutingProcess(running);
    if (!proc) {
      write('\nNo routing process found in FRR\u2019s running config — no advertisement to change.\n');
      return;
    }

    const cmds = ueNetworkStatementCommands(proc, subnets, op);
    write(`\n${op === 'add' ? 'Advertising' : 'Withdrawing'} ${subnets.length} UE subnet(s) in "${proc.routerLine}"...\n`);

    const args: string[] = [];
    for (const c of cmds) args.push('-c', c);
    await nsenter('vtysh', args);
    for (const c of cmds) {
      if (/(^|\s)network\s/.test(c)) write(`  ${c}\n`);
    }

    // Persist without a restart. integrated-vtysh-config means this rewrites
    // frr.conf from the RUNNING config, so it cannot resurrect stale state.
    await nsenter('vtysh', ['-c', 'write memory']);
    write('  Persisted to /etc/frr/frr.conf (write memory — no restart).\n');
  };

  const persistIptables = async (write: (s: string) => void) => {
    write('\nPersisting iptables rules to /etc/iptables/rules.v4...\n');
    try {
      const { stdout: savedRules } = await nsenter('iptables-save', []);
      fs.writeFileSync('/proc/1/root/etc/iptables/rules.v4', savedRules, 'utf-8');
      write('Saved.\n');
    } catch (e) {
      write(`Warning: could not persist iptables rules: ${String(e)}\n`);
    }
  };

  // ── POST /api/frr/ue-subnets/apply ───────────────────────────────────────────
  // Save selected UE subnets, remove NAT MASQUERADE rules, add FORWARD rules,
  // update FRR config. Stores removed NAT rules in state for one-click rollback.
  router.post('/ue-subnets/apply', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.flushHeaders();
    const write = (msg: string) => res.write(msg);

    try {
      const subnets: UeSubnet[] = req.body.subnets ?? [];

      // Checked before anything is touched. Switching a pool from host-NAT to
      // routed means removing its MASQUERADE rule and adding the matching
      // advertisement; doing the first without the second leaves UEs attached
      // with no return path at all, so a dead FRR aborts the whole operation
      // rather than half-applying it.
      if (subnets.length > 0 && !(await frrIsActive())) {
        write('FRR is not running — refusing to remove NAT before the routes that replace it can be advertised.\n');
        write('Start FRR and re-run this apply.\n');
        res.end();
        return;
      }

      write(`Saving ${subnets.length} UE subnet(s) to state...\n`);
      const state = loadState();
      state.ueSubnets = subnets;

      const removedNatRules: string[] = [];

      if (subnets.length > 0) {
        // ── 1. Remove NAT MASQUERADE rules for selected subnets ──────────────
        write('\nScanning nat POSTROUTING chain for MASQUERADE rules...\n');
        const { stdout: natOut } = await nsenter('iptables', ['-t', 'nat', '-S', 'POSTROUTING']).catch(() => ({ stdout: '' }));

        for (const u of subnets) {
          const matching = natOut.split('\n').filter(line =>
            line.trim().startsWith('-A POSTROUTING') &&
            line.includes(u.subnet) &&
            line.toUpperCase().includes('MASQUERADE')
          );
          for (const rule of matching) {
            const ruleArgs = rule.trim().split(/\s+/).slice(2); // args after "-A POSTROUTING"
            await nsenter('iptables', ['-t', 'nat', '-D', 'POSTROUTING', ...ruleArgs]).catch(e => {
              write(`  Warning: could not remove ${rule.trim()}: ${String(e)}\n`);
            });
            removedNatRules.push(rule.trim());
            write(`  Removed NAT rule: ${rule.trim()}\n`);
          }
          if (matching.length === 0) {
            write(`  No MASQUERADE rule found for ${u.subnet} — nothing to remove.\n`);
          }
        }

        // ── 2. Enable ip_forward ─────────────────────────────────────────────
        write('\nChecking ip_forward...\n');
        const { stdout: ipfwd } = await nsenter('cat', ['/proc/sys/net/ipv4/ip_forward']).catch(() => ({ stdout: '0' }));
        if (ipfwd.trim() === '1') {
          write('ip_forward already enabled.\n');
        } else {
          await nsenter('sysctl', ['-w', 'net.ipv4.ip_forward=1']);
          write('Enabled ip_forward.\n');
        }

        // ── 3. Add FORWARD rules for tunnel interface(s) ────────────────────
        const devs = [...new Set(subnets.map(u => u.dev || 'ogstun'))];
        for (const dev of devs) {
          write(`\nApplying iptables FORWARD rules for ${dev}...\n`);
          const outOk = await nsenter('iptables', ['-C', 'FORWARD', '-i', dev, '-j', 'ACCEPT']).then(() => true).catch(() => false);
          if (outOk) {
            write(`  -i ${dev} ACCEPT already exists.\n`);
          } else {
            await nsenter('iptables', ['-A', 'FORWARD', '-i', dev, '-j', 'ACCEPT']);
            write(`  Added: -A FORWARD -i ${dev} -j ACCEPT\n`);
          }
          const inOk = await nsenter('iptables', ['-C', 'FORWARD', '-o', dev, '-j', 'ACCEPT']).then(() => true).catch(() => false);
          if (inOk) {
            write(`  -o ${dev} ACCEPT already exists.\n`);
          } else {
            await nsenter('iptables', ['-A', 'FORWARD', '-o', dev, '-j', 'ACCEPT']);
            write(`  Added: -A FORWARD -o ${dev} -j ACCEPT\n`);
          }
        }
      }

      // Persist iptables rules so changes survive reboot (iptables-persistent)
      write('\nPersisting iptables rules to /etc/iptables/rules.v4...\n');
      try {
        const { stdout: savedRules } = await nsenter('iptables-save', []);
        fs.writeFileSync('/proc/1/root/etc/iptables/rules.v4', savedRules, 'utf-8');
        write('Saved.\n');
      } catch (e) {
        write(`Warning: could not persist iptables rules: ${String(e)}\n`);
      }

      // Save rollback info (overwrite any previous — apply always creates fresh rollback)
      state.ueSubnetsRollback = { removedNatRules };
      saveState(state);

      // ── 4. Advertise the pools in the live routing process ─────────────────
      // UE-subnet `network` statements are the precise change that triggered
      // frr#943 twice live (2026-08-26) when applied by restart — so this is a
      // targeted vtysh edit against the established adjacency, never a
      // regenerate-and-reload.
      await applyUeNetworkStatements(subnets.map(u => u.subnet), 'add', write);

      await auditLogger.log({ action: 'frr_ue_subnets', user, details: subnets.map(u => u.subnet).join(', ') || 'cleared', success: true });
      write('\nDone.\n');
      res.end();
    } catch (err) {
      write(`\nError: ${String(err)}\n`);
      res.end();
    }
  });

  // ── POST /api/frr/ue-subnets/rollback ────────────────────────────────────────
  // Reverse a previous apply: remove FORWARD rules, restore NAT MASQUERADE rules,
  // clear UE subnets from FRR config.
  router.post('/ue-subnets/rollback', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.flushHeaders();
    const write = (msg: string) => res.write(msg);

    try {
      const state = loadState();
      const rollback = state.ueSubnetsRollback;
      const activeSubnets = state.ueSubnets ?? [];

      if (activeSubnets.length > 0 && !(await frrIsActive())) {
        write('FRR is not running — refusing to switch modes while the advertisements cannot be withdrawn.\n');
        write('Start FRR and re-run this rollback.\n');
        res.end();
        return;
      }

      // ── 1. Install host NAT for every pool about to stop being advertised ──
      // Built from the pools themselves, NOT from whatever the matching apply
      // happened to remove: `removedNatRules` is empty on any deployment that
      // was never NATed to begin with, which made this endpoint withdraw the
      // routes and put nothing in their place — UEs attached, addressed, and
      // unreachable. Same planner and same rule shape as auto-config.ts, so
      // the two owners cannot disagree about what a NATed pool looks like.
      const natRules = planUeNatRules(activeSubnets);
      if (natRules.length > 0) {
        write('Installing host NAT (MASQUERADE) for the UE pools...\n');
        for (const rule of natRules) {
          const exists = await nsenter(rule.bin, ueNatRuleArgs('-C', rule)).then(() => true).catch(() => false);
          if (exists) {
            write(`  Already present: -s ${rule.subnet} ! -o ${rule.dev} -j MASQUERADE\n`);
          } else {
            await nsenter(rule.bin, ueNatRuleArgs('-A', rule));
            write(`  Added: -s ${rule.subnet} ! -o ${rule.dev} -j MASQUERADE\n`);
          }
        }
      }

      // Plus anything the apply recorded verbatim, in case it carried a
      // selector the planner would not reproduce (a hand-written egress, an
      // extra match). Deduplicated by the -C check above and below.
      if (rollback && rollback.removedNatRules.length > 0) {
        write('\nRestoring NAT rules recorded by the previous apply...\n');
        for (const rule of rollback.removedNatRules) {
          const ruleArgs = rule.trim().split(/\s+/).slice(2); // args after "-A POSTROUTING"
          const exists = await nsenter('iptables', ['-t', 'nat', '-C', 'POSTROUTING', ...ruleArgs]).then(() => true).catch(() => false);
          if (exists) {
            write(`  Already present: ${rule}\n`);
          } else {
            await nsenter('iptables', ['-t', 'nat', '-A', 'POSTROUTING', ...ruleArgs]);
            write(`  Restored: ${rule}\n`);
          }
        }
      }

      await persistIptables(write);

      // ── 2. Withdraw the advertisements, now that NAT carries the traffic ───
      // Order matters: a MASQUERADE rule only binds NEW connections, so adding
      // it first lets new flows move across while established ones still use
      // the routed path, rather than breaking both at the same instant.
      await applyUeNetworkStatements(activeSubnets.map(u => u.subnet), 'remove', write);

      // ── 3. Clear the routed-mode state ─────────────────────────────────────
      // The per-tun FORWARD accepts are deliberately NOT removed. They are not
      // part of this choice: auto-config.ts asserts them for ANY UE data path,
      // NAT or routed, because the FORWARD chain's policy is DROP (Docker sets
      // it) and without them every UE packet is dropped no matter how correct
      // routing and NAT are. Removing them here — as this endpoint used to —
      // turned a mode switch into a total data-plane outage.
      state.ueSubnets = [];
      state.ueSubnetsRollback = undefined;
      saveState(state);
      write('\nCleared UE subnets from state — the pools are now host-NATed.\n');

      await auditLogger.log({ action: 'frr_ue_subnets', user, details: 'rollback', success: true });
      write('\nRollback complete.\n');
      res.end();
    } catch (err) {
      write(`\nError: ${String(err)}\n`);
      res.end();
    }
  });

  // ── Standalone dummy interface management ──────────────────────────────────
  // These endpoints let users create/delete dummy interfaces directly without
  // going through the L3 migration wizard.

  // GET /api/frr/dummy-interfaces
  router.get('/dummy-interfaces', async (_req: Request, res: Response) => {
    try {
      // Get all dummy interfaces from the host
      const { stdout: ipJson } = await nsenter('ip', ['-j', 'link', 'show', 'type', 'dummy']).catch(() => ({ stdout: '[]' }));
      const linkEntries: any[] = JSON.parse(ipJson || '[]');

      // Get address info for each
      const { stdout: addrJson } = await nsenter('ip', ['-j', 'addr', 'show', 'type', 'dummy']).catch(() => ({ stdout: '[]' }));
      const addrEntries: any[] = JSON.parse(addrJson || '[]');
      const addrMap = new Map<string, { ip: string; prefix: number }[]>();
      for (const entry of addrEntries) {
        const addrs = (entry.addr_info ?? [])
          .filter((a: any) => a.family === 'inet')
          .map((a: any) => ({ ip: a.local as string, prefix: a.prefixlen as number }));
        addrMap.set(entry.ifname, addrs);
      }

      // Find NMS-managed ones (have our netdev file)
      const interfaces = linkEntries.map((link: any) => {
        const name    = link.ifname as string;
        const managed = fs.existsSync(dummyNetdevPath(name));
        const addrs   = addrMap.get(name) ?? [];
        return {
          name,
          state:   (link.operstate === 'UNKNOWN' || link.flags?.includes('UP')) ? 'up' : 'down',
          managed,
          addrs,
        };
      });

      res.json({ success: true, interfaces });
    } catch (err) {
      logger.error({ err: String(err) }, 'dummy-interfaces list error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/frr/dummy-interfaces
  // Body: { name, ip, prefix, advertise? }
  router.post('/dummy-interfaces', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const { name, ip, prefix: prefixRaw, advertise } = req.body as { name: string; ip: string; prefix: number; advertise?: boolean };
      const prefix = Number(prefixRaw);

      if (!name || !/^[a-zA-Z][a-zA-Z0-9_-]{0,14}$/.test(name))
        return res.status(400).json({ success: false, error: 'Invalid interface name. Must start with a letter, max 15 chars.' });
      if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip))
        return res.status(400).json({ success: false, error: 'Invalid IP address.' });
      if (isNaN(prefix) || prefix < 1 || prefix > 32)
        return res.status(400).json({ success: false, error: 'Prefix must be 1–32.' });

      // Create the interface + persist systemd-networkd files for reboot survival.
      await createDummyInterface(name, ip, prefix, true);

      // Optionally add to FRR advertisement
      let addedToFrr = false;
      if (advertise) {
        const state = loadState();
        if (state.protocol && state.transitInterface && state.protocolConfig) {
          // Update service mappings (drives network statements + passive-interface entries)
          const existing = state.serviceMappings.find(s => s.dummyName === name);
          if (existing) {
            existing.ip = ip;
          } else {
            state.serviceMappings.push({ service: name, ip, dummyName: name });
          }

          // Sync the outbound permit prefix list directly from serviceMappings —
          // serviceMappings is the single source of truth for which VSI IPs are advertised.
          syncOutFilterFromMappings(state);

          saveState(state);
          const config = await generateFrrConfig(state);
          await writeGeneratedFrrConf(state, config);
          // Best-effort, as before: the interface and state are already
          // committed, so a failure here must not fail the whole request.
          await applyFrrConf(() => { /* JSON route */ })
            .catch(err => frrLogger.warn({ err: String(err) }, 'frr apply failed after dummy create'));
          addedToFrr = true;
        }
      }

      await auditLogger.log({ action: 'frr_dummies', user, details: `created ${name} ${ip}/${prefix}${addedToFrr ? ' (FRR)' : ''}`, success: true });
      res.json({ success: true, name, ip, prefix, addedToFrr });
    } catch (err) {
      logger.error({ err: String(err) }, 'dummy-interfaces create error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // DELETE /api/frr/dummy-interfaces/:name
  router.delete('/dummy-interfaces/:name', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const { name } = req.params;
      if (!name || !/^[a-zA-Z][a-zA-Z0-9_-]{0,14}$/.test(name))
        return res.status(400).json({ success: false, error: 'Invalid interface name.' });

      // Bring down + remove the live interface and its persisted config files.
      await deleteDummyInterface(name);

      // Remove from FRR service mappings if present, re-sync prefix list, then regenerate
      const state = loadState();
      const idx = state.serviceMappings.findIndex(s => s.dummyName === name);
      if (idx !== -1) {
        state.serviceMappings.splice(idx, 1);

        // Re-sync outbound permit list from the updated serviceMappings
        syncOutFilterFromMappings(state);

        saveState(state);
        if (state.protocol && state.transitInterface && state.protocolConfig) {
          const config = await generateFrrConfig(state);
          await writeGeneratedFrrConf(state, config);
          await applyFrrConf(() => { /* JSON route */ })
            .catch(err => frrLogger.warn({ err: String(err) }, 'frr apply failed after dummy delete'));
        }
      }

      await auditLogger.log({ action: 'frr_dummies', user, details: `deleted ${name}`, success: true });
      res.json({ success: true });
    } catch (err) {
      logger.error({ err: String(err) }, 'dummy-interfaces delete error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  return router;
}
