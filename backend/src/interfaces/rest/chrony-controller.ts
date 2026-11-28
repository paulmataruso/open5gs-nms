import { Router, Request, Response } from 'express';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';

const execFileAsync = promisify(execFile);

// All commands run via nsenter to execute on the HOST, not inside the container.
// The container doesn't have chrony installed — the host does.
const nsenter = async (cmd: string, args: string[] = []): Promise<{ stdout: string; stderr: string }> => {
  return execFileAsync('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', cmd, ...args], {
    timeout: 15000,
    encoding: 'utf-8',
    env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/var/run/dbus/system_bus_socket' },
  });
};

// Chrony config lives on the HOST filesystem. Access it via /proc/1/root
// which is the host root from inside the container.
const HOST_CHRONY_CONF = '/proc/1/root/etc/chrony/chrony.conf';

// ─── Types ────────────────────────────────────────────────────────────────────
export interface ChronyServer {
  type: 'server' | 'pool';
  address: string;
  options: string;
}

export interface ChronyConfig {
  servers:      ChronyServer[];
  allowNets:    string[];
  localStratum: number;
  makestep:     string;
  rtcsync:      boolean;
  driftfile:    string;
  logdir:       string;
  /**
   * Directive lines this module does not model, carried through verbatim.
   *
   * serializeConfig() rebuilds chrony.conf from scratch, so anything absent
   * from the fields above used to be deleted by the next save -- measured at
   * 15 real directives, `refclock` among them. On a deployment where chrony
   * serves time to the RAN, silently dropping an operator's GPS/PPS reference
   * clock during an unrelated edit on the Time Server page is not a cosmetic
   * loss. Same reasoning as rawYaml for the core NFs and `relayIps` for Kea:
   * preserve what we do not model rather than rebuild over it.
   *
   * Optional so no client has to know about it -- and the save route reads it
   * from DISK rather than from the request body, because a UI that never
   * displayed these lines cannot be relied on to echo them back.
   */
  preserved?:   string[];
}

export interface ChronyClient {
  hostname: string;
  ntpRequests: number;
  ntpDropped:  number;
  ntpInterval: string;
  ntpLast:     string;
}

export interface ChronySource {
  mode:    string;
  state:   string;
  name:    string;
  stratum: string;
  poll:    string;
  reach:   string;
  lastRx:  string;
  offset:  string;
  error:   string;
}

export interface ChronyTracking {
  refId:           string;
  refSource:       string;
  stratum:         string;
  refTime:         string;
  sysTimeOffset:   string;
  rmsOffset:       string;
  frequency:       string;
  residualFreq:    string;
  skew:            string;
  rootDelay:       string;
  rootDispersion:  string;
  updateInterval:  string;
  leap:            string;
}

// ─── Config parser ────────────────────────────────────────────────────────────

/**
 * Every directive parseConfig() below understands.
 *
 * It is the complement of `preserved`: a keyword here is represented by a
 * typed field and rewritten from it, and anything else is carried through
 * verbatim. Adding a branch to the parser means adding its keyword here too,
 * or the line is both parsed AND preserved and the save emits it twice.
 */
const MODELLED_DIRECTIVES = new Set([
  'server', 'pool', 'allow', 'local', 'makestep', 'rtcsync', 'driftfile', 'logdir',
]);

export function parseConfig(raw: string): ChronyConfig {
  const cfg: ChronyConfig = {
    servers: [], allowNets: [], localStratum: 10,
    makestep: '1.0 3', rtcsync: false,
    driftfile: '/var/lib/chrony/chrony.drift',
    logdir: '/var/log/chrony',
  };
  const preserved: string[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const parts = t.split(/\s+/);
    const kw = parts[0];
    const rest = parts.slice(1);
    if (!MODELLED_DIRECTIVES.has(kw)) {
      // Not understood here, so kept as written. Comments are still dropped:
      // a directive is the functional half, and mapping a comment back to the
      // line it describes is guesswork.
      preserved.push(t);
      continue;
    }
    if (kw === 'server') {
      cfg.servers.push({ type: 'server', address: rest[0], options: rest.slice(1).join(' ') });
    } else if (kw === 'pool') {
      cfg.servers.push({ type: 'pool', address: rest[0], options: rest.slice(1).join(' ') });
    } else if (kw === 'allow') {
      if (rest[0]) cfg.allowNets.push(rest[0]);
    } else if (kw === 'local') {
      // `local stratum 5` splits to ['local','stratum','5'], so the stratum
      // VALUE is the token after the keyword -- not a prefix of it. Matching
      // on startsWith('stratum') found the keyword itself, stripped it to '',
      // and fell through parseInt('') -> NaN -> `|| 10`: every standard
      // `local stratum N` line parsed back as 10 whatever N was. Since 10 is
      // also the default nobody noticed, but the Time Server page has a
      // stratum field, so saving 5 wrote `local stratum 5` correctly and the
      // next read showed 10 again -- the setting silently reverted on the
      // following save. The attached spelling is still accepted as a
      // fallback, because it is what the old code actually handled.
      const at = rest.indexOf('stratum');
      const value = at !== -1
        ? (rest[at + 1] ?? '')
        : (rest.find(r => r.startsWith('stratum'))?.replace('stratum', '') ?? '');
      cfg.localStratum = parseInt(value, 10) || 10;
    } else if (kw === 'makestep') {
      cfg.makestep = rest.join(' ');
    } else if (kw === 'rtcsync') {
      cfg.rtcsync = true;
    } else if (kw === 'driftfile') {
      cfg.driftfile = rest.join(' ');
    } else if (kw === 'logdir') {
      cfg.logdir = rest.join(' ');
    }
  }
  if (preserved.length > 0) cfg.preserved = preserved;
  return cfg;
}

export function serializeConfig(cfg: ChronyConfig): string {
  const lines: string[] = [
    '# /etc/chrony/chrony.conf',
    '# Managed by Open5GS NMS — manual edits will be overwritten on next save',
    '',
    '# Upstream time sources',
  ];
  for (const s of cfg.servers) {
    lines.push(`${s.type} ${s.address}${s.options ? ' ' + s.options : ''}`);
  }
  lines.push('');
  if (cfg.allowNets.length > 0) {
    lines.push('# Allow NTP clients');
    for (const net of cfg.allowNets) lines.push(`allow ${net}`);
    lines.push('');
  }
  lines.push('# Serve time even if upstream sources are temporarily unavailable');
  lines.push(`local stratum ${cfg.localStratum}`);
  lines.push('');
  if (cfg.rtcsync) {
    lines.push('# Keep hardware clock synchronized');
    lines.push('rtcsync');
    lines.push('');
  }
  lines.push('# Correct large offsets at startup');
  lines.push(`makestep ${cfg.makestep}`);
  lines.push('');
  lines.push('# Drift file');
  lines.push(`driftfile ${cfg.driftfile}`);
  lines.push('');
  lines.push('# Log directory');
  lines.push(`logdir ${cfg.logdir}`);
  lines.push('');
  if (cfg.preserved && cfg.preserved.length > 0) {
    lines.push('# Directives this NMS does not manage, preserved from the');
    lines.push('# previous file. Edit them here; they are kept as written.');
    for (const line of cfg.preserved) lines.push(line);
    lines.push('');
  }
  return lines.join('\n');
}

function parseSources(raw: string): ChronySource[] {
  const sources: ChronySource[] = [];
  for (const line of raw.split('\n')) {
    // Real chronyc -n sources output, confirmed live 2026-09-30 (found during a
    // full live-API verification pass): the mode and state characters are packed
    // adjacent with NO whitespace between them (e.g. "^+", "^*"), not
    // space-separated as this regex previously assumed — that mismatch meant this
    // never matched a single real line, so `sources` was always empty even with
    // healthy, actively-syncing upstream servers (confirmed via `tracking`, a
    // separate parser, showing real data while this returned []).
    // e.g.: ^+ 185.125.190.57    2  10  377   212  +2478us[+2478us] +/-   45ms
    // Also fixed two more real bugs found alongside the mode/state one, both
    // confirmed against real chronyc output (8 live upstream sources):
    // (1) "Last sample" is really 3 whitespace-separated tokens (offset, the
    // literal "+/-", and the actual magnitude) — the previous (\S+) for the
    // final group only ever captured the bare "+/-" and silently dropped the
    // magnitude after it, which frontend/src/pages/TimeServerPage.tsx renders
    // directly as its own column. (2) chronyc right-pads the SECOND bracketed
    // offset value with extra internal spaces for column alignment when it has
    // fewer digits than the first (e.g. "+57us[  +57us]") — a bare (\S+) for
    // the offset group splits this into two garbage tokens instead of one
    // value; (\S+\[\s*\S+\]) matches the whole bracketed pair as one field
    // regardless of internal padding.
    const m = line.match(/^([MS\^])([*+\-?x!])\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+\[\s*\S+\])\s+(.+)$/);
    if (!m) continue;
    sources.push({
      mode: m[1], state: m[2], name: m[3],
      stratum: m[4], poll: m[5], reach: m[6],
      lastRx: m[7], offset: m[8], error: m[9].trim(),
    });
  }
  return sources;
}

function parseClients(raw: string): ChronyClient[] {
  const clients: ChronyClient[] = [];
  let pastHeader = false;
  for (const line of raw.split('\n')) {
    if (!pastHeader) {
      if (/^=+$/.test(line.trim())) { pastHeader = true; }
      continue;
    }
    // Format: hostname  ntpReq  ntpDrop  ntpInt  ntpIntL  ntpLast  cmdReq  cmdDrop  cmdInt  cmdLast
    const m = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)/);
    if (!m) continue;
    clients.push({
      hostname:    m[1],
      ntpRequests: parseInt(m[2]),
      ntpDropped:  parseInt(m[3]),
      ntpInterval: m[4],
      ntpLast:     m[6],
    });
  }
  return clients;
}

function parseTracking(raw: string): ChronyTracking {
  const t: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    t[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  // Extract hostname from "Reference ID    : A29FC87A (time.nist.gov)"
  const refId = t['Reference ID'] ?? '';
  const refSourceMatch = refId.match(/\(([^)]+)\)/);
  return {
    refId,
    refSource:       refSourceMatch ? refSourceMatch[1] : refId,
    stratum:         t['Stratum']          ?? '',
    refTime:         t['Ref time (UTC)']   ?? '',
    sysTimeOffset:   t['System time']      ?? '',
    rmsOffset:       t['RMS offset']       ?? '',
    frequency:       t['Frequency']        ?? '',
    residualFreq:    t['Residual freq']    ?? '',
    skew:            t['Skew']             ?? '',
    rootDelay:       t['Root delay']       ?? '',
    rootDispersion:  t['Root dispersion']  ?? '',
    updateInterval:  t['Update interval']  ?? '',
    leap:            t['Leap status']      ?? '',
  };
}

// ─── Router ───────────────────────────────────────────────────────────────────
export function createChronyRouter(logger: pino.Logger, auditLogger: IAuditLogger): Router {
  const router = Router();

  // GET /api/chrony/status
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      // Check installed by looking for chronyc on the host filesystem
      const { stdout: whichOut } = await nsenter('which', ['chronyc']).catch(() => ({ stdout: '' }));
      const installed = whichOut.trim().length > 0;
      if (!installed) {
        return res.json({ success: true, installed: false, active: false, tracking: null, sources: [] });
      }
      const { stdout: activeOut } = await nsenter('systemctl', ['is-active', 'chrony']).catch(() => ({ stdout: 'inactive' }));
      const active = activeOut.trim() === 'active';
      if (!active) {
        return res.json({ success: true, installed: true, active: false, tracking: null, sources: [] });
      }
      const [trackRes, srcRes] = await Promise.allSettled([
        nsenter('chronyc', ['-n', 'tracking']),
        nsenter('chronyc', ['-n', 'sources']),
      ]);
      const tracking = trackRes.status === 'fulfilled' ? parseTracking(trackRes.value.stdout) : null;
      const sources  = srcRes.status  === 'fulfilled' ? parseSources(srcRes.value.stdout)   : [];
      res.json({ success: true, installed, active, tracking, sources });
    } catch (err) {
      logger.error({ err: String(err) }, 'chrony status error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // GET /api/chrony/config
  router.get('/config', async (_req: Request, res: Response) => {
    try {
      if (!fs.existsSync(HOST_CHRONY_CONF)) {
        return res.json({ success: true, raw: '', config: null, exists: false });
      }
      const raw = fs.readFileSync(HOST_CHRONY_CONF, 'utf-8');
      res.json({ success: true, raw, config: parseConfig(raw), exists: true });
    } catch (err) {
      logger.error({ err: String(err) }, 'chrony config read error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // PUT /api/chrony/config
  router.put('/config', requireAdmin, async (req: Request, res: Response) => {
    const user = req.user?.username ?? 'unknown';
    const cfg  = req.body as ChronyConfig;
    try {
      // Unmodelled directives come from the file on disk, never from the
      // request. The Time Server page has no field for them, so a client
      // round-tripping its own view of the config would drop every one.
      const onDisk = fs.existsSync(HOST_CHRONY_CONF)
        ? parseConfig(fs.readFileSync(HOST_CHRONY_CONF, 'utf-8')).preserved
        : undefined;
      const content = serializeConfig({ ...cfg, preserved: onDisk });
      fs.writeFileSync(HOST_CHRONY_CONF, content, 'utf-8');
      await nsenter('systemctl', ['restart', 'chrony']);
      await auditLogger.log({
        action: 'chrony_config_update', user,
        details: `Updated chrony: ${cfg.servers.length} sources, nets: ${cfg.allowNets.join(', ')}`,
        success: true,
      });
      res.json({ success: true, message: 'Chrony config saved and service restarted.' });
    } catch (err) {
      await auditLogger.log({ action: 'chrony_config_update', user, details: String(err), success: false });
      logger.error({ err: String(err) }, 'chrony config write error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/chrony/install — streams output
  router.post('/install', requireAdmin, (req: Request, res: Response) => {
    const user = req.user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.flushHeaders();
    // Run apt install via nsenter so it installs on the host
    const child = exec(
      `nsenter -t 1 -m -u -i -p -- bash -c 'DEBIAN_FRONTEND=noninteractive apt install -y chrony && systemctl start chrony && systemctl enable chrony'`
    );
    child.stdout?.on('data', (d: Buffer) => res.write(d.toString()));
    child.stderr?.on('data', (d: Buffer) => res.write(d.toString()));
    child.on('close', async (code) => {
      const ok = code === 0;
      await auditLogger.log({ action: 'chrony_install', user, details: `exit code ${code}`, success: ok });
      res.write(ok ? '\n✅ Chrony installed and started.\n' : `\n❌ Install failed (exit ${code}).\n`);
      res.end();
    });
  });

  // POST /api/chrony/restart
  router.post('/restart', requireAdmin, async (req: Request, res: Response) => {
    const user = req.user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['restart', 'chrony']);
      await auditLogger.log({ action: 'chrony_restart', user, details: 'chrony restarted', success: true });
      res.json({ success: true, message: 'Chrony restarted.' });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/chrony/start
  router.post('/start', requireAdmin, async (req: Request, res: Response) => {
    const user = req.user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['start', 'chrony']);
      await auditLogger.log({ action: 'chrony_start', user, details: 'chrony started', success: true });
      res.json({ success: true, message: 'Chrony started.' });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // GET /api/chrony/clients
  router.get('/clients', async (_req: Request, res: Response) => {
    try {
      const { stdout } = await nsenter('chronyc', ['clients']).catch(() => ({ stdout: '' }));
      res.json({ success: true, clients: parseClients(stdout) });
    } catch (err) {
      res.json({ success: true, clients: [] });
    }
  });

  // POST /api/chrony/stop
  router.post('/stop', requireAdmin, async (req: Request, res: Response) => {
    const user = req.user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['stop', 'chrony']);
      await auditLogger.log({ action: 'chrony_stop', user, details: 'chrony stopped', success: true });
      res.json({ success: true, message: 'Chrony stopped.' });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  return router;
}
