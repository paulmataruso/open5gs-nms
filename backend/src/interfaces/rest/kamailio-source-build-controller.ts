import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import { nsenter } from '../../infrastructure/network/dummy-interface';
import {
  DEFAULT_KAMAILIO_TAG, KAMAILIO_BUILD_STEPS, KamailioBuildStep, isValidKamailioTag,
  buildKamailioSourceScript, restoreKamailioFromSnapshot, verifyKamailioBuild,
} from '../../application/use-cases/kamailio-source-build';
import { KAMAILIO_PATCH_REV } from '../../application/use-cases/kamailio-ims-modules-build';

// Same overall shape as frr-source-build-controller.ts (this project's own proven pattern
// for a long-running, detached, host-side source build with a snapshot-based rollback) —
// see that file for the fuller rationale. Differences here: no config-restore concept (this
// build never touches /etc/kamailio_{pcscf,scscf,icscf,smsc}/ — those are this project's
// own paths, entirely separate from Kamailio's own default /etc/kamailio/ that `make
// install` would target), and 4 live services to track/verify instead of FRR's 1.
const HOST_STATE_FILE  = '/proc/1/root/etc/open5gs-nms/kamailio-source-build-state.json';
const LOG_FILE         = '/var/log/open5gs-nms/kamailio-source-build.log'; // already bind-mounted, host-visible
const RUN_SCRIPT_PATH  = '/proc/1/root/opt/kamailio-6-build/run.sh';       // written from container, executed on host
const BUILD_WORKDIR    = '/opt/kamailio-6-build';                          // real host path, used by the script

export type BuildStatus = 'idle' | KamailioBuildStep | 'complete' | 'failed' | 'rolled_back';

export interface BuildState {
  status: BuildStatus;
  currentStepLabel: string;
  targetTag: string | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  // Real host path (not /proc/1/root-prefixed) to the pre-swap snapshot for this run — the
  // only rollback source of truth, same no-apt-fallback design as FRR's own build.
  snapshotPath: string | null;
  // Which revision of the C-patch set this build actually carries. Null on any
  // build that predates this field, which is correctly treated as stale — see
  // KAMAILIO_PATCH_REV and getKamailioSourceBuildStaleness().
  builtWithPatchRev?: number | null;
}

function loadState(): BuildState {
  try {
    if (fs.existsSync(HOST_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(HOST_STATE_FILE, 'utf-8'));
    }
  } catch {}
  return {
    status: 'idle', currentStepLabel: '', targetTag: null,
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

// The exact set ims-controller.ts's own basePkgs installs. Kept here as the
// single source of truth for both the hold above and that installer's skip.
export const KAMAILIO_APT_PKGS = [
  'kamailio', 'kamailio-ims-modules', 'kamailio-mysql-modules',
  'kamailio-tls-modules', 'kamailio-extra-modules', 'kamailio-utils-modules',
  'kamailio-presence-modules', 'kamailio-sctp-modules', 'kamailio-json-modules',
];

// True once a 6.0.8 source build has verified all four services active. Read by
// ims-controller.ts so IMS Install stops apt-installing kamailio over it.
export interface KamailioBuildStaleness {
  /** A source build has completed, i.e. this host is on the 6.0.8 build at all. */
  installed: boolean;
  /** The completed build predates the current C-patch set and needs rebuilding. */
  buildStale: boolean;
  builtWithPatchRev: number | null;
  expectedPatchRev: number;
}

/**
 * Whether the deployed Kamailio build carries the current patch set.
 *
 * This exists because the patches and the thing that applies them had drifted
 * apart with nothing to notice: IMS Install deliberately skips its own cdp
 * patch step once a source build is active (patching from apt 5.8.8 source
 * would drop an ABI-incompatible module over the 6.0.8 one), and the 6.0.8
 * pipeline that does own the patches is never re-run automatically. So a build
 * missing a patch stayed missing it indefinitely, and the operator had no way
 * to find out or fix it from the GUI.
 */
export function getKamailioSourceBuildStaleness(): KamailioBuildStaleness {
  const state = loadState();
  const installed = state.status === 'complete';
  const builtWithPatchRev = state.builtWithPatchRev ?? null;
  return {
    installed,
    buildStale: installed && builtWithPatchRev !== KAMAILIO_PATCH_REV,
    builtWithPatchRev,
    expectedPatchRev: KAMAILIO_PATCH_REV,
  };
}

/** Kicks off a rebuild at the last-used tag (or the default) — for Fix All. */
export function startKamailioRebuildForFixAll(logger: pino.Logger): void {
  const prev = loadState();
  const targetTag = prev.targetTag && isValidKamailioTag(prev.targetTag) ? prev.targetTag : DEFAULT_KAMAILIO_TAG;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = `/etc/open5gs-nms/kamailio-source-build-snapshots/${ts}`;
  saveState({
    status: 'preparing', currentStepLabel: 'preparing', targetTag,
    startedAt: new Date().toISOString(), completedAt: null, error: null,
    snapshotPath, builtWithPatchRev: prev.builtWithPatchRev ?? null,
  });
  appendLog(`\n==BUILD:start tag=${targetTag} ts=${new Date().toISOString()} (fix-all)==\n`);
  startBuild(targetTag, snapshotPath, logger);
}

export function loadKamailioBuildState(): BuildState { return loadState(); }

export function isKamailioSourceBuildComplete(): boolean {
  try {
    return JSON.parse(fs.readFileSync(HOST_STATE_FILE, 'utf-8')).status === 'complete';
  } catch {
    return false;
  }
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
  const result = await verifyKamailioBuild();
  const allActive = result.pcscfActive && result.scscfActive && result.icscfActive && result.smscActive;
  const s = loadState();
  s.status = allActive ? 'complete' : 'failed';
  // Real usability gap, found 2026-09-29: the build alone doesn't activate VoNR/
  // cross-RAT calling — pcscfIncludeCfg() only emits #!define WITH_N5 during an
  // actual IMS Configure run (it checks isKamailioHttp2Capable() then, not here),
  // so P-CSCF keeps running with N5 off even immediately after a successful 6.0.8
  // build until IMS Configure is re-run. Surfaced directly in the completion
  // message rather than left for the operator to discover.
  s.currentStepLabel = allActive
    ? `Complete — all 4 services active, ${result.version ?? 'unknown version'}. Re-run IMS Configure now to enable 4G↔5G/5G↔5G VoNR calling (WITH_N5 only activates on the next Configure, not automatically from this build).`
    : `Verification failed — pcscf=${result.pcscfActive} scscf=${result.scscfActive} icscf=${result.icscfActive} smsc=${result.smscActive}`;
  s.completedAt = new Date().toISOString();
  if (!allActive) s.error = 'Not all 4 Kamailio services reported active after install — check the log and consider /rollback';
  // Only stamp the patch revision on a build that actually succeeded: a failed
  // build must stay stale so it keeps being offered as fixable.
  if (allActive) s.builtWithPatchRev = KAMAILIO_PATCH_REV;
  saveState(s);

  // Pin the apt packages so a later `apt upgrade` cannot silently replace this
  // source build. Real defect found in the 2026-10-10 readiness audit: nothing
  // anywhere held or pinned these, and `make install` writes into the
  // dpkg-owned /usr/sbin/kamailio and .../kamailio/modules/, so dpkg still
  // believes 5.8.8 is installed while the binary is 6.0.8. The moment the
  // kamailio58 repo publishes 5.8.9+, a plain apt upgrade downgrades over this
  // build and reverts every patch -- and because pcscf.cfg has WITH_N5 active,
  // 5.8.x has no http_client_request_v2pk(), which is a FATAL config-parse
  // error, so P-CSCF would not start at all.
  //
  // Only held on success: a failed build leaves apt free to repair the install.
  if (allActive) {
    try {
      await nsenter('apt-mark', ['hold', ...KAMAILIO_APT_PKGS]);
      appendLog(`\n==HOLD: apt-mark hold applied to ${KAMAILIO_APT_PKGS.length} kamailio packages so apt cannot downgrade over this source build==\n`);
    } catch (err) {
      appendLog(`\n==HOLD-WARN: apt-mark hold failed (${String(err)}) — apt could still downgrade over this build; run it manually==\n`);
    }
  }
  appendLog(`\n==VERIFY:${JSON.stringify(result)}==\n`);
}

function startBuild(targetTag: string, snapshotDir: string, logger: pino.Logger): void {
  const scriptDir = path.dirname(RUN_SCRIPT_PATH);
  fs.mkdirSync(scriptDir, { recursive: true });

  const script = buildKamailioSourceScript({ targetTag, snapshotDir });
  fs.writeFileSync(RUN_SCRIPT_PATH, script, { mode: 0o755 });

  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(
    'nsenter',
    ['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'bash', `${BUILD_WORKDIR}/run.sh`],
    { stdio: ['ignore', logFd, logFd], detached: true },
  );
  child.unref();
  fs.closeSync(logFd);

  logger.info({ pid: child.pid, targetTag }, 'Kamailio source build started (detached)');

  // Poll the log file for step-sentinel / terminal lines and update state accordingly —
  // same shape as frr-source-build-controller.ts's own poller. Runs independently of this
  // HTTP request and of the child process handle above.
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
      // conflict under `set -e`) — without this, a script death mid-build would leave state
      // stuck at its last real step forever, since the process is gone and no further log
      // lines will ever appear.
      if (lastStep === 'script_failed') {
        clearInterval(poll);
        const s = loadState();
        s.status = 'failed';
        s.currentStepLabel = `Build script exited unexpectedly during '${s.status}' — see log`;
        s.completedAt = new Date().toISOString();
        s.error = 'Build script exited with a nonzero status — check the log for the real cause (often an apt/build error) before retrying.';
        saveState(s);
        return;
      }
      if ((KAMAILIO_BUILD_STEPS as readonly string[]).includes(lastStep)) {
        const s = loadState();
        s.status = lastStep as KamailioBuildStep;
        s.currentStepLabel = lastStep;
        saveState(s);
      }
    }
  }, 3000);
}

async function runRollback(snapshotPath: string | null, logger: pino.Logger): Promise<{ restored: boolean }> {
  if (!snapshotPath) {
    logger.info('Kamailio rollback requested but no snapshot exists — nothing was ever changed, nothing to roll back.');
    return { restored: false };
  }
  appendLog('\n==ROLLBACK:start==\n');
  const result = await restoreKamailioFromSnapshot(snapshotPath);
  appendLog(`==ROLLBACK:done restored=${result.restored}==\n`);
  logger.info({ snapshotPath, restored: result.restored }, 'Kamailio rollback from snapshot complete');
  return result;
}

// If the backend restarted mid-build, figure out from the log file whether the host-side
// build (a real nsentered host process, keeps running regardless) has actually finished,
// rather than leaving stale "in progress" state forever.
export async function reconcileKamailioSourceBuildState(logger: pino.Logger): Promise<void> {
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
    logger.warn('Backend restarted while a Kamailio source build appears to still be in progress on the host — leaving state as-is; check /api/kamailio/source-build/log');
  }
}

export function createKamailioSourceBuildRouter(logger: pino.Logger, auditLogger: IAuditLogger): Router {
  const router = Router();

  router.get('/status', (_req: Request, res: Response) => {
    const state = loadState();
    res.json({ ...state, log: tailLog(200), defaultTargetTag: DEFAULT_KAMAILIO_TAG });
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
    const targetTag = (req.body?.targetTag && String(req.body.targetTag).trim()) || DEFAULT_KAMAILIO_TAG;
    if (!isValidKamailioTag(targetTag)) {
      return res.status(400).json({ ok: false, error: 'Invalid target tag — use a plain git tag name (letters, numbers, dots, dashes, underscores only)' });
    }
    const current = loadState();
    if (!['idle', 'complete', 'failed', 'rolled_back'].includes(current.status)) {
      return res.status(409).json({ ok: false, error: `A build is already in progress (status: ${current.status})` });
    }

    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const snapshotPath = `/etc/open5gs-nms/kamailio-source-build-snapshots/${ts}`; // real host path

      const state: BuildState = {
        status: 'preparing', currentStepLabel: 'preparing', targetTag,
        startedAt: new Date().toISOString(), completedAt: null, error: null,
        snapshotPath,
      };
      saveState(state);
      appendLog(`\n==BUILD:start tag=${targetTag} ts=${state.startedAt}==\n`);

      startBuild(targetTag, snapshotPath, logger);
      await auditLogger.log({ action: 'kamailio_source_build_start', user, details: `tag=${targetTag}`, success: true });
      res.json({ ok: true, targetTag, snapshotPath });
    } catch (err) {
      await auditLogger.log({ action: 'kamailio_source_build_start', user, details: String(err), success: false });
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
        action: 'kamailio_source_build_rollback', user,
        details: result.restored ? 'restored from pre-swap snapshot' : 'no snapshot existed — nothing was ever changed',
        success: true,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      await auditLogger.log({ action: 'kamailio_source_build_rollback', user, details: String(err), success: false });
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
      snapshotPath: state.snapshotPath,
    });
    res.json({ ok: true });
  });

  reconcileKamailioSourceBuildState(logger).catch(err =>
    logger.error({ err: String(err) }, 'Kamailio source-build state reconciliation failed'));

  return router;
}
