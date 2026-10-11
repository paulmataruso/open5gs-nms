import * as fs from 'fs';
import pino from 'pino';
import { BackupRestoreUseCase, BackupCategory } from './backup-restore';
import { FreshHostBootstrapUseCase, FreshHostBootstrapRunState } from './fresh-host-bootstrap-usecase';
import { BackupRestartUseCase, BackupRestartRunState } from './backup-restart-usecase';

// ── Full Restore orchestrator: bootstrap (optional) -> restore -> restart ──
//
// Sequences the 3 independent pieces built for the 2026-09-22 backup module
// review into the one operator-facing action ("Restore"): if this is a
// fresh host, install every optional module the backup's manifest says was
// in use (FreshHostBootstrapUseCase) BEFORE writing any config, so the
// restored state files land on top of something real; then the actual file/
// Mongo restore (BackupRestoreUseCase, unchanged); then reapply/restart
// everything the restored categories touched (BackupRestartUseCase). Each
// phase is itself a fire-and-forget async job (same shape as this one) —
// this orchestrator polls each one's own getRunState() until terminal
// in-process, no HTTP involved, before moving to the next phase.

export interface FullRestoreOrchestratorState {
  status: 'idle' | 'running' | 'complete' | 'failed';
  phase?: 'bootstrap' | 'restoring' | 'restart';
  startedAt?: string;
  completedAt?: string;
  bootstrap?: FreshHostBootstrapRunState;
  restoredCategories?: BackupCategory[];
  restoreError?: string;
  restart?: BackupRestartRunState;
}

const POLL_MS = 2000;

// A restore that includes the `auth` category ends with this backend
// container restarting itself (see backup-restart-usecase.ts's own comment
// on why) — which wipes this class's in-memory runState the instant the
// process exits. Real, 2026-09-22 live-VM finding: without persisting
// somewhere first, a caller polling right after an auth-included restore
// saw a fresh 'idle' orchestrator and had no way to know the restore had
// actually succeeded. /tmp survives this specific kind of restart (Docker's
// `restart: unless-stopped` re-execs the SAME container/filesystem after a
// process exit — this is not a `docker compose up` recreate, which would
// wipe it) — not durable across a real container recreate, which is fine,
// this is only ever meant to bridge the ~2s gap of its own self-restart.
const PERSIST_PATH = '/tmp/full-restore-last-run.json';

export class FullRestoreOrchestratorUseCase {
  private runState: FullRestoreOrchestratorState = { status: 'idle' };

  constructor(
    private readonly bootstrapUseCase: FreshHostBootstrapUseCase,
    private readonly backupRestoreUseCase: BackupRestoreUseCase,
    private readonly restartUseCase: BackupRestartUseCase,
    private readonly logger: pino.Logger,
  ) {
    try {
      if (fs.existsSync(PERSIST_PATH)) {
        this.runState = JSON.parse(fs.readFileSync(PERSIST_PATH, 'utf-8'));
      }
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'full-restore-orchestrator: failed to load persisted run state, starting idle');
    }
  }

  startFullRestore(
    archivePath: string,
    categories: BackupCategory[],
    presentModules: string[],
    freshHostBootstrap: boolean,
    user: string,
  ): { started: true } | { started: false; error: string } {
    if (this.runState.status === 'running') {
      return { started: false, error: 'A restore is already in progress.' };
    }
    this.runState = { status: 'running', startedAt: new Date().toISOString() };
    this.run(archivePath, categories, presentModules, freshHostBootstrap, user).catch(err => {
      this.logger.error({ err: String(err) }, 'full-restore-orchestrator: unexpected top-level failure');
      this.runState.status = 'failed';
      this.runState.completedAt = new Date().toISOString();
    });
    return { started: true };
  }

  getRunState(): FullRestoreOrchestratorState {
    return this.runState;
  }

  private async run(
    archivePath: string,
    categories: BackupCategory[],
    presentModules: string[],
    freshHostBootstrap: boolean,
    user: string,
  ): Promise<void> {
    if (freshHostBootstrap && presentModules.length > 0) {
      this.runState.phase = 'bootstrap';
      const started = this.bootstrapUseCase.startBootstrap(presentModules, user);
      if (started.started) {
        await this.pollUntilTerminal(() => this.bootstrapUseCase.getRunState(), (s) => { this.runState.bootstrap = s; });
      }
      // Deliberately continue into the restore even if one module's install
      // failed — a partial install failure (e.g. one source build) doesn't
      // mean the rest of the restore is meaningless; the per-module failure
      // is visible in this.runState.bootstrap.results for the operator to
      // see and fix that one module's Install manually afterward.
    }

    this.runState.phase = 'restoring';
    const restoreResult = await this.backupRestoreUseCase.restoreFullBackup(archivePath, categories);
    if (!restoreResult.success) {
      this.runState.status = 'failed';
      this.runState.restoreError = restoreResult.error;
      this.runState.completedAt = new Date().toISOString();
      return;
    }
    this.runState.restoredCategories = restoreResult.restored;

    this.runState.phase = 'restart';
    const restarted = this.restartUseCase.startRestart(restoreResult.restored ?? categories, user);
    if (restarted.started) {
      await this.pollUntilTerminal(() => this.restartUseCase.getRunState(), (s) => { this.runState.restart = s; });
    }

    this.runState.status = 'complete';
    this.runState.completedAt = new Date().toISOString();

    // See PERSIST_PATH's own comment — the auth category's self-restart
    // fires here, now that this orchestrator's FULL combined state
    // (bootstrap + restore + restart results, not just the restart
    // sub-state) is finished and about to be persisted, so a caller's next
    // poll — even one landing after the process has already restarted —
    // still sees the real, complete result instead of a fresh 'idle'.
    if (this.runState.restoredCategories?.includes('auth')) {
      try {
        fs.writeFileSync(PERSIST_PATH, JSON.stringify(this.runState), 'utf-8');
      } catch (err) {
        this.logger.warn({ err: String(err) }, 'full-restore-orchestrator: failed to persist run state before self-restart');
      }
      setTimeout(() => process.exit(0), 2000);
    }
  }

  private async pollUntilTerminal<T extends { status: string }>(getState: () => T, onUpdate: (s: T) => void): Promise<void> {
    for (;;) {
      const s = getState();
      onUpdate(s);
      if (s.status === 'complete' || s.status === 'failed') return;
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
  }
}
