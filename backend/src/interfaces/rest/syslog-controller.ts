import { Router, Request, Response } from 'express';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';

const execFileAsync = promisify(execFile);

// All commands run via nsenter to execute on the HOST — rsyslog isn't installed
// in this container, and the log files being forwarded live on the host filesystem.
const nsenter = async (cmd: string, args: string[] = []): Promise<{ stdout: string; stderr: string }> => {
  return execFileAsync('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', cmd, ...args], {
    timeout: 20000,
    encoding: 'utf-8',
    env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/var/run/dbus/system_bus_socket' },
  });
};

// Host filesystem, reached via /proc/1/root from inside the container.
const HOST_RSYSLOG_CONF     = '/proc/1/root/etc/rsyslog.conf';
const HOST_RSYSLOG_D        = '/proc/1/root/etc/rsyslog.d';
const OUR_CONF_NAME         = '71-open5gs-nms-forward.conf';
const OUR_CONF_HOST_PATH    = `${HOST_RSYSLOG_D}/${OUR_CONF_NAME}`;
// The path rsyslog itself (running in the host mount namespace) sees — used in the
// validate/restart commands that run via nsenter, as opposed to the /proc/1/root
// view this container uses to read/write the file.
const OUR_CONF_REAL_PATH    = `/etc/rsyslog.d/${OUR_CONF_NAME}`;

// Ubuntu confines rsyslogd with AppArmor, which only allows reading /var/log/** by
// default — genieacs logs live outside that (see GENIEACS_LOG_HOST_DIR below), so imfile
// gets a kernel-level "Permission denied" no matter what the Unix file permissions say.
// The packaged profile ships a dedicated, empty "local override" include file for exactly
// this kind of site-specific addition — we only ever append our own marked block to it,
// never touch the rest of the file or the packaged profile itself.
const HOST_APPARMOR_LOCAL_REAL_PATH = '/etc/apparmor.d/local/usr.sbin.rsyslogd';
const HOST_APPARMOR_LOCAL_PATH      = `/proc/1/root${HOST_APPARMOR_LOCAL_REAL_PATH}`;
const HOST_APPARMOR_PROFILE_REAL_PATH = '/etc/apparmor.d/usr.sbin.rsyslogd';
const APPARMOR_MARKER_START = '# --- Open5GS NMS: Syslog Forwarding (do not edit below by hand) ---';
const APPARMOR_MARKER_END   = '# --- end Open5GS NMS ---';

// Every plain-text, line-oriented log file this NMS already knows about. Kept in sync
// with the sources wired into the Unified Logs page (open5gs NFs, GenieACS, FRR) — see
// log-stream-handler.ts / log-streaming.ts for the same lists. Docker container stdout
// (incl. the SAS logs embedded in the backend container's own output) isn't included:
// it isn't a plain-text file on the host, so forwarding it would need either a Docker
// logging-driver change or JSON log parsing — a separate, larger change.
const OPEN5GS_SERVICES = [
  'nrf', 'scp', 'amf', 'smf', 'upf', 'ausf', 'udm', 'udr',
  'pcf', 'nssf', 'bsf', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu',
];
const OPEN5GS_LOG_FILES = OPEN5GS_SERVICES.map(svc => `/var/log/open5gs/${svc}.log`);
// GenieACS logs are NOT bind-mounted at /var/log/genieacs on the host — that path only
// exists inside containers (see docker-compose.yml's "./genieacs/logs:/var/log/genieacs"
// mounts). rsyslog runs on the host, so it needs the real host-side path, which is the
// docker-compose project directory's genieacs/logs folder.
const GENIEACS_LOG_HOST_DIR = process.env.GENIEACS_LOG_HOST_DIR || '/DOCKER/open5gs-nms/genieacs/logs';
const GENIEACS_LOG_FILES = [
  `${GENIEACS_LOG_HOST_DIR}/genieacs-cwmp-access.log`,
  `${GENIEACS_LOG_HOST_DIR}/genieacs-nbi-access.log`,
];
const FRR_LOG_FILES = ['/var/log/frr/frr.log'];

export interface SyslogTarget {
  host: string;
  port: number;
  protocol: 'udp' | 'tcp';
}

function tagFor(filePath: string): string {
  // e.g. /var/log/open5gs/mme.log -> open5gs-mme; genieacs/frr filenames are already
  // distinctive enough (genieacs-cwmp-access, frr) to use as-is.
  const base = filePath.split('/').pop()!.replace(/\.log$/, '');
  return filePath.includes('/open5gs/') ? `open5gs-${base}` : base;
}

function generateRsyslogConf(target: SyslogTarget): string {
  const allFiles = [...OPEN5GS_LOG_FILES, ...GENIEACS_LOG_FILES, ...FRR_LOG_FILES];
  const lines: string[] = [
    '# Managed by Open5GS NMS — Unified Logs > Syslog Forwarding.',
    '# This file is fully owned by the NMS and safe to overwrite; it does NOT modify',
    '# any other rsyslog configuration (rsyslog.conf, other files in rsyslog.d, etc).',
    '# Remove this file (or use the "Disable" action in the NMS) to stop forwarding.',
    '',
    'module(load="imfile" PollingInterval="10")',
    '',
    `ruleset(name="open5gsNmsForward") {`,
    `    action(type="omfwd" Target="${target.host}" Port="${target.port}" Protocol="${target.protocol}" Template="RSYSLOG_SyslogProtocol23Format")`,
    `    stop`,
    `}`,
    '',
  ];
  for (const file of allFiles) {
    lines.push(
      `input(type="imfile" File="${file}" Tag="${tagFor(file)}:" Severity="info" Facility="local0" ruleset="open5gsNmsForward")`
    );
  }
  lines.push('');
  return lines.join('\n');
}

// Ensures the AppArmor local-override include file grants read access to any log
// directories outside /var/log (currently just GenieACS's). Idempotent — replaces only
// our own marked block, leaving any other site-specific rules an admin may have added
// untouched. Returns true if the file was changed (so callers know whether a profile
// reload is needed).
function ensureApparmorOverride(extraDirs: string[]): boolean {
  const existing = fs.existsSync(HOST_APPARMOR_LOCAL_PATH)
    ? fs.readFileSync(HOST_APPARMOR_LOCAL_PATH, 'utf-8')
    : '';

  const blockLines = [
    APPARMOR_MARKER_START,
    ...extraDirs.map(dir => `  ${dir}/** r,`),
    APPARMOR_MARKER_END,
  ];
  const block = blockLines.join('\n');

  const markerRe = new RegExp(
    `${APPARMOR_MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${APPARMOR_MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
  );
  const next = markerRe.test(existing)
    ? existing.replace(markerRe, block)
    : `${existing}${existing.trim() ? '\n\n' : ''}${block}\n`;

  if (next === existing) return false;
  fs.writeFileSync(HOST_APPARMOR_LOCAL_PATH, next, 'utf-8');
  return true;
}

// Pulls target host/port/protocol back out of a previously-written conf file, so the
// status endpoint can show what's currently configured without keeping separate state.
// Exported: this file's own config drop-in IS the state (no JSON side-file exists for
// this module), so a bootstrap/restore orchestrator that has just restored
// 71-open5gs-nms-forward.conf needs this to recover the target before it can call
// configureSyslog() again to reapply the AppArmor/frr-group side effects.
export function parseTarget(raw: string): SyslogTarget | null {
  const m = raw.match(/Target="([^"]+)"\s+Port="(\d+)"\s+Protocol="(udp|tcp)"/);
  if (!m) return null;
  return { host: m[1], port: parseInt(m[2], 10), protocol: m[3] as 'udp' | 'tcp' };
}

// apt-installs + enables/starts rsyslog. Extracted from the /install route so
// a bootstrap/restore orchestrator can call this in-process too.
export async function installSyslog(write: (s: string) => void): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = exec(
      `nsenter -t 1 -m -u -i -p -- bash -c 'DEBIAN_FRONTEND=noninteractive apt install -y rsyslog && systemctl enable rsyslog && systemctl start rsyslog'`
    );
    child.stdout?.on('data', (d: Buffer) => write(d.toString()));
    child.stderr?.on('data', (d: Buffer) => write(d.toString()));
    child.on('close', (code) => {
      const ok = code === 0;
      write(ok ? '\n✅ rsyslog installed and started.\n' : `\n❌ Install failed (exit ${code}).\n`);
      resolve(ok ? { success: true } : { success: false, error: `exit code ${code}` });
    });
  });
}

// Writes the forwarding drop-in, fixes the frr-group/AppArmor prerequisites,
// validates with rsyslogd's own dry-run, then restarts rsyslog. Extracted
// from the /configure route for the same reason as installSyslog() — also
// what a restore orchestrator should call (with the target recovered via
// parseTarget() from the just-restored conf file) instead of a bare
// `systemctl restart rsyslog`, since a fresh host wouldn't have the
// AppArmor/frr-group side effects applied yet even with the file in place.
export async function configureSyslog(target: SyslogTarget): Promise<{ success: boolean; error?: string; target?: SyslogTarget }> {
  const { stdout: whichOut } = await nsenter('which', ['rsyslogd']).catch(() => ({ stdout: '' }));
  if (!whichOut.trim()) {
    return { success: false, error: 'rsyslog is not installed — install it first' };
  }

  const conf = generateRsyslogConf(target);

  const { stdout: groupsOut } = await nsenter('id', ['-nG', 'syslog']).catch(() => ({ stdout: '' }));
  if (!groupsOut.split(/\s+/).includes('frr')) {
    await nsenter('usermod', ['-aG', 'frr', 'syslog']).catch(() => {});
  }

  const apparmorChanged = ensureApparmorOverride([GENIEACS_LOG_HOST_DIR]);
  if (apparmorChanged) {
    await nsenter('apparmor_parser', ['-r', HOST_APPARMOR_PROFILE_REAL_PATH]).catch(() => {});
  }

  if (!fs.existsSync(HOST_RSYSLOG_D)) fs.mkdirSync(HOST_RSYSLOG_D, { recursive: true });
  const tmpHostPath = `${OUR_CONF_HOST_PATH}.tmp`;
  fs.writeFileSync(tmpHostPath, conf, 'utf-8');
  fs.renameSync(tmpHostPath, OUR_CONF_HOST_PATH);

  try {
    await nsenter('rsyslogd', ['-N1', '-f', '/etc/rsyslog.conf']);
  } catch (validateErr: any) {
    fs.unlinkSync(OUR_CONF_HOST_PATH);
    return { success: false, error: `Generated config failed validation — not applied. ${validateErr.stderr || String(validateErr)}` };
  }

  await nsenter('systemctl', ['restart', 'rsyslog']);
  return { success: true, target };
}

export function createSyslogRouter(logger: pino.Logger, auditLogger: IAuditLogger): Router {
  const router = Router();

  // GET /api/syslog/status
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const { stdout: whichOut } = await nsenter('which', ['rsyslogd']).catch(() => ({ stdout: '' }));
      const installed = whichOut.trim().length > 0;

      let running = false;
      if (installed) {
        const { stdout: activeOut } = await nsenter('systemctl', ['is-active', 'rsyslog']).catch(() => ({ stdout: 'inactive' }));
        running = activeOut.trim() === 'active';
      }

      const configured = fs.existsSync(OUR_CONF_HOST_PATH);
      const target = configured ? parseTarget(fs.readFileSync(OUR_CONF_HOST_PATH, 'utf-8')) : null;

      // Sanity-check that /etc/rsyslog.d/*.conf is actually picked up by the main config —
      // true on every stock Debian/Ubuntu rsyslog install, but worth surfacing rather than
      // silently writing a file that never takes effect.
      let includeDirOk = true;
      if (installed && fs.existsSync(HOST_RSYSLOG_CONF)) {
        const mainConf = fs.readFileSync(HOST_RSYSLOG_CONF, 'utf-8');
        includeDirOk = /rsyslog\.d/.test(mainConf);
      }

      // rsyslog runs as the unprivileged "syslog" user — it can only read frr.log (mode
      // 640, owned frr:frr) if that user is in the "frr" group. Fixed automatically by
      // /configure, but surfaced here too in case forwarding was set up before this check
      // existed, or the group fix silently failed.
      let frrGroupOk = true;
      if (installed) {
        const { stdout: groupsOut } = await nsenter('id', ['-nG', 'syslog']).catch(() => ({ stdout: '' }));
        frrGroupOk = groupsOut.split(/\s+/).includes('frr');
      }

      // AppArmor confines rsyslogd to /var/log/** by default (Ubuntu ships this profile) —
      // GenieACS logs live outside that, so they need our local-override block present.
      // Only meaningful once forwarding has actually been configured at least once.
      const apparmorOk = !configured || (
        fs.existsSync(HOST_APPARMOR_LOCAL_PATH) &&
        fs.readFileSync(HOST_APPARMOR_LOCAL_PATH, 'utf-8').includes(APPARMOR_MARKER_START)
      );

      res.json({
        success: true, installed, running, configured, target, includeDirOk, frrGroupOk, apparmorOk,
        logFileCount: OPEN5GS_LOG_FILES.length + GENIEACS_LOG_FILES.length + FRR_LOG_FILES.length,
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'syslog status error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/syslog/install — thin wrapper, see installSyslog() above.
  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.flushHeaders();
    const result = await installSyslog((s) => res.write(s));
    await auditLogger.log({ action: 'syslog_install', user, details: result.error ?? 'ok', success: result.success });
    res.end();
  });

  // POST /api/syslog/configure  { host, port, protocol } — thin wrapper, see
  // configureSyslog() above for the actual logic.
  router.post('/configure', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const { host, port, protocol } = req.body as Partial<SyslogTarget>;
      if (!host || typeof host !== 'string') {
        return res.status(400).json({ success: false, error: 'host is required' });
      }
      const portNum = Number(port);
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        return res.status(400).json({ success: false, error: 'port must be between 1 and 65535' });
      }
      if (protocol !== 'udp' && protocol !== 'tcp') {
        return res.status(400).json({ success: false, error: 'protocol must be "udp" or "tcp"' });
      }

      const result = await configureSyslog({ host, port: portNum, protocol });
      if (!result.success) {
        await auditLogger.log({ action: 'syslog_configure', user, details: result.error || 'unknown error', success: false });
        return res.status(400).json({ success: false, error: result.error });
      }
      await auditLogger.log({
        action: 'syslog_configure', user,
        details: `forwarding to ${host}:${portNum}/${protocol}`,
        success: true,
      });
      res.json({ success: true, target: result.target });
    } catch (err) {
      await auditLogger.log({ action: 'syslog_configure', user, details: String(err), success: false });
      logger.error({ err: String(err) }, 'syslog configure error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/syslog/disable — removes our drop-in config only; leaves rsyslog itself
  // (and any config the user had before we touched anything) untouched.
  router.post('/disable', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      if (fs.existsSync(OUR_CONF_HOST_PATH)) {
        fs.unlinkSync(OUR_CONF_HOST_PATH);
        await nsenter('systemctl', ['restart', 'rsyslog']);
      }
      await auditLogger.log({ action: 'syslog_disable', user, details: 'forwarding disabled', success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'syslog_disable', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  return router;
}
