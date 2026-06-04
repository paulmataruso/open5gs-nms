import { Router, Request, Response } from 'express';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import pino from 'pino';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { AppConfig } from '../../config';
import { requireAdmin } from './middleware/auth-middleware';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);

const ALL_OPEN5GS_SERVICES = [
  'nrf', 'scp', 'amf', 'smf', 'upf', 'ausf', 'udm', 'udr',
  'pcf', 'nssf', 'bsf', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu',
];

const GENIEACS_SERVICES = ['genieacs-cwmp-access', 'genieacs-nbi-access'];
const GENIEACS_LOG_BASE = '/var/log/genieacs';

// /var/log/open5gs is mounted directly into the container — read it like any local file
const LOG_BASE = '/var/log/open5gs';

// ── Docker log helper — mirrors DockerLogExecutor.getRecentLogs ──────────────
// Uses spawn('docker',...) directly, same as the Unified Logs module.
// Works because /var/run/docker.sock is mounted into the container.
function getDockerLogs(
  containerName: string,
  options: { tail?: number; since?: string; until?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['logs', '--timestamps'];
    if (options.tail  !== undefined) args.push('--tail',  String(options.tail));
    if (options.since !== undefined) args.push('--since', options.since);
    if (options.until !== undefined) args.push('--until', options.until);
    if (!options.tail && !options.since) args.push('--tail', '99999');
    args.push(containerName);

    const proc = spawn('docker', args);
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { out += d.toString(); }); // docker logs mixes to stderr
    proc.on('close', (code) => {
      if (code === 0 || out.trim()) resolve(out);
      else reject(new Error(`docker logs exited ${code}`));
    });
    proc.on('error', reject);
  });
}

export const createLogDownloadRouter = (
  hostExecutor: IHostExecutor,
  appConfig: AppConfig,
  logger: pino.Logger,
): Router => {
  const router = Router();

  // ── Helpers ─────────────────────────────────────────────────────────────────

  const readLog = async (
    logPath: string,
    range: { type: string; lines?: number; from?: string; to?: string },
  ): Promise<string> => {
    try {
      if (range.type === 'lines') {
        // Read last N lines using Node — no shell needed
        const content = await fs.readFile(logPath, 'utf8');
        const lines   = content.split('\n');
        const n       = Math.min(range.lines || 500, 100000);
        return lines.slice(-n).join('\n');
      } else if (range.type === 'date' && range.from && range.to) {
        const content = await fs.readFile(logPath, 'utf8');
        const from    = new Date(range.from);
        const to      = new Date(range.to);
        const fmt     = (d: Date) => {
          const mm  = String(d.getMonth() + 1).padStart(2, '0');
          const dd  = String(d.getDate()).padStart(2, '0');
          const hh  = String(d.getHours()).padStart(2, '0');
          const min = String(d.getMinutes()).padStart(2, '0');
          const ss  = String(d.getSeconds()).padStart(2, '0');
          return `${mm}/${dd} ${hh}:${min}:${ss}`;
        };
        const fromStr = fmt(from);
        const toStr   = fmt(to);
        return content
          .split('\n')
          .filter(line => {
            const ts = line.slice(0, 14);
            return ts >= fromStr && ts <= toStr;
          })
          .join('\n');
      } else {
        // all — just read the whole file
        return await fs.readFile(logPath, 'utf8');
      }
    } catch {
      return ''; // file doesn't exist or isn't readable
    }
  };

  // ── POST /api/logs/download ──────────────────────────────────────────────────
  router.post('/download', requireAdmin, async (req: Request, res: Response) => {
    const {
      services = ALL_OPEN5GS_SERVICES,
      source   = 'open5gs',
      range    = { type: 'lines', lines: 500 },
    } = req.body as {
      services?: string[];
      source?:   'open5gs' | 'docker' | 'genieacs';
      range?:    { type: 'lines' | 'date' | 'all'; lines?: number; from?: string; to?: string };
    };

    const ts     = new Date().toISOString().slice(0, 16).replace('T', '-').replace(/:/g, '');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nms-logs-'));

    try {
      const validServices = source === 'open5gs'
        ? services.filter(s => ALL_OPEN5GS_SERVICES.includes(s))
        : source === 'genieacs'
        ? services.filter(s => GENIEACS_SERVICES.includes(s))
        // Docker source: allowlist container name characters to prevent injection
        // Container names: alphanumeric, hyphens, underscores, dots only
        : services.filter(s => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(s));

      if (validServices.length === 0) {
        res.status(400).json({ error: 'No valid services specified' });
        return;
      }

      const writtenFiles: string[] = [];

      for (const service of validServices) {
        let content = '';

        if (source === 'open5gs') {
          // Direct read — /var/log/open5gs is mounted into the container
          content = await readLog(`${LOG_BASE}/${service}.log`, range);
        } else if (source === 'genieacs') {
          // Direct read — /var/log/genieacs is mounted into the container
          content = await readLog(`${GENIEACS_LOG_BASE}/${service}.log`, range);
        } else {
          // Docker logs — spawn docker directly, same as Unified Logs module
          try {
            if (range.type === 'lines') {
              content = await getDockerLogs(service, { tail: range.lines || 500 });
            } else if (range.type === 'date' && range.from && range.to) {
              content = await getDockerLogs(service, { since: range.from, until: range.to });
            } else {
              content = await getDockerLogs(service, {});
            }
          } catch (dockerErr) {
            logger.warn({ service, err: String(dockerErr) }, 'docker logs failed for service');
            content = '';
          }
        }

        if (content.trim()) {
          await fs.writeFile(path.join(tmpDir, `${service}.log`), content, 'utf8');
          writtenFiles.push(service);
        }
      }

      if (writtenFiles.length === 0) {
        res.status(404).json({ error: 'No log content found for the specified range' });
        return;
      }

      if (writtenFiles.length === 1) {
        const content = await fs.readFile(path.join(tmpDir, `${writtenFiles[0]}.log`), 'utf8');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${writtenFiles[0]}-${ts}.log"`);
        res.send(content);
      } else {
        // Use execFile — no shell, args passed as argv, immune to injection
        const tarPath  = path.join(os.tmpdir(), `open5gs-logs-${ts}.tar.gz`);
        const fileArgs = writtenFiles.map(f => `${f}.log`);
        try {
          await execFileAsync('tar', ['-czf', tarPath, '-C', tmpDir, ...fileArgs]);
        } catch (tarErr) {
          throw new Error(`tar failed: ${tarErr}`);
        }

        const tarBuffer = await fs.readFile(tarPath);
        res.setHeader('Content-Type', 'application/gzip');
        res.setHeader('Content-Disposition', `attachment; filename="open5gs-logs-${ts}.tar.gz"`);
        res.send(tarBuffer);
        await fs.unlink(tarPath).catch(() => {});
      }
    } catch (err) {
      logger.error({ err: String(err) }, 'Log download failed');
      if (!res.headersSent) res.status(500).json({ error: 'Failed to prepare log download' });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ── GET /api/logs/debug-bundle ───────────────────────────────────────────────
  router.get('/debug-bundle', requireAdmin, async (_req: Request, res: Response) => {
    const ts         = new Date().toISOString().slice(0, 16).replace('T', '-').replace(/:/g, '');
    const bundleName = `open5gs-debug-bundle-${ts}`;
    const tmpDir     = path.join(os.tmpdir(), bundleName);

    try {
      await fs.mkdir(path.join(tmpDir, 'open5gs-logs'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'nms-logs'),     { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'configs'),      { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'system'),       { recursive: true });

      // ── 1. Open5GS logs — direct read from mounted /var/log/open5gs ─────────
      logger.info('Debug bundle: collecting Open5GS logs');
      for (const service of ALL_OPEN5GS_SERVICES) {
        const content = await readLog(`${LOG_BASE}/${service}.log`, { type: 'all' });
        if (content) {
          await fs.writeFile(
            path.join(tmpDir, 'open5gs-logs', `${service}.log`),
            content, 'utf8',
          );
        }
      }

      // ── 2. NMS container logs — spawn docker directly (same as Unified Logs) ──
      logger.info('Debug bundle: collecting NMS logs');
      let nmsLogs = '';
      try {
        nmsLogs = await getDockerLogs('open5gs-nms-backend', { tail: 5000 });
      } catch {
        nmsLogs = 'Docker logs unavailable';
      }
      await fs.writeFile(path.join(tmpDir, 'nms-logs', 'nms-backend.log'), nmsLogs, 'utf8');

      // Audit log — mounted via appConfig.logDir
      const auditContent = await fs.readFile(
        path.join(appConfig.logDir, 'audit.json'), 'utf8',
      ).catch(() => '[]');
      await fs.writeFile(path.join(tmpDir, 'nms-logs', 'audit.json'), auditContent, 'utf8');

      // ── 3. Open5GS configs — /etc/open5gs is mounted into the container ──────
      logger.info('Debug bundle: collecting configs');
      for (const svc of ALL_OPEN5GS_SERVICES) {
        const cfgContent = await fs.readFile(
          path.join(appConfig.configPath, `${svc}.yaml`), 'utf8',
        ).catch(() => '');
        if (cfgContent) {
          await fs.writeFile(
            path.join(tmpDir, 'configs', `${svc}.yaml`),
            cfgContent, 'utf8',
          );
        }
      }

      // ── 4. System info — still needs nsenter for host-level info ─────────────
      logger.info('Debug bundle: collecting system info');

      const sysInfo = await hostExecutor.executeCommand('bash', ['-c',
        `echo "=== uname -a ===" && uname -a && echo && echo "=== OS Release ===" && (lsb_release -a 2>/dev/null || cat /etc/os-release) && echo && echo "=== Uptime ===" && uptime && echo && echo "=== Disk Usage ===" && df -h && echo && echo "=== Memory ===" && free -h`,
      ]);
      await fs.writeFile(path.join(tmpDir, 'system', 'os-info.txt'), sysInfo.stdout, 'utf8');

      const ifaceResult = await hostExecutor.executeCommand('bash', ['-c', 'ip addr show 2>/dev/null || true']);
      await fs.writeFile(path.join(tmpDir, 'system', 'interfaces.txt'), ifaceResult.stdout, 'utf8');

      const routeResult = await hostExecutor.executeCommand('bash', ['-c', 'ip route show 2>/dev/null || true']);
      await fs.writeFile(path.join(tmpDir, 'system', 'routes.txt'), routeResult.stdout, 'utf8');

      let statusOutput = '';
      for (const svc of ALL_OPEN5GS_SERVICES) {
        const r = await hostExecutor.executeCommand('bash', ['-c',
          `echo "=== open5gs-${svc}d ===" && systemctl status open5gs-${svc}d 2>&1 | head -20 && echo`,
        ]);
        statusOutput += r.stdout;
      }
      await fs.writeFile(path.join(tmpDir, 'system', 'systemctl-status.txt'), statusOutput, 'utf8');

      const verResult = await hostExecutor.executeCommand('bash', ['-c',
        `dpkg -l 2>/dev/null | grep open5gs | head -10 || open5gs-amfd --version 2>&1 | head -3 || true`,
      ]);
      await fs.writeFile(path.join(tmpDir, 'system', 'open5gs-version.txt'), verResult.stdout, 'utf8');

      const iptResult = await hostExecutor.executeCommand('bash', ['-c',
        `iptables -t nat -L -n -v 2>/dev/null || echo "iptables not available"`,
      ]);
      await fs.writeFile(path.join(tmpDir, 'system', 'iptables-nat.txt'), iptResult.stdout, 'utf8');

      // ── 5. README ────────────────────────────────────────────────────────────
      const readme = [
        'Open5GS NMS Debug Bundle',
        `Generated: ${new Date().toISOString()}`,
        '',
        'Directory Structure:',
        '  open5gs-logs/   - Open5GS network function log files (full)',
        '  nms-logs/       - NMS backend and audit logs',
        '  configs/        - Open5GS NF configuration files',
        '  system/         - OS info, interfaces, routes, service status, iptables',
        '',
        `Services: ${ALL_OPEN5GS_SERVICES.join(', ')}`,
        '',
        'Attach this file to GitHub issues when reporting problems.',
      ].join('\n');
      await fs.writeFile(path.join(tmpDir, 'README.txt'), readme, 'utf8');

      // Use execFile — no shell, args passed as argv, immune to injection
      logger.info('Debug bundle: creating archive');
      const tarPath = path.join(os.tmpdir(), `${bundleName}.tar.gz`);
      try {
        await execFileAsync('tar', ['-czf', tarPath, '-C', os.tmpdir(), bundleName]);
      } catch (tarErr) {
        throw new Error(`tar failed: ${tarErr}`);
      }

      const tarBuffer = await fs.readFile(tarPath);
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${bundleName}.tar.gz"`);
      res.send(tarBuffer);

      logger.info({ file: `${bundleName}.tar.gz`, size: tarBuffer.length }, 'Debug bundle sent');
      await fs.unlink(tarPath).catch(() => {});

    } catch (err) {
      logger.error({ err: String(err) }, 'Debug bundle generation failed');
      if (!res.headersSent) res.status(500).json({ error: 'Failed to generate debug bundle' });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  return router;
};
