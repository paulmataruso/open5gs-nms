import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import {
  nsenter, DEFAULT_FRR_TAG, FRR_BUILD_STEPS, FrrBuildStep, isValidFrrTag,
  buildFrrSourceScript, restoreFrrFromSnapshot, verifyFrr,
} from '../../application/use-cases/frr-source-build';

// ─── Host paths ─────────────────────────────────────────────────────────────
const HOST_STATE_FILE    = '/proc/1/root/etc/open5gs-nms/frr-source-build-state.json';
const HOST_BACKUP_ROOT   = '/proc/1/root/etc/open5gs-nms/frr-source-build-backup';
const HOST_FRR_CONF      = '/proc/1/root/etc/frr/frr.conf';
const HOST_DAEMONS       = '/proc/1/root/etc/frr/daemons';
const HOST_VTYSH_CONF    = '/proc/1/root/etc/frr/vtysh.conf';
const LOG_FILE           = '/var/log/open5gs-nms/frr-source-build.log'; // already bind-mounted, host-visible
const RUN_SCRIPT_PATH    = '/proc/1/root/opt/frr-build/run.sh';         // written from container, executed on host
const BUILD_WORKDIR      = '/opt/frr-build';                            // real host path, used by the script

// ─── State ──────────────────────────────────────────────────────────────────
export type BuildStatus = 'idle' | FrrBuildStep | 'complete' | 'failed' | 'rolled_back';

export interface BuildState {
  status: BuildStatus;
  currentStepLabel: string;
  targetTag: string | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  backupPath: string | null;
  // Real host path (not /proc/1/root-prefixed) to the pre-swap snapshot for this run —
  // the only rollback source of truth now; no apt fallback.
  snapshotPath: string | null;
}

function loadState(): BuildState {
  try {
    if (fs.existsSync(HOST_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(HOST_STATE_FILE, 'utf-8'));
    }
  } catch {}
  return {
    status: 'idle', currentStepLabel: '', targetTag: null,
    startedAt: null, completedAt: null, error: null, backupPath: null, snapshotPath: null,
  };
}

function saveState(state: BuildState): void {
  const dir = path.dirname(HOST_STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(HOST_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function appendLog(msg: string): void {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(LOG_FILE, msg.endsWith('\n') ? msg : msg + '\n', 'utf-8');
}

function tailLog(maxLines: number): string {
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    const lines = content.split('\n');
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

// ─── Backup (safe, standalone, callable any time) ──────────────────────────
// This preserves the user's *live* config across a reinstall — separate from the
// pre-swap binary snapshot taken automatically during every build's "swapping" step.
async function runBackup(logger: pino.Logger): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = `${HOST_BACKUP_ROOT}/${ts}`;
  fs.mkdirSync(dir, { recursive: true });

  for (const [src, name] of [
    [HOST_FRR_CONF, 'frr.conf'],
    [HOST_DAEMONS, 'daemons'],
    [HOST_VTYSH_CONF, 'vtysh.conf'],
  ] as const) {
    if (fs.existsSync(src)) fs.copyFileSync(src, `${dir}/${name}`);
  }

  let pkgVersion = 'unknown';
  let enabled = 'unknown';
  try {
    const { stdout } = await nsenter('dpkg-query', ['-W', '-f=${Version}', 'frr']);
    pkgVersion = stdout.trim() || 'unknown';
  } catch {}
  try {
    const { stdout } = await nsenter('systemctl', ['is-enabled', 'frr']);
    enabled = stdout.trim() || 'unknown';
  } catch {}

  const manifest = { timestamp: ts, packageVersion: pkgVersion, serviceEnabled: enabled };
  fs.writeFileSync(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2), 'utf-8');
  logger.info({ dir }, 'FRR config backed up');
  return `/etc/open5gs-nms/frr-source-build-backup/${ts}`;
}

async function verifyAndFinish(): Promise<void> {
  const { active, neighborUp } = await verifyFrr();
  const s = loadState();
  s.status = active ? 'complete' : 'failed';
  s.currentStepLabel = active
    ? (neighborUp ? 'Complete — EIGRP neighbor up' : 'Complete — service active, neighbor not yet confirmed')
    : 'Verification failed — service not active';
  s.completedAt = new Date().toISOString();
  if (!active) s.error = 'systemctl is-active frr did not report active after install';
  saveState(s);
  appendLog(`\n==VERIFY:active=${active} neighborUp=${neighborUp}==\n`);
}

function startBuild(targetTag: string, restoreConfigFrom: string | undefined, snapshotDir: string, logger: pino.Logger): void {
  const scriptDir = path.dirname(RUN_SCRIPT_PATH);
  fs.mkdirSync(scriptDir, { recursive: true });
  const script = buildFrrSourceScript({
    targetTag, restoreConfigFrom, snapshotDir,
    // Restoring a previous config already carries forward whatever protocol daemon was
    // enabled — only need to guarantee these two, which mgmtd (mandatory as of FRR 9.0+)
    // and zebra (always required) predate on older, pre-restore daemons files.
    daemonOverrides: { mgmtd: true, zebra: true },
  });
  fs.writeFileSync(RUN_SCRIPT_PATH, script, { mode: 0o755 });

  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(
    'nsenter',
    ['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'bash', `${BUILD_WORKDIR}/run.sh`],
    { stdio: ['ignore', logFd, logFd], detached: true },
  );
  child.unref();
  fs.closeSync(logFd);

  logger.info({ pid: child.pid, targetTag }, 'FRR source build started (detached)');

  // Poll the log file for step-sentinel / terminal lines and update state accordingly.
  // Runs independently of this HTTP request and of the child process handle above.
  const poll = setInterval(() => {
    const state = loadState();
    if (state.status === 'complete' || state.status === 'failed' || state.status === 'rolled_back') {
      clearInterval(poll);
      return;
    }
    let content = '';
    try { content = fs.readFileSync(LOG_FILE, 'utf-8'); } catch { return; }

    const stepMatches = [...content.matchAll(/==STEP:([a-z_]+)==/g)];
    if (stepMatches.length > 0) {
      const lastStep = stepMatches[stepMatches.length - 1][1];
      if (lastStep === 'done') {
        clearInterval(poll);
        verifyAndFinish().catch(err => {
          const s = loadState();
          s.status = 'failed';
          s.currentStepLabel = 'Verification error';
          s.completedAt = new Date().toISOString();
          s.error = String(err);
          saveState(s);
        });
        return;
      }
      if ((FRR_BUILD_STEPS as readonly string[]).includes(lastStep)) {
        const s = loadState();
        s.status = lastStep as FrrBuildStep;
        s.currentStepLabel = lastStep;
        saveState(s);
      }
    }
  }, 3000);
}

// ─── Rollback ───────────────────────────────────────────────────────────────
// No apt fallback — restores the pre-swap binary+config snapshot taken automatically at
// the start of the "swapping" step of the most recent build attempt.
async function runRollback(snapshotPath: string | null, logger: pino.Logger): Promise<{ restored: boolean }> {
  if (!snapshotPath) {
    logger.info('Rollback requested but no snapshot exists — nothing was ever changed, nothing to roll back.');
    return { restored: false };
  }
  appendLog('\n==ROLLBACK:start==\n');
  // snapshotPath is already a real host path (not /proc/1/root-prefixed) — restoreFrrFromSnapshot
  // operates via nsenter on the actual host filesystem, same as the build script itself.
  const result = await restoreFrrFromSnapshot(snapshotPath);
  appendLog(`==ROLLBACK:done restored=${result.restored}==\n`);
  logger.info({ snapshotPath, restored: result.restored }, 'FRR rollback from snapshot complete');
  return result;
}

// ─── Startup reconciliation ─────────────────────────────────────────────────
// If the backend restarted mid-build, figure out from the log file whether the host-side
// build (which keeps running regardless — it's a real nsentered host process) has actually
// finished, rather than leaving stale "in progress" state forever.
export async function reconcileFrrSourceBuildState(logger: pino.Logger): Promise<void> {
  const state = loadState();
  const terminal: BuildStatus[] = ['idle', 'complete', 'failed', 'rolled_back'];
  if (terminal.includes(state.status)) return;

  let content = '';
  try { content = fs.readFileSync(LOG_FILE, 'utf-8'); } catch {
    state.status = 'failed';
    state.error = 'Backend restarted and no build log was found — state unknown';
    saveState(state);
    return;
  }
  if (content.includes('==STEP:done==')) {
    await verifyAndFinish();
  } else {
    logger.warn('Backend restarted while an FRR source build appears to still be in progress on the host — leaving state as-is; check /api/frr/source-build/log');
  }
}

// ─── Router ─────────────────────────────────────────────────────────────────
export function createFrrSourceBuildRouter(logger: pino.Logger, auditLogger: IAuditLogger): Router {
  const router = Router();

  router.get('/status', (_req: Request, res: Response) => {
    const state = loadState();
    res.json({ ...state, log: tailLog(200), defaultTargetTag: DEFAULT_FRR_TAG });
  });

  router.get('/log', (_req: Request, res: Response) => {
    res.type('text/plain').send(tailLog(100000));
  });

  router.get('/log/stream', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(tailLog(200));

    if (!fs.existsSync(LOG_FILE)) fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '');
    const tail = spawn('tail', ['-f', '-n', '0', LOG_FILE]);
    tail.stdout.on('data', (d: Buffer) => res.write(d));
    tail.stderr.on('data', () => {});
    const cleanup = () => { tail.kill(); };
    _req.on('close', cleanup);
    tail.on('close', () => res.end());
  });

  router.post('/backup', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const backupPath = await runBackup(logger);
      const state = loadState();
      state.backupPath = backupPath;
      saveState(state);
      await auditLogger.log({ action: 'frr_source_build_backup', user, details: backupPath, success: true });
      res.json({ ok: true, backupPath });
    } catch (err) {
      await auditLogger.log({ action: 'frr_source_build_backup', user, details: String(err), success: false });
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.post('/start', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const targetTag = (req.body?.targetTag && String(req.body.targetTag).trim()) || DEFAULT_FRR_TAG;
    if (!isValidFrrTag(targetTag)) {
      return res.status(400).json({ ok: false, error: 'Invalid target tag — use a plain git tag name (letters, numbers, dots, dashes, underscores only)' });
    }
    const current = loadState();
    if (!['idle', 'complete', 'failed', 'rolled_back'].includes(current.status)) {
      return res.status(409).json({ ok: false, error: `A build is already in progress (status: ${current.status})` });
    }

    try {
      let backupPath = current.backupPath;
      if (!backupPath || !fs.existsSync(`/proc/1/root${backupPath}`)) {
        backupPath = await runBackup(logger);
      }
      const restoreConfigFrom = backupPath; // real host path — the script runs via nsenter on the actual host

      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const snapshotPath = `/etc/open5gs-nms/frr-source-build-snapshots/${ts}`; // real host path

      const state: BuildState = {
        status: 'preparing', currentStepLabel: 'preparing', targetTag,
        startedAt: new Date().toISOString(), completedAt: null, error: null,
        backupPath, snapshotPath,
      };
      saveState(state);
      appendLog(`\n==BUILD:start tag=${targetTag} ts=${state.startedAt}==\n`);

      startBuild(targetTag, restoreConfigFrom, snapshotPath, logger);
      await auditLogger.log({ action: 'frr_source_build_start', user, details: `tag=${targetTag}`, success: true });
      res.json({ ok: true, targetTag, backupPath });
    } catch (err) {
      await auditLogger.log({ action: 'frr_source_build_start', user, details: String(err), success: false });
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.post('/rollback', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const state = loadState();
      const result = await runRollback(state.snapshotPath, logger);
      state.status = 'rolled_back';
      state.completedAt = new Date().toISOString();
      saveState(state);
      await auditLogger.log({
        action: 'frr_source_build_rollback', user,
        details: result.restored ? 'restored from pre-swap snapshot' : 'no snapshot existed — nothing was ever changed',
        success: true,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      await auditLogger.log({ action: 'frr_source_build_rollback', user, details: String(err), success: false });
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.post('/state/reset', requireAdmin, (_req: Request, res: Response) => {
    const state = loadState();
    if (!['complete', 'failed', 'rolled_back'].includes(state.status)) {
      return res.status(409).json({ ok: false, error: `Cannot reset while status is ${state.status}` });
    }
    saveState({
      status: 'idle', currentStepLabel: '', targetTag: null,
      startedAt: null, completedAt: null, error: null,
      backupPath: state.backupPath, snapshotPath: state.snapshotPath,
    });
    res.json({ ok: true });
  });

  reconcileFrrSourceBuildState(logger).catch(err =>
    logger.error({ err: String(err) }, 'FRR source-build state reconciliation failed'));

  return router;
}
