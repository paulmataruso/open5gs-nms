import { spawn } from 'child_process';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { installIms } from '../../interfaces/rest/ims-controller';
import { installGsm } from '../../interfaces/rest/gsm-controller';
import { installAsterisk2g } from '../../interfaces/rest/asterisk-2g-controller';
import { installHnbgw } from '../../interfaces/rest/hnbgw-controller';
import { resetAndStartInstall as resetAndStartVowifiInstall, loadState as loadVowifiState } from '../../interfaces/rest/vowifi-controller';
import { installSecgw } from '../../interfaces/rest/secgw-controller';
import { installOcs } from '../../interfaces/rest/ocs-controller';
import { installMms } from '../../interfaces/rest/mms-controller';
import { installPstn } from '../../interfaces/rest/pstn-controller';
import { installVectorcoreSmsc } from '../../interfaces/rest/vectorcore-smsc-controller';
import { installTwamp } from '../../interfaces/rest/twamp-controller';
import { installSyslog } from '../../interfaces/rest/syslog-controller';
import { checkBindHealth, fixResolver, installDnsBootGate } from '../../interfaces/rest/bind-controller';
import { UERANSIM_IMAGE, SRSRAN_IMAGE, SRSRAN_BUILD_CONTEXT, dockerPull, dockerImageExists, dockerBuild } from '../../interfaces/rest/validation-controller';

// ── Fresh-host bootstrap: install every optional module's real packages/
// binaries BEFORE a Full Backup's config is written to disk ────────────────
//
// backup-restore/bootstrap-fresh-host.sh covers the layer beneath this: OS
// packages, Docker, MongoDB, Open5GS's 17 core NF binaries, and the NMS's
// own containers — run manually, once, before this ever runs (it needs the
// NMS backend itself already up to be reachable at all). This use-case
// covers the layer THIS backend actually can automate: every optional add-on
// module's own Install step, driven by which modules a specific uploaded
// backup archive's manifest says were actually in use (backup-restore.ts's
// derivePresentModules() at backup-creation time), not installed
// unconditionally — several of these are multi-minute source builds
// (VoWiFi, SecGW), no reason to pay that cost for a module the backup never
// used.
//
// Deliberately Install-only, no Configure here — Configure is what
// backup-restart-usecase.ts runs, AFTER the actual category restore writes
// each module's real state JSON to disk. Calling Configure here, before that
// state exists, would either fail outright or write placeholder defaults
// that the restore would then have to immediately overwrite anyway.
//
// Same startBootstrap()/getRunState() async-job shape as module-fixall-
// usecase.ts (the direct precedent for in-process installX(write) calls)
// and ip-plan-apply-usecase.ts — this can run many minutes long.
//
// Deliberately NOT covered: FRR source-build (needs an operator-chosen git
// tag that only becomes known once frr-source-build-state.json is restored,
// i.e. genuinely can't run before the restore the way every other module
// here can — and it's the one subsystem in this project with a confirmed-
// live crash bug if mishandled, see CLAUDE.md pattern #7 — confirmed live
// 2026-09-24 to have actually caused a real ~20-hour production outage; re-run
// it manually from the FRR Source Build page after restore, same target tag —
// as of 2026-09-24 the crash-guard patch is applied automatically as part of
// that build for its one verified tag, frr-source-build.ts's own
// CRASH_GUARD_PATCH_TAG, so this manual re-run is now sufficient on its own),
// Sercomm NR
// (manages an already-racked physical radio via GenieACS NBI, nothing to
// host-install), Charging Plans (rides along automatically inside OCS's own
// Configure — ensureDefaultUnlimitedPlan()), and chrony (a base prerequisite
// backup-restore/bootstrap-fresh-host.sh already installs, not a module with
// its own install step).

export type BootstrapModuleId =
  | 'ims' | 'smsOverSgs' | 'gsm' | 'asterisk2g' | 'hnbgw' | 'vowifi'
  | 'secgw' | 'ocs' | 'mms' | 'pstn' | 'vectorcoreSmsc' | 'twamp' | 'syslog';

// Dependency-respecting order (mirrors module-fixall-usecase.ts's own
// MODULE_ORDER plus the extra modules it doesn't cover): IMS is the root
// dependency for MMS/PSTN/VectorCore SMSC's eventual Configure step, GSM's
// osmo-sip-connector build must exist before Asterisk-2G's install even
// starts (verifyGsmSipConnReady() hard-throws otherwise — the one real
// install-time, not just configure-time, cross-module dependency found
// across all 13 modules), and HNBGW's eventual Configure needs GSM's
// GPRS/EDGE already applied.
const MODULE_INSTALL_ORDER: BootstrapModuleId[] = [
  'ims', 'smsOverSgs', 'gsm', 'asterisk2g', 'hnbgw', 'vowifi',
  'secgw', 'ocs', 'mms', 'pstn', 'vectorcoreSmsc', 'twamp', 'syslog',
];

const MODULE_LABELS: Record<BootstrapModuleId, string> = {
  ims: 'IMS / VoLTE (+ PyHSS)',
  smsOverSgs: 'SMS over SGs (osmo-stp/hlr/msc)',
  gsm: '2G GSM (osmo-bsc/mgw/bts + osmo-sip-connector)',
  asterisk2g: 'Asterisk-2G (2G Voice)',
  hnbgw: '3G UMTS (OsmoHNBGW)',
  vowifi: 'VoWiFi (VectorCore ePDG + AAA)',
  secgw: 'Security Gateway (strongSwan)',
  ocs: 'SigScale OCS',
  mms: 'MMS (VectorCore MMSC)',
  pstn: 'PSTN Gateway (Asterisk)',
  vectorcoreSmsc: 'SMS (VectorCore SMSC)',
  twamp: 'TWAMP',
  syslog: 'Syslog Forwarding (rsyslog)',
};

export interface BootstrapModuleResult {
  moduleId: string;
  label: string;
  installed: boolean;
  skipped: boolean;
  error?: string;
  log: string[];
}

export interface FreshHostBootstrapRunState {
  status: 'idle' | 'running' | 'complete' | 'failed';
  startedAt?: string;
  completedAt?: string;
  currentModule?: string;
  results: BootstrapModuleResult[];
}

// Runs an nsenter'd bash one-liner to completion, streaming into a log
// array — same shape as every controller's own local spawnStream helper,
// duplicated here (not imported) since it's genuinely trivial and this file
// has no single controller it would make sense to import it from.
function spawnStream(bashScript: string, write: (s: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', '--', 'bash', '-c', bashScript], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (d: Buffer) => write(d.toString()));
    child.stderr?.on('data', (d: Buffer) => write(d.toString()));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

// VoWiFi's install is a detached background job (see vowifi-controller.ts's
// own startInstall/resetAndStartInstall) rather than an awaitable streamed
// function — poll its state file the same way module-fixall-usecase.ts's
// own runVowifiInstall() does.
const VOWIFI_INSTALL_POLL_MS = 3000;
const VOWIFI_INSTALL_TIMEOUT_MS = 20 * 60 * 1000;

export class FreshHostBootstrapUseCase {
  private runState: FreshHostBootstrapRunState = { status: 'idle', results: [] };

  constructor(
    private readonly logger: pino.Logger,
    private readonly auditLogger: IAuditLogger,
  ) {}

  startBootstrap(presentModules: string[], user: string): { started: true } | { started: false; error: string } {
    if (this.runState.status === 'running') {
      return { started: false, error: 'A fresh-host bootstrap is already in progress.' };
    }
    this.runState = { status: 'running', startedAt: new Date().toISOString(), results: [] };
    this.runBootstrap(presentModules, user).catch(err => {
      this.logger.error({ err: String(err) }, 'fresh-host-bootstrap: unexpected top-level failure');
      this.runState.status = 'failed';
      this.runState.completedAt = new Date().toISOString();
    });
    return { started: true };
  }

  getRunState(): FreshHostBootstrapRunState {
    return this.runState;
  }

  private async runBootstrap(presentModules: string[], user: string): Promise<void> {
    const requested = new Set(presentModules);

    // BIND9 is shared infrastructure (CLAUDE.md pattern #4) with no single
    // canonical installer of its own — every module that needs it
    // (IMS/VoWiFi) redundantly apt-installs it themselves, same as this.
    // Always run once, unconditionally, cheap and idempotent, so a module
    // whose own installer runs later never races an absent bind9.
    this.runState.currentModule = 'bind9';
    const bindLog: string[] = [];
    const bindExit = await spawnStream('DEBIAN_FRONTEND=noninteractive apt-get install -y bind9 bind9utils dnsutils 2>&1', (s) => bindLog.push(s));
    // Real, 2026-09-23 finding: a genuinely fresh host's default resolv.conf still
    // points at systemd-resolved's stub, not this freshly-installed BIND — every 5GC
    // NF's own synchronous getaddrinfo() at startup (pattern #6) fails until this is
    // fixed, no matter how correctly BIND's own zones get configured afterward by a
    // later restore. Fix immediately, right after BIND exists to point at, so nothing
    // downstream in this same bootstrap run (or a later restore) races an absent one.
    let resolverError: string | undefined;
    if (bindExit === 0) {
      try {
        if (checkBindHealth().resolvConfBypassesBind) {
          await fixResolver();
          bindLog.push('Fixed system resolver: /etc/resolv.conf now points at 127.0.0.1 (BIND), systemd-resolved stub disabled\n');
        }
      } catch (err) {
        resolverError = `resolv.conf fix failed: ${String(err)}`;
        bindLog.push(`${resolverError}\n`);
      }
      // Real outage, 2026-10-06: pointing resolv.conf at BIND is necessary but
      // not sufficient — if DNS simply isn't answering YET when the NFs start,
      // every one of them burns its 5-attempt/100ms systemd restart budget in
      // under a second and systemd gives up permanently. That is exactly what
      // the 2026-09-23 occurrence on a fresh host looked like. Install the
      // readiness gate here, right after BIND exists to point at, so a fresh
      // host is never left one slow boot away from a dead core. Non-fatal: the
      // gate is a robustness improvement, not a prerequisite for bootstrap.
      try {
        const gate = await installDnsBootGate();
        bindLog.push(`Installed DNS boot-race gate (open5gs-dns-ready.service) for ${gate.units.length} units\n`);
      } catch (err) {
        bindLog.push(`DNS boot-race gate install failed (non-fatal): ${String(err)}\n`);
      }
    }
    this.runState.results.push({
      moduleId: 'bind9', label: 'DNS (BIND9)', installed: bindExit === 0, skipped: false,
      error: bindExit === 0 ? resolverError : `apt-get exit ${bindExit}`, log: bindLog,
    });

    for (const moduleId of MODULE_INSTALL_ORDER) {
      if (!requested.has(moduleId)) {
        this.runState.results.push({ moduleId, label: MODULE_LABELS[moduleId], installed: false, skipped: true, log: [] });
        continue;
      }
      this.runState.currentModule = moduleId;
      const result = await this.installOne(moduleId).catch((err): BootstrapModuleResult => ({
        moduleId, label: MODULE_LABELS[moduleId], installed: false, skipped: false, error: String(err), log: [],
      }));
      this.runState.results.push(result);
    }

    // Real, 2026-09-24 finding: UE Validation's two Docker images (real
    // synthetic 5G/4G UE emulators) were never pre-provisioned anywhere —
    // not a compose service (this module drives them via the mounted
    // docker.sock), not fresh-host-bootstrap-usecase.ts (unlike FRR source-
    // build/Sercomm NR/Charging Plans/chrony, each an explicit, stated
    // exclusion in this file's own header comment — UE Validation wasn't
    // mentioned at all, reading as an oversight, not a considered
    // decision). Already disclosed in INSTALL.md/docs/requirements.md as a
    // documented cold-start cost, but automating it removes the surprise.
    // Positioned AFTER the module loop above (not unconditional like BIND9,
    // and not gated by presentModules — there's no backup-manifest signal
    // for "was validation used," and the feature is visible by default) so
    // a 20+-minute srsRAN build never delays any other module's install.
    // Each image gets its own try/catch so a failure (e.g. no internet)
    // is recorded without failing the overall bootstrap run.
    this.runState.currentModule = 'ueValidation';
    const valLog: string[] = [];
    let valOk = true;
    try {
      valLog.push(`Pulling ${UERANSIM_IMAGE}...`);
      await dockerPull(UERANSIM_IMAGE);
      valLog.push('UERANSIM image ready.');
    } catch (err) {
      valOk = false;
      valLog.push(`UERANSIM pull failed: ${String(err)} (will retry on first real use)`);
    }
    try {
      if (await dockerImageExists(SRSRAN_IMAGE)) {
        valLog.push(`${SRSRAN_IMAGE} already present.`);
      } else {
        valLog.push(`Building ${SRSRAN_IMAGE} from ${SRSRAN_BUILD_CONTEXT} (can take 20+ minutes)...`);
        await dockerBuild(SRSRAN_IMAGE, SRSRAN_BUILD_CONTEXT);
        valLog.push('srsRAN image built.');
      }
    } catch (err) {
      valOk = false;
      valLog.push(`srsRAN build failed: ${String(err)}`);
    }
    this.runState.results.push({
      moduleId: 'ueValidation', label: 'UE Validation (UERANSIM + srsRAN test images)',
      installed: valOk, skipped: false, log: valLog,
    });

    this.runState.status = 'complete';
    this.runState.completedAt = new Date().toISOString();
    this.runState.currentModule = undefined;

    const allOk = this.runState.results.every(r => r.skipped || r.installed);
    await this.auditLogger.log({
      action: 'fresh_host_bootstrap',
      user,
      details: this.runState.results.map(r => `${r.moduleId}:${r.skipped ? 'skipped' : (r.installed ? 'ok' : 'failed')}`).join(' '),
      success: allOk,
    });
  }

  private async installOne(moduleId: BootstrapModuleId): Promise<BootstrapModuleResult> {
    const log: string[] = [];
    const write = (s: string) => log.push(s);
    const label = MODULE_LABELS[moduleId];

    if (moduleId === 'vowifi') {
      resetAndStartVowifiInstall(this.logger, 'fresh-host-bootstrap');
      write('VoWiFi (VectorCore) install started (detached build)...');
      const deadline = Date.now() + VOWIFI_INSTALL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, VOWIFI_INSTALL_POLL_MS));
        const state = loadVowifiState();
        if (state.installStatus === 'complete') {
          write('VoWiFi (VectorCore) install complete.');
          return { moduleId, label, installed: true, skipped: false, log };
        }
        if (state.installStatus === 'failed') {
          const error = state.installError ?? 'install failed';
          write(`VoWiFi (VectorCore) install failed: ${error}`);
          return { moduleId, label, installed: false, skipped: false, error, log };
        }
      }
      const error = `VoWiFi install did not complete within ${VOWIFI_INSTALL_TIMEOUT_MS / 60000} minutes`;
      return { moduleId, label, installed: false, skipped: false, error, log };
    }

    if (moduleId === 'smsOverSgs') {
      // No exported installX(write) exists for this one (no extracted
      // function anywhere in sms-controller.ts — see the module research
      // behind this file) — replicate its one-liner directly rather than
      // add a fourth extraction for a single apt-get call.
      const exitCode = await spawnStream(
        "DEBIAN_FRONTEND=noninteractive apt-get install -y osmo-stp osmo-hlr osmo-msc sqlite3 2>&1", write,
      );
      return exitCode === 0
        ? { moduleId, label, installed: true, skipped: false, log }
        : { moduleId, label, installed: false, skipped: false, error: `apt-get exit ${exitCode}`, log };
    }

    const r = await (async () => {
      switch (moduleId) {
        case 'ims': return installIms(write);
        case 'gsm': return installGsm(write);
        case 'asterisk2g': return installAsterisk2g(write);
        case 'hnbgw': return installHnbgw(write);
        case 'secgw': return installSecgw(write);
        case 'ocs': return installOcs(write);
        case 'mms': return installMms(write);
        case 'pstn': return installPstn(write);
        case 'vectorcoreSmsc': return installVectorcoreSmsc(write);
        case 'twamp': return installTwamp(write);
        case 'syslog': return installSyslog(write);
        default: throw new Error(`unreachable moduleId: ${moduleId}`);
      }
    })();
    // installIms() is the one installX(write) in this codebase that returns
    // bare { success } with no error field at all — everything else carries
    // an optional one.
    const error = (r as { error?: string }).error;
    return { moduleId, label, installed: r.success, skipped: false, error, log };
  }
}
