import * as fs from 'fs';
import pino from 'pino';
import { Db } from 'mongodb';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { SERVICE_RESTART_ORDER, SERVICE_UNIT_MAP } from '../../domain/entities/service-status';
import { BackupCategory } from './backup-restore';
import { readCurrentImsConfig, configureIms, syncImsSubscribers } from '../../interfaces/rest/ims-controller';
import { readCurrentSmsConfig, configureSms, syncHlrSubscribers, getMscMnccMode, setMscMnccMode } from '../../interfaces/rest/sms-controller';
import { MNCC_SOCKET_PATH } from './osmo-sip-connector-build';
import { loadGsmState, configureGsm, configureGsmSip } from '../../interfaces/rest/gsm-controller';
import { configureAsterisk2g } from '../../interfaces/rest/asterisk-2g-controller';
import { loadHnbgwState, configureHnbgw } from '../../interfaces/rest/hnbgw-controller';
import { loadState as loadVowifiState, configureVowifi, VowifiConfigureError } from '../../interfaces/rest/vowifi-controller';
import { loadState as loadSecgwState, configureSecgw, writeRadioConfFile } from '../../interfaces/rest/secgw-controller';
import { configureOcs, syncOcsSubscribersIfConfigured } from '../../interfaces/rest/ocs-controller';
import { resyncChargingPlanAssignments } from '../../interfaces/rest/charging-plans-controller';
import { readMmsState, configureMms, syncMmsSubscribers } from '../../interfaces/rest/mms-controller';
import { readPstnState, configurePstn, applyExternalTrunkChange } from '../../interfaces/rest/pstn-controller';
import { configureVectorcoreSmsc } from '../../interfaces/rest/vectorcore-smsc-controller';
import { readTwampState } from './twamp/twamp-runner';
import { ensureHistoryIndexes } from './twamp/twamp-history';
import { configureTwampServer } from '../../interfaces/rest/twamp-controller';
import { readCdrSettings } from '../../interfaces/rest/cdr-controller';
import { ensureCdrIndexes } from './cdr/cdr-store';
import { parseTarget, configureSyslog } from '../../interfaces/rest/syslog-controller';
import { checkBindHealth, fixResolver, checkDnsBootGate, installDnsBootGate } from '../../interfaces/rest/bind-controller';
import { writeUpfSessionPoolAddressFix, SessionPool } from './auto-config';
import { SyncGenieacsProvisionsUseCase } from './sync-genieacs-provisions';
import * as yaml from 'js-yaml';

// ── Restart / reapply after a Full Backup restore ───────────────────────────
//
// backup-restore.ts's restoreFullBackup() is a pure file/Mongo copy
// mechanism by design (confirmed: it imports no controller install/configure
// function anywhere) — every one of its 9 category blocks writes real files
// to disk and stops there. Real, 2026-09-22 finding: NONE of them restart
// anything, confirmed by its own comments admitting the gap in 3 of the 9
// blocks. This use-case is the missing step, run right after a restore
// completes.
//
// Two genuinely different kinds of "pick up the restored file" exist here,
// and conflating them is the main way to get this subtly wrong:
//  - Direct-file categories (core-configs, l3-network, dns, secgw-pki,
//    suci-keys): the restored file IS the live config an NF/daemon reads
//    at startup — a plain restart is correct and sufficient.
//  - optional-modules is almost entirely the OTHER shape (CLAUDE.md pattern
//    #1): the restored JSON is a SOURCE OF TRUTH a module's own Configure
//    function reads to REGENERATE several derived files (e.g. GSM's one
//    state file becomes 6 different .cfg files). A bare `systemctl restart`
//    there would restart the daemon against whatever derived config
//    happened to already exist on disk (stale, on a same-host restore; not
//    present at all on a fresh host) — never the just-restored state. The
//    fix is the same one module-fixall-usecase.ts already established for
//    "stale config, reapply it": call that module's own configureX() again.
//    Deliberately NOT gated on that module's own staleness/version check
//    (unlike module-fixall) — a restored file can easily carry the exact
//    same configuredWithVersion as the host it's landing on, which would
//    make a staleness check wrongly report "nothing to do" even though the
//    derived files were never regenerated from this copy of the state.
//    Gated purely on "does this module's own state file exist on this host
//    right now" instead.
//
// Same startRestart()/getRunState() async-job shape as every other
// multi-minute orchestrator in this codebase (module-fixall-usecase.ts,
// ip-plan-apply-usecase.ts, fresh-host-bootstrap-usecase.ts).

const PROC = (p: string) => `/proc/1/root${p}`;

export interface RestartStepResult {
  step: string;
  label: string;
  success: boolean;
  skipped: boolean;
  error?: string;
}

export interface BackupRestartRunState {
  status: 'idle' | 'running' | 'complete' | 'failed';
  startedAt?: string;
  completedAt?: string;
  currentStep?: string;
  results: RestartStepResult[];
}

export class BackupRestartUseCase {
  private runState: BackupRestartRunState = { status: 'idle', results: [] };

  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly subscriberRepo: ISubscriberRepository,
    private readonly mongoUri: string,
    private readonly logger: pino.Logger,
    private readonly auditLogger: IAuditLogger,
    private readonly db: Db,
  ) {}

  startRestart(restoredCategories: BackupCategory[], user: string): { started: true } | { started: false; error: string } {
    if (this.runState.status === 'running') {
      return { started: false, error: 'A post-restore restart is already in progress.' };
    }
    this.runState = { status: 'running', startedAt: new Date().toISOString(), results: [] };
    this.runRestart(restoredCategories, user).catch(err => {
      this.logger.error({ err: String(err) }, 'backup-restart: unexpected top-level failure');
      this.runState.status = 'failed';
      this.runState.completedAt = new Date().toISOString();
    });
    return { started: true };
  }

  getRunState(): BackupRestartRunState {
    return this.runState;
  }

  private async runRestart(restoredCategories: BackupCategory[], user: string): Promise<void> {
    const has = (c: BackupCategory) => restoredCategories.includes(c);
    const push = (r: RestartStepResult) => { this.runState.results.push(r); };

    // core-17 + mongodb — suci-keys needs UDM restarted to pick up new
    // de-concealment keys (loaded at startup); subscribers (Mongo data)
    // alone needs nothing (every NF queries Mongo live, no restart needed).
    if (has('core-configs') || has('suci-keys')) {
      this.runState.currentStep = 'core-17';
      push(await this.restartCore17());
    }

    // Real, 2026-09-24 finding: l3-network must run BEFORE secgw-pki — a
    // SecGW in `interfaceMode: 'existing'` binds to a restored dummy
    // interface (l3-network's own systemd-networkd files), and
    // configureSecgw() only CHECKS an interface already exists (by design,
    // 'existing' mode means "operator manages this interface") rather than
    // creating one — on a genuinely fresh host with both categories
    // selected, running secgw-pki first would fail loudly ("is not
    // currently assigned to any interface") since l3-network's own
    // systemd-networkd restart hadn't brought the interface up yet. Fails
    // loudly (not silently) either way and self-heals via a manual Configure
    // retry, but the correct order avoids the failure entirely.
    if (has('l3-network')) {
      this.runState.currentStep = 'l3-network';
      for (const step of await this.reapplyL3Network()) push(step);
    }

    if (has('secgw-pki')) {
      this.runState.currentStep = 'secgw';
      const secgwState = loadSecgwState();
      push(await this.step('secgw', 'Security Gateway', !secgwState.gatewayIp, async () => {
        const r = await configureSecgw({
          gatewayIp: secgwState.gatewayIp ?? '',
          interfaceMode: secgwState.interfaceMode ?? 'dummy',
          poolCidr: secgwState.poolCidr ?? '',
        });
        if (!r.success) throw new Error(r.error);
      }));
      push(await this.regenerateSecgwRadioConfs());
    }

    if (has('optional-modules')) {
      for (const step of await this.reapplyOptionalModules()) push(step);
    }

    if (has('dns')) {
      this.runState.currentStep = 'dns';
      push(await this.restartUnit('bind9', 'DNS (BIND9)'));
      push(await this.fixSystemResolver());
      push(await this.installDnsBootGateStep());
    }

    if (has('genieacs')) {
      this.runState.currentStep = 'genieacs';
      push(await this.restartGenieAcs());
    }

    if (has('ui-modules')) {
      this.runState.currentStep = 'ui-modules';
      push(await this.rebuildFrontend());
    }

    this.runState.status = 'complete';
    this.runState.completedAt = new Date().toISOString();
    this.runState.currentStep = undefined;

    const allOk = this.runState.results.every(r => r.skipped || r.success);
    await this.auditLogger.log({
      action: 'backup_restart_after_restore',
      user,
      details: this.runState.results.map(r => `${r.step}:${r.skipped ? 'skipped' : (r.success ? 'ok' : 'failed')}`).join(' '),
      success: allOk,
    });

    // auth needs THIS backend container itself restarted (its better-
    // sqlite3 handle on auth.db was opened at process start, pointed at the
    // pre-restore file) — the actual process.exit() is triggered by the
    // caller (FullRestoreOrchestratorUseCase), AFTER it persists this run's
    // final combined state to disk first. Real, 2026-09-22 live-VM finding:
    // doing the exit here, with no persistence, meant the in-memory run
    // state (including this "complete" status) was simply lost the moment
    // the process restarted — a real caller polling the status endpoint
    // right after an auth-included restore would see a fresh 'idle'
    // orchestrator and have no way to know the restore actually succeeded.
    if (has('auth')) {
      push({ step: 'auth', label: 'NMS Login (self-restart)', success: true, skipped: false });
    }
  }

  // ── Direct-file categories ─────────────────────────────────────────────

  private async restartCore17(): Promise<RestartStepResult> {
    for (const service of SERVICE_RESTART_ORDER) {
      const unitName = SERVICE_UNIT_MAP[service];
      try {
        if (service === 'mongodb') {
          const dockerName = await this.findMongoDockerContainer();
          if (dockerName) {
            const r = await this.hostExecutor.executeLocalCommand('docker', ['restart', dockerName]);
            if (r.exitCode !== 0) throw new Error(r.stderr || `docker restart ${dockerName} failed`);
            await this.delay(3000);
            continue;
          }
        }
        const result = await this.hostExecutor.restartService(unitName);
        if (result.exitCode !== 0) {
          if (result.stderr?.includes('not found')) continue; // running outside systemd
          throw new Error(result.stderr || `exit code ${result.exitCode}`);
        }
        await this.delay(service === 'mme' ? 5000 : (service === 'smf' || service === 'sgwc') ? 4000 : (service === 'nrf' || service === 'scp') ? 3000 : 2000);
      } catch (err) {
        return { step: 'core-17', label: 'Core 17 NFs + MongoDB', success: false, skipped: false, error: `${service}: ${String(err)}` };
      }
    }

    // Best-effort — a restore never goes through AutoConfigUseCase.execute()
    // (see writeUpfSessionPoolAddressFix()'s own comment for the full
    // rationale), so its own call site there would never fire here. Read the
    // just-restored upf.yaml directly rather than requiring a full
    // AutoConfigInput. A failure here shouldn't fail core-17's own restart,
    // which already succeeded by this point.
    try {
      const raw = fs.readFileSync('/etc/open5gs/upf.yaml', 'utf-8');
      const parsed = yaml.load(raw) as any;
      const pools: SessionPool[] = (parsed?.upf?.session ?? []).map((s: any) => ({
        subnet: s.subnet, gateway: s.gateway, dnn: s.dnn, dev: s.dev,
      }));
      await writeUpfSessionPoolAddressFix(this.hostExecutor, pools, this.logger);
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'Failed to write UPF session-pool address-fix drop-in after core-17 restore');
    }

    return { step: 'core-17', label: 'Core 17 NFs + MongoDB', success: true, skipped: false };
  }

  // Mirrors apply-config.ts's own findMongoDockerContainer() — duplicated
  // rather than imported since that one is a private method on
  // ApplyConfigUseCase; small enough not to be worth a shared-export change
  // to a core, already-working file for this.
  private async findMongoDockerContainer(): Promise<string | null> {
    try {
      const r = await this.hostExecutor.executeLocalCommand('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}']);
      if (r.exitCode !== 0) return null;
      for (const line of r.stdout.split('\n')) {
        const [name, image] = line.split('\t');
        if (name && image?.toLowerCase().includes('mongo')) return name.trim();
      }
      return null;
    } catch {
      return null;
    }
  }

  private async restartUnit(unitName: string, label: string): Promise<RestartStepResult> {
    try {
      const result = await this.hostExecutor.restartService(unitName);
      if (result.exitCode !== 0 && !result.stderr?.includes('not found')) {
        return { step: unitName, label, success: false, skipped: false, error: result.stderr || `exit code ${result.exitCode}` };
      }
      return { step: unitName, label, success: true, skipped: false };
    } catch (err) {
      return { step: unitName, label, success: false, skipped: false, error: String(err) };
    }
  }

  /**
   * Apply a restored frr.conf to an already-running FRR without restarting it.
   *
   * Falls back to reporting the manual step (rather than silently restarting)
   * if this FRR has no reload support or the reload fails — a restart here
   * would reintroduce the documented, reproduced frr#943 crash on a host whose
   * EIGRP neighbor is established, and that is the operator's call, not ours.
   */
  private async reloadFrr(): Promise<RestartStepResult> {
    const manual = (why: string): RestartStepResult => ({
      step: 'frr', label: 'FRR (EIGRP)', success: true, skipped: true,
      error: `FRR was already running and ${why} — not auto-restarted (a naive restart while an EIGRP neighbor is already established has a confirmed crash bug, CLAUDE.md pattern #7). frr.conf has been restored to disk; apply it via vtysh, or restart frr manually if this host has no live EIGRP neighbor to lose.`,
    });
    try {
      const canReload = await this.hostExecutor.executeCommand(
        'systemctl', ['show', 'frr', '-p', 'CanReload'], 15000,
      );
      if (!canReload.stdout?.includes('CanReload=yes')) {
        return manual('this FRR build has no reload support');
      }
      const result = await this.hostExecutor.executeCommand('systemctl', ['reload', 'frr'], 120000);
      if (result.exitCode !== 0) {
        return manual(`the incremental reload failed (${result.stderr?.trim() || `exit ${result.exitCode}`})`);
      }
      // Never trust the exit code alone.
      const stillActive = await this.hostExecutor.isServiceActive('frr').catch(() => false);
      if (!stillActive) {
        return { step: 'frr', label: 'FRR (EIGRP)', success: false, skipped: false, error: 'FRR went inactive after an incremental reload of the restored frr.conf' };
      }
      return { step: 'frr', label: 'FRR (EIGRP)', success: true, skipped: false };
    } catch (err) {
      return manual(`the incremental reload errored (${String(err)})`);
    }
  }

  // Real, 2026-09-23 finding: `secgw-pki` restores `.secgw-state.json` (every
  // radio's own PSK/certs/algo choices, in `state.radios`) plus the CA/cert
  // files, but nothing ever regenerates each radio's own swanctl
  // conf.d/<id>.conf, which normally only gets written incrementally by that
  // radio's own add/enable/update endpoint. A restore brings the state back
  // with zero conf.d files to show for it, silently stranding every existing
  // radio with nothing to reconnect. Mirrors POST /radios/:id/enable's own
  // per-radio logic (writeRadioConfFile()), just run once for the whole list
  // instead of requiring an operator to click enable on every radio by hand
  // after every restore.
  //
  // Real, 2026-09-24 finding: this step depends on configureSecgw() having
  // already (re)written the base /etc/swanctl/swanctl.conf — the file whose
  // `include conf.d/*.conf` line is what makes `swanctl --load-all` (below)
  // actually pick up the per-radio files this function writes. configureSecgw()
  // used to run from reapplyOptionalModules() instead, gated on the
  // `optional-modules` category rather than `secgw-pki` — restoring
  // `secgw-pki` alone (a plausible operator choice: its own description reads
  // as "self-sufficient," and `optional-modules` bundles ~10 unrelated
  // modules an operator may deliberately want to leave untouched) left every
  // tunnel non-functional with every step reporting success. Fixed by moving
  // the configureSecgw() call into runRestart()'s `has('secgw-pki')` block,
  // immediately before this function runs.
  private async regenerateSecgwRadioConfs(): Promise<RestartStepResult> {
    const step = 'secgw-radios';
    const label = 'SecGW per-radio tunnel configs';
    try {
      const state = loadSecgwState();
      if (!state.gatewayIp || !state.gatewayFqdn || state.radios.length === 0) {
        return { step, label, success: true, skipped: true };
      }
      for (const radio of state.radios) {
        if (radio.status === 'revoked') continue;
        writeRadioConfFile(radio, state);
      }
      const result = await this.hostExecutor.executeCommand('swanctl', ['--load-all'], 15000);
      if (result.exitCode !== 0) {
        return { step, label, success: false, skipped: false, error: result.stderr || `exit code ${result.exitCode}` };
      }
      return { step, label, success: true, skipped: false };
    } catch (err) {
      return { step, label, success: false, skipped: false, error: String(err) };
    }
  }

  // Real, 2026-09-23 finding: restoring the `dns` category correctly brings BIND's
  // own zones/config back and restarts it, but a fresh/restored host's
  // /etc/resolv.conf commonly still points at systemd-resolved's stub, not the
  // just-restarted BIND — every 5GC NF's own synchronous getaddrinfo() at startup
  // (pattern #6) then fails regardless of how correct BIND's zones are, since it's
  // never actually consulted. Same fix bind-controller.ts's own /fix-resolver route
  // and fresh-host-bootstrap-usecase.ts's bind9 install step both call — gated on
  // checkBindHealth() so a host that's already correctly routed through BIND (e.g.
  // a same-host rollback restore) doesn't needlessly bounce systemd-resolved.
  private async fixSystemResolver(): Promise<RestartStepResult> {
    const step = 'dns-resolver';
    const label = 'System DNS Resolver (resolv.conf → BIND)';
    try {
      if (!checkBindHealth().resolvConfBypassesBind) {
        return { step, label, success: true, skipped: true };
      }
      await fixResolver();
      return { step, label, success: true, skipped: false };
    } catch (err) {
      return { step, label, success: false, skipped: false, error: String(err) };
    }
  }

  // Real outage, 2026-10-06: a power loss left 9 of the 17 core NFs permanently
  // down because every one of them burned its 5-attempt/100ms systemd restart
  // budget before bind9 could answer (full rationale in bind-controller.ts's
  // installDnsBootGate()). The 2026-09-23 occurrence of that same signature
  // happened on exactly this path — a restore onto a genuinely fresh host — so
  // the gate is (re)installed here rather than archived into the backup: it is
  // regenerated from code, so a restore can never bring back a copy older than
  // the code that reads it. Idempotent, and rev-checked so a bumped
  // DNS_BOOT_GATE_REV reinstalls instead of being silently skipped.
  private async installDnsBootGateStep(): Promise<RestartStepResult> {
    const step = 'dns-boot-gate';
    const label = 'DNS boot-race gate (systemd)';
    try {
      if (checkDnsBootGate().installed) {
        return { step, label, success: true, skipped: true };
      }
      await installDnsBootGate();
      return { step, label, success: true, skipped: false };
    } catch (err) {
      return { step, label, success: false, skipped: false, error: String(err) };
    }
  }

  private async restartGenieAcs(): Promise<RestartStepResult> {
    try {
      const r = await this.hostExecutor.executeLocalCommand('docker', ['restart', 'genieacs']);
      if (r.exitCode !== 0) return { step: 'genieacs', label: 'GenieACS', success: false, skipped: false, error: r.stderr };
      // Real, 2026-09-24 finding: the 'default'/'inform' provisioning
      // scripts self-heal only at backend *startup* (index.ts's own
      // unconditional call at boot) — a restore that only touches the
      // genieacs category (a real, independently-selectable choice) never
      // triggers a backend restart on its own, so a fresh/reset genieacs
      // Mongo database could come back with neither script present until
      // the NEXT unrelated backend restart. Sync explicitly here too, right
      // after the restart above, so this category's own reapply is
      // self-sufficient — same reasoning as every other module's reapply
      // step not depending on a different category also being selected.
      const nbiUrl = process.env.GENIEACS_NBI_URL || 'http://127.0.0.1:7557';
      const syncResult = await new SyncGenieacsProvisionsUseCase(nbiUrl, this.logger).execute();
      if (!syncResult.synced) {
        this.logger.warn({ error: syncResult.error }, 'genieacs reapply: provisioning scripts sync failed');
      }
      return { step: 'genieacs', label: 'GenieACS', success: true, skipped: false };
    } catch (err) {
      return { step: 'genieacs', label: 'GenieACS', success: false, skipped: false, error: String(err) };
    }
  }

  // Same working-dir discovery as backup-restore.ts's own
  // getComposeWorkingDir() — duplicated rather than imported, same
  // small-helper precedent as findMongoDockerContainer() above (this class
  // has its own hostExecutor instance, no shared-state reason to export it).
  private async getComposeWorkingDir(): Promise<string | null> {
    try {
      const r = await this.hostExecutor.executeLocalCommand('docker', [
        'inspect', 'open5gs-nms-backend', '--format',
        '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}',
      ]);
      const dir = r.stdout.trim();
      return r.exitCode === 0 && dir && dir !== '<no value>' ? dir : null;
    } catch {
      return null;
    }
  }

  // The one restart step in this file that isn't a systemctl/docker-restart
  // of an existing container — a changed ENABLE_* flag only takes effect
  // after a real `docker compose build frontend`, matching CLAUDE.md's own
  // documented manual workflow, just automated here. Runs via nsenter (a
  // real host bash), not this container's own docker-ce-cli — confirmed
  // live 2026-09-23 the compose plugin isn't installed in the backend
  // image, only the bare CLI (`docker compose` inside this container is
  // "unknown command"), while the HOST's real docker install (how this
  // whole stack was originally stood up) definitely has it. `docker compose
  // up -d frontend` only recreates the frontend container — no risk to this
  // backend process itself, unlike the `auth` category's self-restart above.
  private async rebuildFrontend(): Promise<RestartStepResult> {
    const label = 'Frontend rebuild (UI module toggles)';
    try {
      const workingDir = await this.getComposeWorkingDir();
      if (!workingDir) {
        return { step: 'ui-modules', label, success: false, skipped: true, error: 'Could not resolve compose project directory — rebuild manually: docker compose build frontend && docker compose up -d frontend' };
      }
      const script = `cd '${workingDir}' && docker compose build frontend && docker compose up -d frontend`;
      const result = await this.hostExecutor.executeCommand('bash', ['-c', script], 600000);
      if (result.exitCode !== 0) {
        return { step: 'ui-modules', label, success: false, skipped: false, error: result.stderr || `exit code ${result.exitCode}` };
      }
      return { step: 'ui-modules', label, success: true, skipped: false };
    } catch (err) {
      return { step: 'ui-modules', label, success: false, skipped: false, error: String(err) };
    }
  }

  private async reapplyL3Network(): Promise<RestartStepResult[]> {
    const results: RestartStepResult[] = [];
    // Brings up the just-restored dummy interfaces (VoWiFi ePDG, PSTN
    // external trunk, SecGW gateway, etc.) — restoring the .netdev/.network
    // files alone does not do this.
    results.push(await this.restartUnit('systemd-networkd', 'Dummy network interfaces'));

    // FRR is the one service in this whole codebase with a confirmed-live
    // crash bug on a naive restart while an EIGRP neighbor is already
    // established (CLAUDE.md pattern #7) — the trigger is specifically a
    // full neighbor RESYNC during restart, which can't happen if FRR wasn't
    // already running (a genuinely fresh host, or one where L3 Routing was
    // never set up). Only auto-restart in that safe case; on an already-
    // running FRR (a same-host rollback restore), leave it alone and say so
    // rather than blindly reintroducing a documented, reproduced crash.
    const frrWasActive = await this.hostExecutor.isServiceActive('frr').catch(() => false);
    if (frrWasActive) {
      // `systemctl reload frr` runs FRR's own frr-reload.py, which diffs the
      // running config against the just-restored frr.conf and applies only the
      // delta over vtysh — the same incremental path pattern #7 documents as
      // safe, so the adjacency is never reset and the restart trigger is never
      // hit. This used to be left entirely to the operator, which meant a
      // restore onto an already-routing host silently did not apply the
      // routing config it had just restored.
      results.push(await this.reloadFrr());
    } else {
      results.push(await this.restartUnit('frr', 'FRR (EIGRP)'));
    }
    results.push(await this.checkFrrCrashGuard());
    return results;
  }

  // Real, 2026-09-23/24 finding: this project's own FRR crash-guard
  // source-build (pattern #7 — patches the confirmed `eigrp_fsm_event_nq_fcn()`
  // assertion crash) had never actually been applied on EITHER of the two
  // real hosts compared this session, despite CLAUDE.md crediting it as
  // "stopped every recurrence tested so far" — that line describes the
  // design, not a confirmed-deployed state. Confirmed live 2026-09-24: this
  // exact gap caused a real ~20-hour production outage (eigrpd crashed
  // during a plain `systemctl stop`, hit this exact assertion, never
  // auto-restarted). Deliberately a DETECT-AND-REPORT step, not an
  // auto-rebuild: the real fix (FRR Source Build page, ~9 minutes, purges
  // and reinstalls FRR itself) is the single riskiest operation in this
  // whole codebase to fire unattended inside an already-multi-step restore
  // — an operator doing a routine restore shouldn't be surprised by a
  // 9-minute FRR rebuild they didn't ask for.
  //
  // This check used to test ONLY for the generic "-open5gsnms" pkg-extra-
  // version marker (buildFrrSourceScript()'s own --with-pkg-extra-version
  // flag, set unconditionally on EVERY source build) — a false-negative
  // risk, since that marker proves "this is an open5gs-nms source build,"
  // not "the crash-guard patch specifically was applied on top of it."
  // Now that frr-source-build.ts applies the patch automatically for its
  // one verified tag (see CRASH_GUARD_PATCH_TAG), any FUTURE build of that
  // tag is patched by construction — but a host that built BEFORE that fix
  // shipped, or built a different tag, would still pass the old check
  // without being patched. Check the installed binary directly for the
  // patch's own unmistakable log string instead — this can tell "source
  // build, unpatched" apart from "source build, actually patched," which
  // the marker alone never could.
  private async checkFrrCrashGuard(): Promise<RestartStepResult> {
    const step = 'frr-crash-guard';
    const label = 'FRR crash-guard patch (pattern #7)';
    try {
      const active = await this.hostExecutor.isServiceActive('frr').catch(() => false);
      if (!active) return { step, label, success: true, skipped: true, error: 'FRR is not running — nothing to check.' };
      const result = await this.hostExecutor.executeCommand(
        'sh', ['-c', 'strings /usr/lib/frr/eigrpd 2>/dev/null | grep -qF "frr#943 crash-guard" && echo yes || echo no'],
        10000,
      );
      const patched = result.stdout.trim() === 'yes';
      if (patched) return { step, label, success: true, skipped: false };
      return {
        step, label, success: true, skipped: true,
        error: 'This host\'s eigrpd does not have the crash-guard patch applied — it remains exposed to the confirmed assertion-failure crash (pattern #7), which has already caused a real ~20-hour production outage once. Not auto-applied (a real ~9-minute rebuild that stops/restarts FRR). Recommended: FRR Source Build page, target tag frr-10.6.1 — the patch is now applied automatically as part of that build.',
      };
    } catch (err) {
      return { step, label, success: false, skipped: false, error: String(err) };
    }
  }

  // ── optional-modules: reconfigure, not just restart ─────────────────────

  private async reapplyOptionalModules(): Promise<RestartStepResult[]> {
    const results: RestartStepResult[] = [];
    const exists = (p: string) => fs.existsSync(PROC(p));

    // OCS before IMS — real, 2026-09-22 live-VM finding: configureIms()'s
    // own voiceChargingEnabled fail-safe (CLAUDE.md pattern #13 — "don't
    // let a stale flag silently break the entire IMS stack's Configure
    // run") checks whether OCS's Ro peer is actually ready AT THE MOMENT
    // IMS's Configure runs, and quietly downgrades the flag to false if
    // not. Running OCS second (the original order here) meant a restored
    // host's voice charging came back disabled even when the backup had it
    // enabled — not a crash, no error anywhere, just a real, silent
    // behavioral drift from the original host, only caught by directly
    // diff-ing the two hosts' real .ims-config.json content. OCS has no
    // dependency on IMS in the other direction (only needs core SMF, which
    // core-17's own restart step above already guarantees is live), so
    // this reorder is free.
    // Restore never used to re-seed any module's own subscriber database
    // (PyHSS/OsmoHLR/OCS/VectorCore) — configureX() only ever wrote config
    // files and restarted the daemon, so a fresh restore came back with
    // every one of these downstream DBs empty even though Mongo's own
    // subscriber collection was fully restored. Confirmed live 2026-09-22:
    // the operator had to manually click "Sync Subscribers" on 3 separate
    // pages after every restore. Each sync call below mirrors that same
    // button's own logic (extracted into syncXSubscribers() specifically so
    // restore and the manual button share one implementation) and is
    // best-effort — a non-empty `failed` array is a normal per-subscriber
    // partial-failure signal (same as the manual button), not a reason to
    // fail this whole step, since the module itself is already configured
    // and running at that point. Only a systemic throw (DB unreachable, etc)
    // fails the step.
    if (exists('/etc/open5gs/.ocs-config.json')) {
      results.push(await this.step('ocs', 'SigScale OCS', false, async () => {
        const result = await configureOcs({});
        const { subscriberSync, subscriberSyncWarning } = await syncOcsSubscribersIfConfigured(this.subscriberRepo, result.defaultOfferId);
        if (subscriberSyncWarning) this.logger.warn({ subscriberSyncWarning }, 'ocs reapply: subscriber sync warning');
        else if (subscriberSync) this.logger.info({ subscriberSync }, 'ocs reapply: subscribers synced');
        // Charging Plans' own per-subscriber product links are a second,
        // independent seed — nms_charging_plans (Mongo) saying a subscriber
        // is "on" a plan is bookkeeping only, not proof OCS's own Mnesia
        // actually has that link. See resyncChargingPlanAssignments()'s own
        // comment for the real, confirmed-live failure mode this closes.
        const planResync = await resyncChargingPlanAssignments(this.db, this.subscriberRepo);
        this.logger.info({ planResync }, 'ocs reapply: charging plan assignments resynced');
        // Real, 2026-09-24 finding: EnsurePlan's new skipped_conflict outcome
        // (see charging-plans-controller.ts's own comment) means these
        // specific IMSIs were deliberately left untouched rather than
        // silently collapsed — surfaced loudly here (not just folded into
        // the info-level summary above) since this is exactly the kind of
        // "needs manual review" signal that's easy to miss in a routine
        // restore log.
        if (planResync.conflicted > 0) {
          this.logger.warn(
            { conflictedImsis: planResync.conflictedImsis },
            `ocs reapply: ${planResync.conflicted} subscriber(s) skipped during charging-plan resync — an identity has a real, non-empty OCS balance on a DIFFERENT product than expected (likely managed directly via OCS's own web GUI). Review manually; nothing was deleted.`,
          );
        }
      }));
    }

    // IMS next — MMS/PSTN/VectorCore SMSC's own Configure hard-require it.
    if (exists('/etc/open5gs/.ims-config.json')) {
      const cfg = readCurrentImsConfig();
      results.push(await this.step('ims', 'IMS / VoLTE', cfg == null, async () => {
        await configureIms(cfg!);
        const sync = await syncImsSubscribers(this.subscriberRepo, this.logger);
        this.logger.info({ sync }, 'ims reapply: subscribers synced to PyHSS');
      }));
    }

    const smsCfg = readCurrentSmsConfig();
    if (smsCfg) {
      results.push(await this.step('smsOverSgs', 'SMS over SGs', false, async () => {
        await configureSms(smsCfg);
        // Real, 2026-09-24 finding: osmo-msc.cfg/osmo-stp.cfg are raw-copied
        // by the restore's own earlier file-restore phase (EXTRA_BACKUP_FILES)
        // BEFORE this reapply step ever runs. configureSms()'s own
        // change-diff restart logic (correct for the interactive Configure
        // button, where nothing else touched the file first) can never
        // detect this here — it compares the just-restored file against
        // itself and finds no further change, so osmo-msc/osmo-stp keep
        // serving whatever config they had loaded before the restore.
        // Confirmed live on both hosts: osmo-msc/osmo-stp had been running
        // unrestarted for 5-11+ days despite newer config already on disk.
        // Unlike the interactive path, we're unconditionally inside the
        // restore-reapply flow here, so an unconditional restart — matching
        // how the core-configs/suci-keys step unconditionally restarts all
        // 17 core NFs regardless of diff — is correct and safe.
        const mscRestart = await this.hostExecutor.restartService('osmo-msc');
        if (mscRestart.exitCode !== 0) throw new Error(`osmo-msc restart failed: ${mscRestart.stderr || mscRestart.exitCode}`);
        const stpRestart = await this.hostExecutor.restartService('osmo-stp');
        if (stpRestart.exitCode !== 0) throw new Error(`osmo-stp restart failed: ${stpRestart.stderr || stpRestart.exitCode}`);
        const sync = await syncHlrSubscribers(this.subscriberRepo, this.logger);
        this.logger.info({ sync }, 'sms reapply: subscribers synced to OsmoHLR');
      }));
    }

    if (exists('/etc/osmocom/.nms-gsm-bts-state.json')) {
      const state = loadGsmState();
      const hasBts = !!(state?.btsEntries?.length);
      // forceGprsReapply: true — see ConfigureGsmInput's own comment
      // (gsm-controller.ts). Without it, a restored appliedGprsEigrpCidr/
      // appliedGprsNatCidr already matches the freshly-computed desired
      // value (same source JSON), so the diff-check inside configureGsm()
      // sees "no change" and never actually re-pushes the EIGRP route/NAT
      // rule onto the target's live dataplane.
      results.push(await this.step('gsm', '2G GSM', !hasBts, async () => { await configureGsm({ forceGprsReapply: true }); }));

      // Real, 2026-09-24 finding: GSM's own SIP tab (osmo-sip-connector) had
      // no reapply step of its own at all — see configureGsmSip()'s own
      // comment (gsm-controller.ts). Gated on state.sip?.remoteHost being
      // set (the same "is there actually something to reapply" check
      // configureGsmSip() itself requires) rather than hasBts, since a SIP
      // tab configuration is independent of whether any BTS entries exist.
      if (state?.sip?.remoteHost) {
        results.push(await this.step('gsmSip', '2G GSM SIP tab', false, async () => {
          const r = await configureGsmSip({});
          if (!r.success) throw new Error(r.error);
        }));
      }
    }

    if (exists('/etc/open5gs/.asterisk2g-config.json')) {
      results.push(await this.step('asterisk2g', 'Asterisk-2G', false, async () => {
        // Real, 2026-09-24 finding: configureAsterisk2g() returns
        // {success:false, error} on every failure path rather than throwing
        // — an unchecked await here previously reported this step as
        // successful even when Configure genuinely failed (e.g. GSM's SIP
        // tab not ready, an nsenter/systemctl error), masking exactly the
        // kind of "success:true but a sub-step actually failed" gap
        // CLAUDE.md's own "verify, don't trust success" convention warns
        // about — including whether Cross-RAN Calling's own reapply (inside
        // this same function) actually took effect.
        // Real, 2026-09-24 finding: configureAsterisk2g() unconditionally
        // forces MNCC to 'external' every call (wireIntoSipTabAndGoExternal()
        // — correct behavior for the interactive Configure button, "it's the
        // one thing this module exists to do"). But if an operator later
        // deliberately flipped MNCC back to 'internal' via the GSM SIP tab
        // (a legitimate, exposed action), this restore-reapply step running
        // the full configureAsterisk2g() again would silently re-force
        // 'external' with no operator request — a restore-specific
        // divergence from the source host's actual last state. Capture the
        // mode before, restore it after if it was deliberately 'internal'.
        // The real invariant this depends on: getMscMnccMode() reads the
        // `mncc` line straight off disk (sms-controller.ts), which the
        // restore's raw-file-copy phase already wrote BEFORE
        // reapplyOptionalModules() ever runs — so this correctly reflects
        // the backed-up value regardless of this step's position relative
        // to smsOverSgs/gsm (verified: sms-controller.ts's mscOwned
        // directive array deliberately does NOT include `mncc`, treating it
        // as unmanaged/opaque — if that ever changes, this call would need
        // re-checking, independent of step order).
        const mnccModeBefore = getMscMnccMode();
        const r = await configureAsterisk2g({}, this.mongoUri, this.subscriberRepo);
        if (!r.success) throw new Error(r.error);
        if (mnccModeBefore === 'internal') {
          await setMscMnccMode('internal', MNCC_SOCKET_PATH).catch(() => {});
        }
      }));
    }

    if (exists('/etc/osmocom/.nms-hnbgw-state.json')) {
      const state = loadHnbgwState();
      results.push(await this.step('hnbgw', '3G UMTS (HNBGW)', !state, async () => {
        // Same "verify, don't trust success" fix as asterisk2g above —
        // configureHnbgw() has one graceful {success:false} return path
        // (missing SGSN precondition) that an unchecked await previously
        // let through as a reported success.
        const r = await configureHnbgw({});
        if (!r.success) throw new Error(r.error);
      }));
    }

    if (exists('/etc/open5gs-nms/.vowifi-state.json')) {
      const state = loadVowifiState();
      const ready = !!(state.epdgIp && state.aaaListenIp && state.epdgInterfaceMode);
      results.push(await this.step('vowifi', 'VoWiFi', !ready, async () => {
        try {
          await configureVowifi({ epdgIp: state.epdgIp!, aaaListenIp: state.aaaListenIp!, interfaceMode: state.epdgInterfaceMode! });
        } catch (err) {
          throw err instanceof VowifiConfigureError ? new Error(err.message) : err;
        }
      }));
    }

    // secgw is intentionally NOT reapplied here — it now runs from
    // runRestart()'s `has('secgw-pki')` block (see the 2026-09-24 comment on
    // regenerateSecgwRadioConfs() above) so it fires whenever secgw-pki is
    // restored, independent of whether optional-modules is also selected.

    if (exists('/etc/open5gs/.mms-config.json')) {
      const saved = readMmsState();
      results.push(await this.step('mms', 'MMS', !saved?.mm1PublicIp, async () => {
        const r = await configureMms({ mm1PublicIp: saved!.mm1PublicIp }, this.subscriberRepo);
        if (!r.success) throw new Error(r.error);
        const sync = await syncMmsSubscribers(this.subscriberRepo, this.logger);
        this.logger.info({ sync }, 'mms reapply: subscribers synced to VectorCore');
      }));
    }

    if (exists('/etc/open5gs/.pstn-config.json')) {
      const saved = readPstnState();
      results.push(await this.step('pstn', 'PSTN Gateway', !saved, async () => {
        const r = await configurePstn({ asteriskIp: saved?.asteriskIp ?? '', echoTestNumber: saved?.echoTestNumber }, this.mongoUri, this.subscriberRepo, this.hostExecutor);
        if (!r.success) throw new Error(r.error);
        // configurePstn() only (re)writes the base pjsip/dialplan shape —
        // it never regenerates the External SIP Trunk or Cross-RAN Calling
        // peer sections of pjsip_pstn.conf. Real, confirmed-live gap
        // (2026-09-23): a restored host's .pstn-config.json still had
        // externalTrunk's settings verbatim, but the live pjsip_pstn.conf
        // on disk never got them written back — "External SIP Trunk is
        // missing its config" after every restore. applyExternalTrunkChange()
        // is the one function that regenerates the FULL file (cross-RAN peer
        // + external trunk together) from saved state and is already safe to
        // call unconditionally — it correctly omits the trunk block and
        // tears down its firewall rule when externalTrunk is absent/disabled,
        // this isn't an "only if configured" action. Requires IMS already
        // configured (readImsState() throws otherwise) — guaranteed by the
        // IMS reapply step running earlier in this same function.
        await applyExternalTrunkChange(this.mongoUri, this.subscriberRepo, this.hostExecutor);
      }));
    }

    if (exists('/etc/open5gs/.vectorcore-smsc-config.json')) {
      results.push(await this.step('vectorcoreSmsc', 'SMS (VectorCore SMSC)', false, async () => {
        const r = await configureVectorcoreSmsc();
        if (!r.success) throw new Error(r.error);
      }));
    }

    if (exists('/etc/open5gs/.twamp-config.json')) {
      const saved = readTwampState();
      results.push(await this.step('twamp', 'TWAMP', false, async () => {
        const r = await configureTwampServer({
          listenIp: saved?.server?.listenIp, listenPort: saved?.server?.listenPort,
          enableFull: saved?.server?.enableFull, enableLight: saved?.server?.enableLight,
          modes: saved?.server?.modes, secretKeyId: saved?.server?.secretKeyId,
          secretValue: saved?.server?.secretValue, allowCidrs: saved?.server?.allowCidrs,
        }, this.hostExecutor);
        if (!r.success) throw new Error(r.error);
        // Real gap found 2026-10-02 (API regression suite critic audit):
        // the restored .twamp-config.json's history.retentionDays reaches
        // disk and readTwampState()/the Settings UI both read it back
        // correctly, but the actual MongoDB TTL index expiry
        // (ensureHistoryIndexes, same pattern CLAUDE.md already documents
        // for CDR below) is only ever (re)applied at backend boot or from
        // the interactive settings-save route — nothing in restore re-runs
        // it. Self-heals today only because the `auth` category's restore
        // happens to trigger a full backend restart; a restore of every
        // OTHER category without `auth` would silently leave the TTL index
        // at whatever the fresh boot's own default set, even though the
        // UI shows the source host's real retention value.
        if (saved?.history?.retentionDays) {
          await ensureHistoryIndexes(this.db, saved.history.retentionDays);
        }
      }));
    }

    // Syslog is a direct-file case (the drop-in conf IS the state — no JSON
    // side-file) EXCEPT that a fresh host also needs the frr-group/AppArmor
    // side effects configureSyslog() applies reapplied, which a bare
    // restart would skip — always go through configureSyslog(), recovering
    // the target from the just-restored file itself via parseTarget().
    const syslogConfPath = '/etc/rsyslog.d/71-open5gs-nms-forward.conf';
    if (exists(syslogConfPath)) {
      const target = parseTarget(fs.readFileSync(PROC(syslogConfPath), 'utf-8'));
      results.push(await this.step('syslog', 'Syslog Forwarding', !target, async () => {
        const r = await configureSyslog(target!);
        if (!r.success) throw new Error(r.error);
      }));
    }

    // CDR retention is a direct-file case (.cdr-settings.json IS the state,
    // no Configure step — no install lifecycle of its own at all, it just
    // governs the always-running nms_cdr TTL index) — but the TTL index
    // itself is a SEPARATE piece of live MongoDB state from the file.
    // Real gap found 2026-10-02 (API regression suite critic audit):
    // ensureCdrIndexes() (the only thing that actually moves the live TTL
    // expiry) runs solely at backend boot or from the interactive
    // settings-save route — restore never called it, so a restore of every
    // category except `auth` (whose own restore happens to force a full
    // backend restart today) would leave the index at whatever the fresh
    // boot's 180-day default set, even though the just-restored file and
    // the Settings UI both show the source host's real value. Exactly the
    // "config says X, enforcement does Y" mismatch CLAUDE.md already
    // documents for this same file's very first-ever bug.
    if (exists('/etc/open5gs/.cdr-settings.json')) {
      const { retentionDays } = readCdrSettings();
      results.push(await this.step('cdr', 'Call History (CDR) retention', false, async () => {
        await ensureCdrIndexes(this.db, retentionDays);
      }));
    }

    // chrony.conf is a direct-file case, no source-of-truth Configure step —
    // just needs the daemon restarted to pick up the restored file.
    if (exists('/etc/chrony/chrony.conf')) {
      results.push(await this.restartUnit('chrony', 'Time Server (chrony)'));
    }

    return results;
  }

  private async step(id: string, label: string, skip: boolean, fn: () => Promise<void>): Promise<RestartStepResult> {
    if (skip) return { step: id, label, success: true, skipped: true, error: 'No saved config on record to reapply' };
    try {
      await fn();
      return { step: id, label, success: true, skipped: false };
    } catch (err) {
      return { step: id, label, success: false, skipped: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
