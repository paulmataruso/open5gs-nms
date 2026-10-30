import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import {
  installIms, configureIms, readCurrentImsConfig, getImsStaleness,
} from '../../interfaces/rest/ims-controller';
import {
  installMms, configureMms, readMmsState, getMmsStaleness,
} from '../../interfaces/rest/mms-controller';
import {
  installVectorcoreSmsc, configureVectorcoreSmsc, getVectorcoreSmscStaleness,
} from '../../interfaces/rest/vectorcore-smsc-controller';
import {
  installPstn, configurePstn, readPstnState, getPstnStaleness,
} from '../../interfaces/rest/pstn-controller';
import {
  installTwamp, configureTwampServer, getTwampClientStaleness, getTwampServerStaleness,
} from '../../interfaces/rest/twamp-controller';
import { readTwampState } from './twamp/twamp-runner';
import {
  getKamailioSourceBuildStaleness, startKamailioRebuildForFixAll, loadKamailioBuildState,
} from '../../interfaces/rest/kamailio-source-build-controller';
import {
  installSecgw, configureSecgw, loadState as loadSecgwState, getSecgwStaleness,
} from '../../interfaces/rest/secgw-controller';
import {
  resetAndStartInstall as resetAndStartVowifiInstall, configureVowifi, loadState as loadVowifiState,
  VowifiConfigureError, getVowifiStaleness,
} from '../../interfaces/rest/vowifi-controller';

// ── Centralized "Fix All" stale-module orchestrator ─────────────────────────
//
// Backs the global StaleModulesModal popup (frontend/src/components/common/
// StaleModulesModal.tsx) — this is the single place that both (a) aggregates
// staleness across all 7 optional add-on modules that track it, and (b)
// re-runs whatever Install/Configure steps are needed to clear that
// staleness, without the operator visiting each module's own page. Modeled
// directly on plmn-migration-usecase.ts's PlmnMigrationUseCase: imports
// controller-exported functions straight out of interfaces/rest/*-controller.ts
// rather than looping back over HTTP — same deliberate, already-accepted
// layering shortcut that use-case takes for cross-module orchestration.
//
// The core-17 NF "Apply Config" flow has no staleness concept at all and is
// out of scope here — see CLAUDE.md.

export type ModuleId = 'kamailio' | 'ims' | 'mms' | 'vectorcoreSmsc' | 'pstn' | 'vowifi' | 'secgw' | 'twamp' | 'sasbench';

// `kamailio` runs FIRST, deliberately: its rebuild stops and restarts all four
// Kamailio services and swaps the compiled modules, so anything that configures
// Kamailio afterwards must come after it. In particular IMS Configure is what
// emits `#!define WITH_N5` (it checks isKamailioHttp2Capable() at Configure
// time, not at build time), so running ims after kamailio is also what actually
// re-enables VoNR following a rebuild — the gap verifyAndFinish() currently has
// to tell the operator about in prose.
const MODULE_ORDER: ModuleId[] = ['kamailio', 'ims', 'mms', 'vectorcoreSmsc', 'pstn', 'vowifi', 'secgw', 'twamp', 'sasbench'];

const MODULE_LABELS: Record<ModuleId, string> = {
  ims: 'IMS / VoLTE',
  mms: 'MMS (VectorCore MMSC)',
  vectorcoreSmsc: 'SMS (VectorCore SMSC)',
  pstn: 'PSTN Gateway',
  vowifi: 'VoWiFi (ePDG)',
  secgw: 'Security Gateway (SecGW)',
  twamp: 'TWAMP',
  kamailio: 'Kamailio (IMS core modules)',
  sasbench: 'CBRS SAS (SASBench)',
};

// MMS/VectorCore SMSC/PSTN all hard-require IMS installed+configured (their
// own Install/Configure routes gate on this already — see isImsInstalled()/
// isImsConfigured() in each controller). If IMS's own fix-all step fails,
// attempting these three is a guaranteed cascade failure — skip them with a
// clear reason instead, matching PlmnMigrationTab's "not installed → skipped
// with a note, not an error" convention.
const MODULES_DEPENDENT_ON_IMS: ModuleId[] = ['mms', 'vectorcoreSmsc', 'pstn'];

export interface ModuleStaleStatus {
  moduleId: ModuleId;
  label: string;
  installStale: boolean;
  configStale: boolean;
  installedWithVersion?: string;
  configuredWithVersion?: string | number;
  // False only for MMS's configStale-with-no-saved-mm1PublicIp edge case —
  // every other stale condition across all 7 modules is safely auto-fixable
  // with zero/last-saved input (see plan's automation-safety findings).
  canAutoFix: boolean;
  blockedReason?: string;
  // IMS only, for now: the specific deployed template files whose content
  // differs from this build's, or are missing. A version-string compare is
  // structurally blind to this, so without it a deployment running genuinely
  // out-of-date routing scripts reports nothing to fix. Surfaced per-file so
  // the UI can name them instead of saying "version mismatch".
  staleTemplates?: string[];
  missingTemplates?: string[];
  /**
   * Shell commands the operator runs to clear this themselves, for a module
   * that cannot be auto-fixed. Kept as separate strings rather than folded
   * into `blockedReason` prose so the UI can render them as copyable code
   * instead of a paragraph with commands buried in it.
   */
  fixCommands?: string[];
  /**
   * Overrides the "Install out of date" badge. A module whose software is
   * absent entirely is not out of date, and saying so sends the operator
   * looking for an update that does not apply.
   */
  installBadgeLabel?: string;
}

export interface FixAllModuleResult {
  moduleId: ModuleId;
  ranInstall: boolean;
  ranConfigure: boolean;
  installSuccess?: boolean;
  configureSuccess?: boolean;
  skipped: boolean;
  skipReason?: string;
  error?: string;
  log: string[];
}

export interface FixAllRunState {
  status: 'idle' | 'running' | 'complete' | 'failed';
  startedAt?: string;
  completedAt?: string;
  currentModule?: ModuleId;
  results: FixAllModuleResult[];
}

// VoWiFi's install is a detached background job (see vowifi-controller.ts's
// startInstall/resetAndStartInstall) rather than an awaitable streamed
// function like every other module's installX() — poll its own state file
// the same way the frontend's install/log/stream route already does.
const VOWIFI_INSTALL_POLL_MS = 3000;
const VOWIFI_INSTALL_TIMEOUT_MS = 20 * 60 * 1000; // matches this project's other from-source VectorCore builds
const KAMAILIO_REBUILD_POLL_MS = 5000;
// The real 6.0.8 build measured ~9 minutes on this host; 30 gives genuine
// headroom on a slower one without hanging a Fix All run indefinitely.
const KAMAILIO_REBUILD_TIMEOUT_MS = 30 * 60 * 1000;

export class ModuleFixAllUseCase {
  private runState: FixAllRunState = { status: 'idle', results: [] };

  constructor(
    private readonly subscriberRepo: ISubscriberRepository,
    private readonly hostExecutor: IHostExecutor,
    private readonly mongoUri: string,
    private readonly logger: pino.Logger,
    private readonly auditLogger: IAuditLogger,
  ) {}

  // ── Aggregation ──────────────────────────────────────────────────────────

  async getStaleStatus(): Promise<ModuleStaleStatus[]> {
    const settled = await Promise.allSettled([
      this.getKamailioStatus(),
      this.getImsStatus(),
      this.getMmsStatus(),
      this.getVectorcoreSmscStatus(),
      this.getPstnStatus(),
      Promise.resolve(this.getVowifiStatus()),
      Promise.resolve(this.getSecgwStatus()),
      Promise.resolve(this.getTwampStatus()),
      this.getSasbenchStatus(),
    ]);
    const statuses: ModuleStaleStatus[] = [];
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) statuses.push(r.value);
      else if (r.status === 'rejected') this.logger.warn({ err: String(r.reason) }, 'module-fixall: staleness check failed for one module');
    }
    return statuses;
  }

  private getKamailioStatus(): ModuleStaleStatus | null {
    const s = getKamailioSourceBuildStaleness();
    if (!s.installed || !s.buildStale) return null;
    // Reported as install-stale rather than config-stale: the remedy is a
    // rebuild of the compiled modules, not a config regeneration.
    return {
      moduleId: 'kamailio', label: MODULE_LABELS.kamailio,
      installStale: true, configStale: false,
      installedWithVersion: s.builtWithPatchRev === null
        ? 'patch set unknown (pre-dates tracking)'
        : `patch set rev ${s.builtWithPatchRev}`,
      canAutoFix: true,
    };
  }

  private async getImsStatus(): Promise<ModuleStaleStatus | null> {
    const s = await getImsStaleness();
    // Drifted or missing static templates are a real reason to re-Configure:
    // only a full Configure runs deployImsTemplate(), so nothing else puts the
    // live routing scripts back. Treated as config-stale because that is what
    // drives this orchestrator's Configure step, but reported separately so the
    // UI can say WHICH files drifted rather than just "version mismatch" —
    // version strings are blind to exactly this case (see
    // checkImsTemplateStaleness()).
    const templateDrift = s.staleTemplates.length + s.missingTemplates.length;
    const configStale = s.configStale || templateDrift > 0;
    if (!s.installed || (!s.installStale && !configStale)) return null;
    return {
      moduleId: 'ims', label: MODULE_LABELS.ims,
      installStale: s.installStale, configStale,
      installedWithVersion: s.installedWithVersion, configuredWithVersion: s.configuredWithVersion,
      canAutoFix: true,
      staleTemplates: s.staleTemplates,
      missingTemplates: s.missingTemplates,
    };
  }

  private async getMmsStatus(): Promise<ModuleStaleStatus | null> {
    const s = await getMmsStaleness();
    if (!s.installed || (!s.installStale && !s.configStale)) return null;
    const canAutoFix = !s.configStale || !!s.savedMm1PublicIp;
    return {
      moduleId: 'mms', label: MODULE_LABELS.mms,
      installStale: s.installStale, configStale: s.configStale,
      installedWithVersion: s.installedWithVersion, configuredWithVersion: s.configuredWithVersion,
      canAutoFix,
      blockedReason: canAutoFix ? undefined : 'No saved mm1PublicIp on record — configure MMS manually once from the SMS/MMS page.',
    };
  }

  private async getVectorcoreSmscStatus(): Promise<ModuleStaleStatus | null> {
    const s = await getVectorcoreSmscStaleness();
    if (!s.installed || (!s.installStale && !s.configStale)) return null;
    return {
      moduleId: 'vectorcoreSmsc', label: MODULE_LABELS.vectorcoreSmsc,
      installStale: s.installStale, configStale: s.configStale,
      installedWithVersion: s.installedWithVersion, configuredWithVersion: s.configuredWithVersion,
      canAutoFix: true,
    };
  }

  private async getPstnStatus(): Promise<ModuleStaleStatus | null> {
    const s = await getPstnStaleness();
    if (!s.installed || !s.configStale) return null;
    return {
      moduleId: 'pstn', label: MODULE_LABELS.pstn,
      installStale: false, configStale: s.configStale,
      configuredWithVersion: s.configuredWithVersion,
      canAutoFix: true,
    };
  }

  private getVowifiStatus(): ModuleStaleStatus | null {
    const s = getVowifiStaleness();
    if (!s.installedOnDisk || (!s.buildStale && !s.configStale)) return null;
    return {
      moduleId: 'vowifi', label: MODULE_LABELS.vowifi,
      installStale: s.buildStale, configStale: s.configStale,
      canAutoFix: true,
    };
  }

  private getSecgwStatus(): ModuleStaleStatus | null {
    const s = getSecgwStaleness();
    if (!s.installedOnDisk || (!s.buildStale && !s.configStale)) return null;
    return {
      moduleId: 'secgw', label: MODULE_LABELS.secgw,
      installStale: s.buildStale, configStale: s.configStale,
      configuredWithVersion: s.configuredWithVersion,
      canAutoFix: true,
    };
  }

  private getTwampStatus(): ModuleStaleStatus | null {
    const client = getTwampClientStaleness();
    const server = getTwampServerStaleness();
    if (!client.installed || (!client.installStale && !server.configStale)) return null;
    return {
      moduleId: 'twamp', label: MODULE_LABELS.twamp,
      installStale: client.installStale, configStale: server.configStale,
      installedWithVersion: client.installedWithVersion, configuredWithVersion: server.configuredWithVersion,
      canAutoFix: true,
    };
  }

  /**
   * SASBench builds from a remote git context pinned to a commit by default,
   * so there is nothing on the host that can be missing and nothing to report
   * — `docker compose build` fetches the repository itself. This stays silent
   * in that case, which is every deployment that has not deliberately opted
   * out.
   *
   * It only has something to say when an operator has pointed
   * SASBENCH_CONTEXT at a LOCAL path (building from a working copy while
   * developing SASBench) and that path is missing or is not a checkout —
   * there, the build genuinely cannot run.
   *
   * Still deliberately NOT auto-fixable: the operator chose a local path on
   * purpose, and the NMS silently cloning over it, or silently reverting them
   * to the pinned remote, would both be worse than saying what is wrong.
   */
  private async getSasbenchStatus(): Promise<ModuleStaleStatus | null> {
    // Keep this default in step with docker-compose.yml and config/index.ts.
    const context = process.env.SASBENCH_CONTEXT
      || 'https://github.com/paulmataruso/SASBench.git';
    // A remote context cannot be "missing": BuildKit fetches it per build.
    if (context.includes('://')) return null;

    const dir = context;
    const quoted = JSON.stringify(dir);

    // One host call, so a slow/odd mount cannot cost three round trips.
    // Printing a token per condition rather than relying on exit codes keeps
    // "missing" distinguishable from "present but not a git checkout".
    const probe = await this.hostExecutor.executeCommand(
      'sh',
      ['-c', `if [ ! -d ${quoted} ]; then echo MISSING; elif [ ! -d ${quoted}/.git ]; then echo NOGIT; else echo OK; fi`],
      15000,
      { expectedFailure: true },
    );
    const verdict = (probe.stdout || '').trim().split('\n').pop() || '';

    if (verdict === 'OK') return null;
    // Anything else (including an unreadable path or a failed probe) is not a
    // confident "broken" — say nothing rather than nag about a state we could
    // not establish.
    if (verdict !== 'MISSING' && verdict !== 'NOGIT') return null;

    const missing = verdict === 'MISSING';
    const clone = `sudo git clone https://github.com/paulmataruso/SASBench.git ${dir}`;

    if (missing) {
      return {
        moduleId: 'sasbench', label: MODULE_LABELS.sasbench,
        installStale: true, configStale: false,
        canAutoFix: false,
        installBadgeLabel: 'Not installed',
        blockedReason:
          `SASBENCH_CONTEXT points at ${dir}, which does not exist, so the sasbench image cannot `
          + 'be built and the CBRS SAS is not running — no radio can register, hold a grant or '
          + 'heartbeat. Either clone SASBench there, or remove SASBENCH_CONTEXT from .env to go '
          + 'back to the pinned remote revision this release was tested against, which needs '
          + 'nothing on the host.',
        fixCommands: [
          clone,
          'docker compose build sasbench && docker compose up -d sasbench',
        ],
      };
    }

    return {
      moduleId: 'sasbench', label: MODULE_LABELS.sasbench,
      installStale: true, configStale: false,
      canAutoFix: false,
      installBadgeLabel: 'Not a git checkout',
      blockedReason:
        `SASBENCH_CONTEXT points at ${dir}, which exists but has no git history, so the NMS `
        + 'cannot tell you when SASBench falls behind upstream. The SAS itself still builds and '
        + 'runs from it. Replace it with a real clone, or remove SASBENCH_CONTEXT from .env to '
        + 'use the pinned remote revision and get update tracking back.',
      fixCommands: [clone],
    };
  }

  // ── Fix All orchestration ────────────────────────────────────────────────

  startFixAll(user: string): { started: true } | { started: false; error: string } {
    if (this.runState.status === 'running') {
      return { started: false, error: 'A fix-all run is already in progress.' };
    }
    this.runState = { status: 'running', startedAt: new Date().toISOString(), results: [] };
    this.runFixAll(user).catch(err => {
      this.logger.error({ err: String(err) }, 'module-fixall: unexpected top-level failure');
      this.runState.status = 'failed';
      this.runState.completedAt = new Date().toISOString();
    });
    return { started: true };
  }

  getRunState(): FixAllRunState {
    return this.runState;
  }

  private async runFixAll(user: string): Promise<void> {
    const staleModules = await this.getStaleStatus();
    const staleById = new Map(staleModules.map(m => [m.moduleId, m]));
    let imsFixFailed = false;

    for (const moduleId of MODULE_ORDER) {
      const status = staleById.get(moduleId);
      if (!status) continue;
      this.runState.currentModule = moduleId;

      if (MODULES_DEPENDENT_ON_IMS.includes(moduleId) && imsFixFailed) {
        this.runState.results.push({
          moduleId, ranInstall: false, ranConfigure: false, skipped: true,
          skipReason: 'Blocked — IMS fix failed, fix IMS manually first', log: [],
        });
        continue;
      }

      // Published BEFORE the work starts, not after it finishes.
      //
      // This used to be `const result = await this.fixModule(...)` followed by
      // `results.push(result)`, which meant a module's log array only became
      // reachable once that module had completed. GET /fix-all/status therefore
      // returned nothing for whatever was currently running, so the operator
      // watched an empty box for the entire duration — up to ~9 minutes for the
      // Kamailio rebuild — with no way to tell a working run from a hung one.
      // Pushing the object first lets fixModule's write() append to the very
      // array the status endpoint serialises, so output streams as it happens.
      const result: FixAllModuleResult = {
        moduleId, ranInstall: false, ranConfigure: false, skipped: false, log: [],
      };
      this.runState.results.push(result);
      await this.fixModule(moduleId, status, result).catch((err) => {
        result.error = String(err);
      });

      if (moduleId === 'ims' && (result.installSuccess === false || result.configureSuccess === false)) {
        imsFixFailed = true;
      }
    }

    this.runState.status = 'complete';
    this.runState.completedAt = new Date().toISOString();
    this.runState.currentModule = undefined;

    const allOk = this.runState.results.every(r => r.skipped || (r.installSuccess !== false && r.configureSuccess !== false));
    await this.auditLogger.log({
      action: 'module_fix_all',
      user,
      details: this.runState.results.map(r => `${r.moduleId}:${r.skipped ? 'skipped' : (r.installSuccess !== false && r.configureSuccess !== false ? 'ok' : 'failed')}`).join(' '),
      success: allOk,
    });
  }

  // `result` is created and published into runState by the caller so its `log`
  // array is live while this runs — see runFixAll's comment. Mutated in place.
  private async fixModule(
    moduleId: ModuleId,
    status: ModuleStaleStatus,
    result: FixAllModuleResult,
  ): Promise<FixAllModuleResult> {
    const write = (s: string) => { result.log.push(s); };

    switch (moduleId) {
      case 'ims': {
        if (status.installStale) {
          result.ranInstall = true;
          const r = await installIms(write);
          result.installSuccess = r.success;
          if (!r.success) return result;
        }
        if (status.configStale) {
          const cfg = readCurrentImsConfig();
          if (!cfg) {
            result.skipped = true;
            result.skipReason = 'No saved IMS config on record';
            return result;
          }
          result.ranConfigure = true;
          try {
            await configureIms(cfg);
            result.configureSuccess = true;
          } catch (err) {
            result.configureSuccess = false;
            result.error = String(err);
          }
        }
        return result;
      }

      case 'mms': {
        if (status.installStale) {
          result.ranInstall = true;
          const r = await installMms(write);
          result.installSuccess = r.success;
          result.error = r.error;
          if (!r.success) return result;
        }
        if (status.configStale) {
          const saved = readMmsState();
          if (!saved?.mm1PublicIp) {
            result.skipped = true;
            result.skipReason = 'No saved mm1PublicIp on record';
            return result;
          }
          result.ranConfigure = true;
          const r = await configureMms({ mm1PublicIp: saved.mm1PublicIp }, this.subscriberRepo);
          result.configureSuccess = r.success;
          if (!r.success) result.error = r.error;
        }
        return result;
      }

      case 'vectorcoreSmsc': {
        if (status.installStale) {
          result.ranInstall = true;
          const r = await installVectorcoreSmsc(write);
          result.installSuccess = r.success;
          result.error = r.error;
          if (!r.success) return result;
        }
        if (status.configStale) {
          result.ranConfigure = true;
          const r = await configureVectorcoreSmsc();
          result.configureSuccess = r.success;
          if (!r.success) result.error = r.error;
        }
        return result;
      }

      case 'pstn': {
        if (status.configStale) {
          const saved = readPstnState();
          result.ranConfigure = true;
          const r = await configurePstn({ asteriskIp: saved?.asteriskIp ?? '' }, this.mongoUri, this.subscriberRepo, this.hostExecutor);
          result.configureSuccess = r.success;
          if (!r.success) result.error = r.error;
        }
        return result;
      }

      case 'vowifi': {
        if (status.installStale) {
          result.ranInstall = true;
          const r = await this.runVowifiInstall(write);
          result.installSuccess = r.success;
          result.error = r.error;
          if (!r.success) return result;
        }
        if (status.configStale) {
          const saved = loadVowifiState();
          if (!saved.epdgIp || !saved.aaaListenIp || !saved.epdgInterfaceMode) {
            result.skipped = true;
            result.skipReason = 'No saved VoWiFi config on record';
            return result;
          }
          result.ranConfigure = true;
          try {
            await configureVowifi({
              epdgIp: saved.epdgIp, aaaListenIp: saved.aaaListenIp, interfaceMode: saved.epdgInterfaceMode,
            });
            result.configureSuccess = true;
          } catch (err) {
            result.configureSuccess = false;
            result.error = err instanceof VowifiConfigureError ? err.message : String(err);
          }
        }
        return result;
      }

      case 'secgw': {
        if (status.installStale) {
          result.ranInstall = true;
          const r = await installSecgw(write);
          result.installSuccess = r.success;
          result.error = r.error;
          if (!r.success) return result;
        }
        if (status.configStale) {
          const saved = loadSecgwState();
          result.ranConfigure = true;
          const r = await configureSecgw({
            gatewayIp: saved.gatewayIp ?? '',
            interfaceMode: saved.interfaceMode ?? 'dummy',
            poolCidr: saved.poolCidr ?? '',
          });
          result.configureSuccess = r.success;
          if (!r.success) result.error = r.error;
        }
        return result;
      }

      case 'kamailio': {
        // A real ~9-minute rebuild that stops all four Kamailio services. It is
        // only ever reached when getKamailioStatus() found the deployed build
        // genuinely predates the current patch set, so a current deployment
        // never pays this cost — the module does not even appear in the list.
        result.ranInstall = true;
        const r = await this.runKamailioRebuild(write);
        result.installSuccess = r.success;
        result.error = r.error;
        return result;
      }
      // Never auto-fixed: getSasbenchStatus() reports canAutoFix: false, so
      // this exists to keep the switch exhaustive and to leave a clear reason
      // in the run log if a Fix All reaches it anyway.
      case 'sasbench': {
        result.skipped = true;
        result.skipReason = status.blockedReason
          ?? 'SASBench must be cloned on the host by hand — see the SAS page.';
        return result;
      }

      case 'twamp': {
        if (status.installStale) {
          result.ranInstall = true;
          const r = await installTwamp(write);
          result.installSuccess = r.success;
          result.error = r.error;
          if (!r.success) return result;
        }
        if (status.configStale) {
          const saved = readTwampState();
          result.ranConfigure = true;
          const r = await configureTwampServer({
            listenIp: saved?.server?.listenIp,
            listenPort: saved?.server?.listenPort,
            enableFull: saved?.server?.enableFull,
            enableLight: saved?.server?.enableLight,
            modes: saved?.server?.modes,
            secretKeyId: saved?.server?.secretKeyId,
            secretValue: saved?.server?.secretValue,
            allowCidrs: saved?.server?.allowCidrs,
          }, this.hostExecutor);
          result.configureSuccess = r.success;
          if (!r.success) result.error = r.error;
        }
        return result;
      }
    }
  }

  // VoWiFi's build is a detached background job (see resetAndStartVowifiInstall's
  // own comment) — kick it off, then poll loadVowifiState().installStatus for a
  // terminal state, same pattern the frontend's own /install/log/stream route uses.
  // Same detached-build + poll-to-terminal shape as runVowifiInstall below: the
  // build runs as a host-side script and reports progress only through its own
  // state file, so there is nothing to await directly.
  private async runKamailioRebuild(write: (s: string) => void): Promise<{ success: boolean; error?: string }> {
    const before = getKamailioSourceBuildStaleness();
    write(`Kamailio rebuild started (detached, ~9 minutes) — deployed patch set ` +
          `${before.builtWithPatchRev === null ? 'unknown' : `rev ${before.builtWithPatchRev}`}, ` +
          `expected rev ${before.expectedPatchRev}. All four Kamailio services restart during this.`);
    startKamailioRebuildForFixAll(this.logger);
    const deadline = Date.now() + KAMAILIO_REBUILD_TIMEOUT_MS;
    let lastStep = '';
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, KAMAILIO_REBUILD_POLL_MS));
      const st = loadKamailioBuildState();
      if (st.status !== lastStep) { lastStep = st.status; write(`  kamailio: ${st.currentStepLabel || st.status}`); }
      if (st.status === 'complete') {
        // Verify the rebuild actually recorded the patch set, rather than
        // trusting 'complete' — the whole point of this module is that a build
        // can succeed while missing a patch.
        const after = getKamailioSourceBuildStaleness();
        if (after.buildStale) {
          return { success: false, error: `Build completed but still reports patch set ${after.builtWithPatchRev} (expected ${after.expectedPatchRev})` };
        }
        write('Kamailio rebuild complete — patch set current.');
        return { success: true };
      }
      if (st.status === 'failed' || st.status === 'rolled_back') {
        return { success: false, error: st.error ?? `build ended as ${st.status}` };
      }
    }
    return { success: false, error: `Kamailio rebuild did not complete within ${KAMAILIO_REBUILD_TIMEOUT_MS / 60000} minutes` };
  }

  private async runVowifiInstall(write: (s: string) => void): Promise<{ success: boolean; error?: string }> {
    resetAndStartVowifiInstall(this.logger, 'fix-all');
    write('VoWiFi (VectorCore) install started (detached build)...');
    const deadline = Date.now() + VOWIFI_INSTALL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, VOWIFI_INSTALL_POLL_MS));
      const state = loadVowifiState();
      if (state.installStatus === 'complete') {
        write('VoWiFi (VectorCore) install complete.');
        return { success: true };
      }
      if (state.installStatus === 'failed') {
        write(`VoWiFi (VectorCore) install failed: ${state.installError ?? 'unknown error'}`);
        return { success: false, error: state.installError ?? 'install failed' };
      }
    }
    return { success: false, error: `VoWiFi install did not complete within ${VOWIFI_INSTALL_TIMEOUT_MS / 60000} minutes` };
  }
}
