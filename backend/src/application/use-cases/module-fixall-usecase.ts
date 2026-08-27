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

export type ModuleId = 'ims' | 'mms' | 'vectorcoreSmsc' | 'pstn' | 'vowifi' | 'secgw' | 'twamp';

const MODULE_ORDER: ModuleId[] = ['ims', 'mms', 'vectorcoreSmsc', 'pstn', 'vowifi', 'secgw', 'twamp'];

const MODULE_LABELS: Record<ModuleId, string> = {
  ims: 'IMS / VoLTE',
  mms: 'MMS (VectorCore MMSC)',
  vectorcoreSmsc: 'SMS (VectorCore SMSC)',
  pstn: 'PSTN Gateway',
  vowifi: 'VoWiFi (ePDG)',
  secgw: 'Security Gateway (SecGW)',
  twamp: 'TWAMP',
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
      this.getImsStatus(),
      this.getMmsStatus(),
      this.getVectorcoreSmscStatus(),
      this.getPstnStatus(),
      Promise.resolve(this.getVowifiStatus()),
      Promise.resolve(this.getSecgwStatus()),
      Promise.resolve(this.getTwampStatus()),
    ]);
    const statuses: ModuleStaleStatus[] = [];
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) statuses.push(r.value);
      else if (r.status === 'rejected') this.logger.warn({ err: String(r.reason) }, 'module-fixall: staleness check failed for one module');
    }
    return statuses;
  }

  private async getImsStatus(): Promise<ModuleStaleStatus | null> {
    const s = await getImsStaleness();
    if (!s.installed || (!s.installStale && !s.configStale)) return null;
    return {
      moduleId: 'ims', label: MODULE_LABELS.ims,
      installStale: s.installStale, configStale: s.configStale,
      installedWithVersion: s.installedWithVersion, configuredWithVersion: s.configuredWithVersion,
      canAutoFix: true,
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

      const result = await this.fixModule(moduleId, status).catch((err): FixAllModuleResult => ({
        moduleId, ranInstall: false, ranConfigure: false, skipped: false, error: String(err), log: [],
      }));
      this.runState.results.push(result);

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

  private async fixModule(moduleId: ModuleId, status: ModuleStaleStatus): Promise<FixAllModuleResult> {
    const log: string[] = [];
    const write = (s: string) => { log.push(s); };
    const result: FixAllModuleResult = { moduleId, ranInstall: false, ranConfigure: false, skipped: false, log };

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
          const r = await configurePstn({ asteriskIp: saved?.asteriskIp ?? '' }, this.mongoUri);
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
