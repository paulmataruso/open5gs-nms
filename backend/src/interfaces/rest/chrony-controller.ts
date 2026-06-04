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
function parseConfig(raw: string): ChronyConfig {
  const cfg: ChronyConfig = {
    servers: [], allowNets: [], localStratum: 10,
    makestep: '1.0 3', rtcsync: false,
    driftfile: '/var/lib/chrony/chrony.drift',
    logdir: '/var/log/chrony',
  };
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const parts = t.split(/\s+/);
    const kw = parts[0];
    const rest = parts.slice(1);
    if (kw === 'server') {
      cfg.servers.push({ type: 'server', address: rest[0], options: rest.slice(1).join(' ') });
    } else if (kw === 'pool') {
      cfg.servers.push({ type: 'pool', address: rest[0], options: rest.slice(1).join(' ') });
    } else if (kw === 'allow') {
      if (rest[0]) cfg.allowNets.push(rest[0]);
    } else if (kw === 'local') {
      const stratumPart = rest.find(r => r.startsWith('stratum'));
      cfg.localStratum = stratumPart ? parseInt(stratumPart.replace('stratum', '')) || 10 : 10;
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
  return cfg;
}

function serializeConfig(cfg: ChronyConfig): string {
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
  return lines.join('\n');
}

function parseSources(raw: string): ChronySource[] {
  const sources: ChronySource[] = [];
  for (const line of raw.split('\n')) {
    // e.g.: MS 162.159.200.123  2   6  377    23  +1234us[+5678us] +/-  890us
    const m = line.match(/^([MS\^])\s+([*+\-?x!])\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/);
    if (!m) continue;
    sources.push({
      mode: m[1], state: m[2], name: m[3],
      stratum: m[4], poll: m[5], reach: m[6],
      lastRx: m[7], offset: m[8], error: m[9],
    });
  }
  return sources;
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
    const user = (req as any).user?.username ?? 'unknown';
    const cfg  = req.body as ChronyConfig;
    try {
      const content = serializeConfig(cfg);
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
  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
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
    const user = (req as any).user?.username ?? 'unknown';
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
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['start', 'chrony']);
      await auditLogger.log({ action: 'chrony_start', user, details: 'chrony started', success: true });
      res.json({ success: true, message: 'Chrony started.' });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/chrony/stop
  router.post('/stop', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
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
