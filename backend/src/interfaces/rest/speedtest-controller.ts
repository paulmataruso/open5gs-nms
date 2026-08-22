import { Router, Request, Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';

const execFileAsync = promisify(execFile);

// Runs directly inside the backend container, NOT via nsenter — unlike most other
// modules in this project, this doesn't need it. docker-compose.yml mounts the host's
// /var/run/docker.sock into this container and the backend image ships docker-ce-cli
// (see apply-config.ts's findMongoDockerContainer for the same pattern), and the
// backend itself runs with network_mode: host, so `docker` and `ip` here already see
// exactly what the host sees.
const docker = async (args: string[], timeoutMs = 30000): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync('docker', args, { timeout: timeoutMs, encoding: 'utf-8' });

const CONTAINER_NAME = 'open5gs-nms-speedtest';
// Name used by an earlier ad-hoc, manually-started instance of this same idea (before
// it was backed into the NMS) — cleaned up on first Start so it doesn't linger as an
// orphaned, unmanaged duplicate.
const LEGACY_CONTAINER_NAME = 'openspeedtest-temp';
const IMAGE = 'openspeedtest/latest';

// Host filesystem via /proc/1/root — same convention syslog-controller.ts uses for
// host files that aren't explicitly bind-mounted (pid: host + privileged: true in
// docker-compose.yml make the whole host root visible this way, no nsenter needed
// for plain reads/writes).
const STATE_DIR = '/proc/1/root/etc/open5gs-nms';
const STATE_PATH = `${STATE_DIR}/speedtest-state.json`;

interface SpeedtestSettings {
  bindIp: string;
  httpPort: number;
  httpsPort: number;
  enableHttps: boolean;
}

const DEFAULT_SETTINGS: SpeedtestSettings = {
  bindIp: '0.0.0.0',
  httpPort: 9080,
  httpsPort: 9081,
  enableHttps: true,
};

function loadSettings(): SpeedtestSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    return {
      bindIp: typeof raw.bindIp === 'string' ? raw.bindIp : DEFAULT_SETTINGS.bindIp,
      httpPort: Number.isInteger(raw.httpPort) ? raw.httpPort : DEFAULT_SETTINGS.httpPort,
      httpsPort: Number.isInteger(raw.httpsPort) ? raw.httpsPort : DEFAULT_SETTINGS.httpsPort,
      enableHttps: typeof raw.enableHttps === 'boolean' ? raw.enableHttps : DEFAULT_SETTINGS.enableHttps,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: SpeedtestSettings): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(settings, null, 2), 'utf-8');
}

function validatePort(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535`);
  }
  return n;
}

// Deliberately permissive (any dotted-quad, including 0.0.0.0 for "every interface")
// rather than cross-checked against available-ips — an admin may want to bind an
// address this host doesn't have yet (e.g. about to be added), and Docker itself will
// reject the run with a clear error if the address really doesn't exist.
function validateBindIp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    throw new Error('bindIp must be a dotted-quad IPv4 address (e.g. 10.45.0.1 or 0.0.0.0 for all interfaces)');
  }
  return value;
}

async function inspectContainer(name: string): Promise<{ running: boolean; ports: SpeedtestSettings | null }> {
  try {
    const { stdout } = await docker(['inspect', name, '--format', '{{json .State.Running}}\t{{json .NetworkSettings.Ports}}']);
    const [runningRaw, portsRaw] = stdout.trim().split('\t');
    const running = JSON.parse(runningRaw) === true;
    const portsMap = JSON.parse(portsRaw) as Record<string, Array<{ HostIp: string; HostPort: string }> | null>;

    const httpBinding = portsMap['3000/tcp']?.[0];
    const httpsBinding = portsMap['3001/tcp']?.[0];
    if (!httpBinding) return { running, ports: null };

    return {
      running,
      ports: {
        bindIp: httpBinding.HostIp,
        httpPort: parseInt(httpBinding.HostPort, 10),
        httpsPort: httpsBinding ? parseInt(httpsBinding.HostPort, 10) : 0,
        enableHttps: !!httpsBinding,
      },
    };
  } catch {
    // Container doesn't exist — not an error, just "not running".
    return { running: false, ports: null };
  }
}

export function createSpeedtestRouter(logger: pino.Logger, auditLogger: IAuditLogger): Router {
  const router = Router();

  // GET /api/speedtest/status
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const { running, ports } = await inspectContainer(CONTAINER_NAME);
      const settings = ports ?? loadSettings();
      res.json({ success: true, running, settings });
    } catch (err) {
      logger.error({ err: String(err) }, 'speedtest status error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // GET /api/speedtest/available-ips — candidate bind addresses, for the config box's
  // IP picker. Loopback and Docker's own bridge/veth interfaces are filtered out since
  // neither is ever a sensible bind target for something UEs need to reach.
  router.get('/available-ips', async (_req: Request, res: Response) => {
    try {
      const { stdout } = await execFileAsync('ip', ['-4', '-o', 'addr', 'show'], { encoding: 'utf-8' });
      const ips: Array<{ ip: string; iface: string }> = [];
      for (const line of stdout.trim().split('\n')) {
        const m = line.match(/^\d+:\s+(\S+)\s+inet\s+(\d{1,3}(?:\.\d{1,3}){3})\/\d+/);
        if (!m) continue;
        const [, iface, ip] = m;
        if (iface === 'lo' || iface === 'docker0' || iface.startsWith('veth') || iface.startsWith('br-')) continue;
        ips.push({ ip, iface });
      }
      res.json({ success: true, ips });
    } catch (err) {
      logger.error({ err: String(err) }, 'speedtest available-ips error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/speedtest/start  { bindIp, httpPort, httpsPort, enableHttps }
  router.post('/start', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const bindIp = validateBindIp(req.body?.bindIp);
      const httpPort = validatePort(req.body?.httpPort, 'HTTP port');
      const enableHttps = req.body?.enableHttps !== false;
      const httpsPort = enableHttps ? validatePort(req.body?.httpsPort, 'HTTPS port') : 0;
      if (enableHttps && httpPort === httpsPort) {
        throw new Error('HTTP port and HTTPS port must be different');
      }

      // Idempotent: remove any prior instance (ours or the pre-NMS ad-hoc one) before
      // starting fresh, so re-configuring bind IP/ports never fails with "name already
      // in use".
      await docker(['rm', '-f', CONTAINER_NAME]).catch(() => {});
      await docker(['rm', '-f', LEGACY_CONTAINER_NAME]).catch(() => {});

      const runArgs = ['run', '-d', '--name', CONTAINER_NAME, '-p', `${bindIp}:${httpPort}:3000`];
      if (enableHttps) runArgs.push('-p', `${bindIp}:${httpsPort}:3001`);
      runArgs.push(IMAGE);

      await docker(runArgs, 120000);

      const settings: SpeedtestSettings = { bindIp, httpPort, httpsPort, enableHttps };
      saveSettings(settings);
      await auditLogger.log({
        action: 'speedtest_start', user,
        details: `bound to ${bindIp}:${httpPort}${enableHttps ? ` (HTTPS ${httpsPort})` : ''}`,
        success: true,
      });
      res.json({ success: true, running: true, settings });
    } catch (err: any) {
      const message = err?.stderr ? String(err.stderr).trim() : (err?.message || String(err));
      await auditLogger.log({ action: 'speedtest_start', user, details: message, success: false });
      logger.warn({ err: message }, 'speedtest start failed');
      res.status(400).json({ success: false, error: message });
    }
  });

  // POST /api/speedtest/stop
  router.post('/stop', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await docker(['rm', '-f', CONTAINER_NAME]).catch(() => {});
      await auditLogger.log({ action: 'speedtest_stop', user, details: 'stopped', success: true });
      res.json({ success: true, running: false, settings: loadSettings() });
    } catch (err) {
      await auditLogger.log({ action: 'speedtest_stop', user, details: String(err), success: false });
      logger.error({ err: String(err) }, 'speedtest stop error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  return router;
}
