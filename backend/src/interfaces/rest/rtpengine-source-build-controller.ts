import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import {
  DEFAULT_RTPENGINE_TAG, RTPENGINE_BUILD_STEPS, RtpengineBuildStep,
  buildRtpengineSourceScript, restoreRtpengineFromSnapshot, verifyRtpengineBuild,
} from '../../application/use-cases/rtpengine-source-build';

// Same overall shape as kamailio-source-build-controller.ts (itself mirroring
// frr-source-build-controller.ts) — see those files for the fuller rationale. Differences
// here: no target-tag input at all (buildRtpengineSourceScript() always builds against
// whatever `apt-get source rtpengine-daemon` currently resolves to on this host — there is
// no git-tag checkout step the way Kamailio's build has one, so DEFAULT_RTPENGINE_TAG is
// purely informational/display, never passed into the build script), and a single service
// to track/verify instead of Kamailio's 4.
const HOST_STATE_FILE  = '/proc/1/root/etc/open5gs-nms/rtpengine-source-build-state.json';
const LOG_FILE         = '/var/log/open5gs-nms/rtpengine-source-build.log'; // already bind-mounted, host-visible
const RUN_SCRIPT_PATH  = '/proc/1/root/opt/rtpengine-build/run.sh';         // written from container, executed on host
const BUILD_WORKDIR    = '/opt/rtpengine-build';                            // real host path, used by the script

export type BuildStatus = 'idle' | RtpengineBuildStep | 'complete' | 'failed' | 'rolled_back';

export interface BuildState {
  status: BuildStatus;
  currentStepLabel: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  // Real host path (not /proc/1/root-prefixed) to the pre-swap snapshot for this run — the
  // only rollback source of truth, same no-apt-fallback design as Kamailio/FRR's own builds.
  snapshotPath: string | null;
}

function loadState(): BuildState {
  try {
    if (fs.existsSync(HOST_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(HOST_STATE_FILE, 'utf-8'));
    }
  } catch {}
  return {
    status: 'idle', currentStepLabel: '',
    startedAt: null, completedAt: null, error: null, snapshotPath: null,
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

async function verifyAndFinish(): Promise<void> {
  const result = await verifyRtpengineBuild();
  const s = loadState();
  s.status = result.active ? 'complete' : 'failed';
  s.currentStepLabel = result.active
    ? `Complete — rtpengine-daemon active, ${result.version ?? 'unknown version'}`
    : `Verification failed — rtpengine-daemon active=${result.active}`;
  s.completedAt = new Date().toISOString();
  if (!result.active) s.error = 'rtpengine-daemon did not report active after install — check the log and consider /rollback';
  saveState(s);
  appendLog(`\n==VERIFY:${JSON.stringify(result)}==\n`);
}

function startBuild(snapshotDir: string, logger: pino.Logger): void {
  const scriptDir = path.dirname(RUN_SCRIPT_PATH);
  fs.mkdirSync(scriptDir, { recursive: true });

  const script = buildRtpengineSourceScript({ snapshotDir });
  fs.writeFileSync(RUN_SCRIPT_PATH, script, { mode: 0o755 });

  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(
    'nsenter',
    ['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'bash', `${BUILD_WORKDIR}/run.sh`],
    { stdio: ['ignore', logFd, logFd], detached: true },
  );
  child.unref();
  fs.closeSync(logFd);

  logger.info({ pid: child.pid }, 'rtpengine source build started (detached)');

  // Poll the log file for step-sentinel / terminal lines and update state accordingly —
  // same shape as kamailio-source-build-controller.ts's own poller. Runs independently of
  // this HTTP request and of the child process handle above.
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
      // Emitted by the script's own EXIT trap on any nonzero exit (e.g. an apt dependency
      // conflict, or the patch-marker check under `set -e`) — without this, a script death
      // mid-build would leave state stuck at its last real step forever, since the process
      // is gone and no further log lines will ever appear.
      if (lastStep === 'script_failed') {
        clearInterval(poll);
        const s = loadState();
        s.status = 'failed';
        s.currentStepLabel = `Build script exited unexpectedly during '${s.status}' — see log`;
        s.completedAt = new Date().toISOString();
        s.error = 'Build script exited with a nonzero status — check the log for the real cause (often an apt/build/patch error) before retrying.';
        saveState(s);
        return;
      }
      if ((RTPENGINE_BUILD_STEPS as readonly string[]).includes(lastStep)) {
        const s = loadState();
        s.status = lastStep as RtpengineBuildStep;
        s.currentStepLabel = lastStep;
        saveState(s);
      }
    }
  }, 3000);
}

async function runRollback(snapshotPath: string | null, logger: pino.Logger): Promise<{ restored: boolean }> {
  if (!snapshotPath) {
    logger.info('rtpengine rollback requested but no snapshot exists — nothing was ever changed, nothing to roll back.');
    return { restored: false };
  }
  appendLog('\n==ROLLBACK:start==\n');
  const result = await restoreRtpengineFromSnapshot(snapshotPath);
  appendLog(`==ROLLBACK:done restored=${result.restored}==\n`);
  logger.info({ snapshotPath, restored: result.restored }, 'rtpengine rollback from snapshot complete');
  return result;
}

// If the backend restarted mid-build, figure out from the log file whether the host-side
// build (a real nsentered host process, keeps running regardless) has actually finished,
// rather than leaving stale "in progress" state forever.
export async function reconcileRtpengineSourceBuildState(logger: pino.Logger): Promise<void> {
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
  } else if (content.includes('==STEP:script_failed==')) {
    state.status = 'failed';
    state.currentStepLabel = 'Build script exited unexpectedly — see log';
    state.completedAt = new Date().toISOString();
    state.error = 'Build script exited with a nonzero status — check the log for the real cause before retrying.';
    saveState(state);
  } else {
    logger.warn('Backend restarted while a rtpengine source build appears to still be in progress on the host — leaving state as-is; check /api/rtpengine/source-build/log');
  }
}

export function createRtpengineSourceBuildRouter(logger: pino.Logger, auditLogger: IAuditLogger): Router {
  const router = Router();

  router.get('/status', (_req: Request, res: Response) => {
    const state = loadState();
    res.json({ ...state, log: tailLog(200), defaultTargetTag: DEFAULT_RTPENGINE_TAG });
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

  router.post('/start', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const current = loadState();
    if (!['idle', 'complete', 'failed', 'rolled_back'].includes(current.status)) {
      return res.status(409).json({ ok: false, error: `A build is already in progress (status: ${current.status})` });
    }

    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const snapshotPath = `/etc/open5gs-nms/rtpengine-source-build-snapshots/${ts}`; // real host path

      const state: BuildState = {
        status: 'preparing', currentStepLabel: 'preparing',
        startedAt: new Date().toISOString(), completedAt: null, error: null,
        snapshotPath,
      };
      saveState(state);
      appendLog(`\n==BUILD:start ts=${state.startedAt}==\n`);

      startBuild(snapshotPath, logger);
      await auditLogger.log({ action: 'rtpengine_source_build_start', user, details: `snapshotPath=${snapshotPath}`, success: true });
      res.json({ ok: true, snapshotPath });
    } catch (err) {
      await auditLogger.log({ action: 'rtpengine_source_build_start', user, details: String(err), success: false });
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
        action: 'rtpengine_source_build_rollback', user,
        details: result.restored ? 'restored from pre-swap snapshot' : 'no snapshot existed — nothing was ever changed',
        success: true,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      await auditLogger.log({ action: 'rtpengine_source_build_rollback', user, details: String(err), success: false });
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.post('/state/reset', requireAdmin, (_req: Request, res: Response) => {
    const state = loadState();
    if (!['complete', 'failed', 'rolled_back'].includes(state.status)) {
      return res.status(409).json({ ok: false, error: `Cannot reset while status is ${state.status}` });
    }
    saveState({
      status: 'idle', currentStepLabel: '',
      startedAt: null, completedAt: null, error: null,
      snapshotPath: state.snapshotPath,
    });
    res.json({ ok: true });
  });

  reconcileRtpengineSourceBuildState(logger).catch(err =>
    logger.error({ err: String(err) }, 'rtpengine source-build state reconciliation failed'));

  return router;
}
