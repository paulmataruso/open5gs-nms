import pino from 'pino';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { SERVICE_UNIT_MAP } from '../../domain/entities/service-status';
import { DnsMigrationUseCase } from './dns-migration-usecase';
import { deriveImsDomain, deriveEpcDomain, derivePubEpdgDomain } from '../../domain/services/read-plmn';
import { CrossServiceValidator } from '../../domain/services/cross-service-validator';
import { configureIms, readCurrentImsConfig } from '../../interfaces/rest/ims-controller';
import { configureSms, readCurrentSmsConfig } from '../../interfaces/rest/sms-controller';
import {
  configureVowifi, loadState as loadVowifiState, VowifiConfigureError,
} from '../../interfaces/rest/vowifi-controller';

// ─── Host paths ───────────────────────────────────────────────────────────────
const OPEN5GS_DIR   = '/etc/open5gs';
const BACKUP_ROOT    = '/etc/open5gs/backups/plmn-migration';
const STATE_FILE     = '/etc/open5gs/backups/plmn-migration/state.json';
// IMS/VoWiFi persist their own module state outside /etc/open5gs/*.yaml —
// dns-migration/config-repo backups never touch these, so this use-case's own
// backup/restore has to handle them itself.
const IMS_STATE_FILE    = '/proc/1/root/etc/open5gs/.ims-config.json';
const VOWIFI_STATE_FILE = '/proc/1/root/etc/open5gs-nms/.vowifi-state.json';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlmnMigrationPlan {
  oldMcc: string; oldMnc: string;
  newMcc: string; newMnc: string;
  oldImsDomain: string; newImsDomain: string;
  oldPubDomain: string; newPubDomain: string;
  imsInstalled: boolean;
  smsConfigured: boolean;
  vowifiInstalled: boolean;
  warnings: string[];
}

export interface PhaseResult {
  phase: 'plan' | 'A' | 'B' | 'C' | 'D' | 'E';
  success: boolean;
  details: string[];
  error?: string;
}

export interface MigrationBackupInfo {
  backupId: string;
  configBackupDir: string;
  extraFiles: string[];
}

// Persisted at backup time — the only place old/new mcc/mnc survive across the
// separate HTTP calls each phase is invoked through (Phase D needs to know the
// OLD PLMN — to clean up VoWiFi's stale pub zone and SMS's stale sgsap map entry
// — but by the time Phase D runs, mme.yaml already has the NEW plmn_id written by
// Phase A, so it can no longer be read back from live config).
interface MigrationState {
  oldMcc: string; oldMnc: string;
  newMcc: string; newMnc: string;
}

// 3-digit MCC, 2-or-3-digit MNC — same convention as auto-config.ts's own input
// validation, just re-declared here since that validation isn't itself exported.
const PLMN_RE = /^\d{3}$/;
const MNC_RE = /^\d{2,3}$/;

export class PlmnMigrationUseCase {
  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly configRepo: IConfigRepository,
    private readonly dnsMigrationUseCase: DnsMigrationUseCase,
    private readonly auditLogger: IAuditLogger,
    private readonly logger: pino.Logger,
  ) {}

  // ── Shared helpers ────────────────────────────────────────────────────────

  private async readCurrentMccMnc(): Promise<{ mcc: string; mnc: string }> {
    try {
      const raw = await this.hostExecutor.readFile(`${OPEN5GS_DIR}/mme.yaml`);
      const mccM = raw.match(/mcc:\s*['"]?(\d+)['"]?/);
      const mncM = raw.match(/mnc:\s*['"]?(\d+)['"]?/);
      return { mcc: mccM?.[1] ?? '001', mnc: mncM?.[1] ?? '01' };
    } catch {
      return { mcc: '001', mnc: '01' };
    }
  }

  private async readMigrationState(): Promise<MigrationState | null> {
    try {
      const raw = await this.hostExecutor.readFile(STATE_FILE);
      return JSON.parse(raw) as MigrationState;
    } catch {
      return null;
    }
  }

  private async writeMigrationState(state: MigrationState): Promise<void> {
    await this.hostExecutor.createDirectory(BACKUP_ROOT);
    await this.hostExecutor.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  }

  // Replaces plmn_id.mcc/mnc on every entry of an array field, preserving every
  // other field on each entry (mme_gid/mme_code/tac/etc) — this is the "simple
  // replace whatever primary PLMN is currently configured" semantics the user
  // chose, deliberately NOT trying to match/merge by old value like SMS's own
  // sgsap mergeMapEntry() does, since there's normally exactly one entry.
  private replacePlmnId<T extends { plmn_id?: { mcc?: string; mnc?: string } }>(
    entries: T[] | undefined, mcc: string, mnc: string,
  ): T[] {
    return (entries ?? []).map(e => ({ ...e, plmn_id: { ...(e.plmn_id ?? {}), mcc, mnc } }));
  }

  // ── Phase "plan" — dry-run diff, writes nothing ──────────────────────────

  async computeMigrationPlan(newMcc: string, newMnc: string): Promise<PlmnMigrationPlan> {
    if (!PLMN_RE.test(newMcc)) throw new Error(`Invalid MCC "${newMcc}" — must be exactly 3 digits`);
    if (!MNC_RE.test(newMnc)) throw new Error(`Invalid MNC "${newMnc}" — must be 2 or 3 digits`);

    const { mcc: oldMcc, mnc: oldMnc } = await this.readCurrentMccMnc();
    const warnings: string[] = [
      'SAS/CBRS is entirely out of scope — no code path there references mcc/mnc/plmn.',
      'Radio/TR-069 PLMN broadcast (Baicells/Sercomm) is NOT reprovisioned by this wizard — reprovision radios yourself afterward if they broadcast the PLMN.',
      'Subscriber IMSI/Ki records are untouched. SMS\'s sgsap map entry and IMS\'s PyHSS routing config are "subscriber-adjacent" — they affect how the network routes to existing subscribers under the new PLMN, without touching subscriber records themselves.',
    ];

    if (oldMcc === newMcc && oldMnc === newMnc) {
      warnings.push(`Target PLMN (${newMcc}/${newMnc}) is identical to the current one — every phase will be a no-op re-apply, not a real migration.`);
    }

    const imsConfig = readCurrentImsConfig();
    const smsConfig = readCurrentSmsConfig();
    const vowifiState = loadVowifiState();

    if (!imsConfig) warnings.push('IMS is not configured on this host — Phase D will skip it.');
    if (!smsConfig) warnings.push('SMS (SGs) is not configured on this host — Phase D will skip it.');
    if (vowifiState.installStatus !== 'complete') warnings.push('VoWiFi is not installed on this host — Phase D will skip it.');
    else if (!vowifiState.configured) warnings.push('VoWiFi is installed but not yet configured — Phase D will skip it.');

    return {
      oldMcc, oldMnc, newMcc, newMnc,
      oldImsDomain: deriveImsDomain(oldMcc, oldMnc), newImsDomain: deriveImsDomain(newMcc, newMnc),
      oldPubDomain: derivePubEpdgDomain(oldMcc, oldMnc), newPubDomain: derivePubEpdgDomain(newMcc, newMnc),
      imsInstalled: !!imsConfig, smsConfigured: !!smsConfig, vowifiInstalled: vowifiState.installStatus === 'complete' && vowifiState.configured,
      warnings,
    };
  }

  // ── Backup — delegates the 17 NF yaml + freeDiameter + BIND snapshot to the
  // proven DNS migration backup, and additionally snapshots IMS/VoWiFi's own
  // module state files (which that backup has no reason to know about), plus
  // persists old/new mcc/mnc so later phases (run via separate HTTP calls) can
  // still recover the OLD PLMN after Phase A has already overwritten mme.yaml.

  async createMigrationBackup(plan: PlmnMigrationPlan): Promise<MigrationBackupInfo> {
    const dnsBackup = await this.dnsMigrationUseCase.createMigrationBackup();
    const backupDir = dnsBackup.configBackupDir.replace(/\/config$/, '');

    const extraFiles: string[] = [];
    if (await this.hostExecutor.fileExists(IMS_STATE_FILE)) {
      await this.hostExecutor.copyFile(IMS_STATE_FILE, `${backupDir}/.ims-config.json`);
      extraFiles.push('.ims-config.json');
    }
    if (await this.hostExecutor.fileExists(VOWIFI_STATE_FILE)) {
      await this.hostExecutor.copyFile(VOWIFI_STATE_FILE, `${backupDir}/.vowifi-state.json`);
      extraFiles.push('.vowifi-state.json');
    }

    await this.writeMigrationState({ oldMcc: plan.oldMcc, oldMnc: plan.oldMnc, newMcc: plan.newMcc, newMnc: plan.newMnc });

    await this.auditLogger.log({
      action: 'plmn_migration_backup', user: 'admin',
      details: `backupId=${dnsBackup.backupId} ${plan.oldMcc}/${plan.oldMnc} -> ${plan.newMcc}/${plan.newMnc}`,
      success: true,
    });

    return { backupId: dnsBackup.backupId, configBackupDir: dnsBackup.configBackupDir, extraFiles };
  }

  // ── Phase A — write mme/smf/amf's raw plmn_id fields (zero restarts, pure
  // file writes — safe to fully reverse from backup), THEN delegate DNS (5gc +
  // epc zones) to the proven DnsMigrationUseCase, which now sees the new PLMN
  // since it re-reads mme.yaml fresh. Writing plmn_id here rather than "bundled
  // into Phase B/C" (as first sketched) is deliberate: DnsMigrationUseCase's own
  // computeMigrationPlan() derives sgcDomain/epcDomain by reading mme.yaml at
  // call time, so the rewrite MUST land before that read happens or Phase A
  // would generate zones for the OLD PLMN. The actual service restarts for
  // mme/amf/smf still happen at their normal Phase B/C point — one restart per
  // NF, not two. ──────────────────────────────────────────────────────────────

  async applyPhaseA(plan: PlmnMigrationPlan): Promise<PhaseResult> {
    const details: string[] = [];
    try {
      const mmeConfig = await this.configRepo.loadMme();
      const mmeRaw = mmeConfig.rawYaml as any;
      if (mmeRaw?.mme) {
        mmeRaw.mme.gummei = this.replacePlmnId(mmeRaw.mme.gummei, plan.newMcc, plan.newMnc);
        mmeRaw.mme.tai = this.replacePlmnId(mmeRaw.mme.tai, plan.newMcc, plan.newMnc);
        await this.configRepo.saveMme({ rawYaml: mmeRaw } as any);
        details.push(`Rewrote mme.yaml: gummei/tai plmn_id -> ${plan.newMcc}/${plan.newMnc}`);
      }

      const amfConfig = await this.configRepo.loadAmf();
      const amfRaw = amfConfig.rawYaml as any;
      if (amfRaw?.amf) {
        amfRaw.amf.guami = this.replacePlmnId(amfRaw.amf.guami, plan.newMcc, plan.newMnc);
        amfRaw.amf.tai = this.replacePlmnId(amfRaw.amf.tai, plan.newMcc, plan.newMnc);
        amfRaw.amf.plmn_support = this.replacePlmnId(amfRaw.amf.plmn_support, plan.newMcc, plan.newMnc);
        await this.configRepo.saveAmf({ rawYaml: amfRaw } as any);
        details.push(`Rewrote amf.yaml: guami/tai/plmn_support plmn_id -> ${plan.newMcc}/${plan.newMnc}`);
      }

      // SMF's plmn_id is optional (info[].tai[].plmn_id) — only present if the
      // operator previously configured per-TAI slice selection. Update in place
      // if found, add nothing if absent (per the decided default: no separate
      // manual-step branch for this).
      const smfConfig = await this.configRepo.loadSmf();
      const smfRaw = smfConfig.rawYaml as any;
      let smfPlmnUpdated = false;
      for (const infoEntry of (smfRaw?.smf?.info ?? [])) {
        for (const taiEntry of (infoEntry?.tai ?? [])) {
          if (taiEntry?.plmn_id) {
            taiEntry.plmn_id.mcc = plan.newMcc;
            taiEntry.plmn_id.mnc = plan.newMnc;
            smfPlmnUpdated = true;
          }
        }
      }
      if (smfPlmnUpdated) {
        await this.configRepo.saveSmf({ rawYaml: smfRaw } as any);
        details.push(`Rewrote smf.yaml: info[].tai[].plmn_id -> ${plan.newMcc}/${plan.newMnc}`);
      } else {
        details.push('smf.yaml has no info[].tai[].plmn_id block configured — left untouched (nothing to migrate)');
      }

      const dnsPlan = await this.dnsMigrationUseCase.computeMigrationPlan();
      const dnsResult = await this.dnsMigrationUseCase.applyPhaseA(dnsPlan);
      details.push(...dnsResult.details);
      if (!dnsResult.success) throw new Error(dnsResult.error ?? 'DNS phase A failed');

      await this.auditLogger.log({ action: 'plmn_migration_phase_a', user: 'admin', details: details.join('; '), success: true });
      return { phase: 'A', success: true, details };
    } catch (err) {
      const error = String(err);
      this.logger.error({ err: error }, 'plmn-migration: Phase A failed');
      await this.auditLogger.log({ action: 'plmn_migration_phase_a', user: 'admin', details: error, success: false });
      return { phase: 'A', success: false, details, error };
    }
  }

  // ── Phase B — EPC/Diameter mesh (freeDiameter Identity/Realm/ConnectPeer for
  // mme/hss/pcrf/smf), reusing DnsMigrationUseCase's proven applyPhaseB verbatim.
  // Restarting mme/smf here also picks up Phase A's already-written plmn_id —
  // one restart, not two. ────────────────────────────────────────────────────

  async applyPhaseB(_plan: PlmnMigrationPlan): Promise<PhaseResult> {
    const details: string[] = [];
    try {
      const dnsPlan = await this.dnsMigrationUseCase.computeMigrationPlan();
      const dnsResult = await this.dnsMigrationUseCase.applyPhaseB(dnsPlan);
      details.push(...dnsResult.details);
      if (!dnsResult.success) throw new Error(dnsResult.error ?? 'DNS phase B failed');

      await this.auditLogger.log({ action: 'plmn_migration_phase_b', user: 'admin', details: details.join('; '), success: true });
      return { phase: 'B', success: true, details };
    } catch (err) {
      const error = String(err);
      this.logger.error({ err: error }, 'plmn-migration: Phase B failed');
      await this.auditLogger.log({ action: 'plmn_migration_phase_b', user: 'admin', details: error, success: false });
      return { phase: 'B', success: false, details, error };
    }
  }

  // ── Phase C — 5GC SBI mesh (advertise/client-uri for 11 NFs), reusing
  // DnsMigrationUseCase's proven applyPhaseC verbatim. Restarting AMF here also
  // picks up Phase A's already-written guami/tai/plmn_support. ────────────────

  async applyPhaseC(_plan: PlmnMigrationPlan): Promise<PhaseResult> {
    const details: string[] = [];
    try {
      const dnsPlan = await this.dnsMigrationUseCase.computeMigrationPlan();
      const dnsResult = await this.dnsMigrationUseCase.applyPhaseC(dnsPlan);
      details.push(...dnsResult.details);
      if (!dnsResult.success) throw new Error(dnsResult.error ?? 'DNS phase C failed');

      await this.auditLogger.log({ action: 'plmn_migration_phase_c', user: 'admin', details: details.join('; '), success: true });
      return { phase: 'C', success: true, details };
    } catch (err) {
      const error = String(err);
      this.logger.error({ err: error }, 'plmn-migration: Phase C failed');
      await this.auditLogger.log({ action: 'plmn_migration_phase_c', user: 'admin', details: error, success: false });
      return { phase: 'C', success: false, details, error };
    }
  }

  // ── Phase D — Application layer, strict order: IMS -> SMS -> VoWiFi. Each
  // module is independently skippable-with-a-note if not installed, not an
  // error that blocks the rest. Reads the OLD PLMN from the state file written
  // at backup time, since mme.yaml no longer has it by this point. ───────────

  async applyPhaseD(plan: PlmnMigrationPlan): Promise<PhaseResult> {
    const details: string[] = [];
    try {
      const migrationState = await this.readMigrationState();
      const oldMcc = migrationState?.oldMcc ?? plan.oldMcc;
      const oldMnc = migrationState?.oldMnc ?? plan.oldMnc;

      // 1. IMS — safe to run any time, its own /configure-equivalent takes an
      // explicit mcc/mnc override and cleans up its own previous domain via
      // .ims-config.json's own persisted state (already fixed to cover a
      // primary-domain change, not just additionalPlmns removal).
      const imsConfig = readCurrentImsConfig();
      if (imsConfig) {
        const { imsDomain } = await configureIms({ ...imsConfig, mcc: plan.newMcc, mnc: plan.newMnc });
        details.push(`IMS reconfigured: ${imsDomain}`);
      } else {
        details.push('IMS not configured on this host — skipped');
      }

      // 2. SMS — has no override; always re-reads mme.yaml, so must run after
      // Phase A/B have already landed the new plmn_id. previousMcc/previousMnc
      // clean up the stale sgsap map entry for the old PLMN.
      const smsConfig = readCurrentSmsConfig();
      if (smsConfig) {
        const { mcc, mnc, tac } = await configureSms({ ...smsConfig, previousMcc: oldMcc, previousMnc: oldMnc });
        details.push(`SMS reconfigured: mcc=${mcc} mnc=${mnc} tac=${tac}`);
      } else {
        details.push('SMS not configured on this host — skipped');
      }

      // 3. VoWiFi — derives its S6b realm from smf.conf's freeDiameter Identity
      // (already updated by Phase B) and its pub-zone domain from mme.yaml
      // (already updated by Phase A) — both internally, no override needed.
      // previousPubDomain cleans up the stale mnc/mcc.pub BIND zone.
      const vowifiState = loadVowifiState();
      if (vowifiState.installStatus === 'complete' && vowifiState.configured &&
          vowifiState.epdgIp && vowifiState.epdgInterfaceMode && vowifiState.s6bLocalIp && vowifiState.gsupPort) {
        try {
          const result = await configureVowifi({
            epdgIp: vowifiState.epdgIp,
            s6bLocalIp: vowifiState.s6bLocalIp,
            gsupPort: vowifiState.gsupPort,
            interfaceMode: vowifiState.epdgInterfaceMode,
            previousPubDomain: plan.oldPubDomain !== plan.newPubDomain ? plan.oldPubDomain : undefined,
          });
          details.push(`VoWiFi reconfigured: aaaFqdn=${result.aaaFqdn} dnsConfigured=${result.dnsConfigured}`);
        } catch (err) {
          const msg = err instanceof VowifiConfigureError ? err.message : String(err);
          throw new Error(`VoWiFi reconfigure failed: ${msg}`);
        }
      } else {
        details.push('VoWiFi not installed/configured on this host — skipped');
      }

      await this.auditLogger.log({ action: 'plmn_migration_phase_d', user: 'admin', details: details.join('; '), success: true });
      return { phase: 'D', success: true, details };
    } catch (err) {
      const error = String(err);
      this.logger.error({ err: error }, 'plmn-migration: Phase D failed');
      await this.auditLogger.log({ action: 'plmn_migration_phase_d', user: 'admin', details: error, success: false });
      return { phase: 'D', success: false, details, error };
    }
  }

  // ── Phase E — verification only, no writes. ──────────────────────────────

  async applyPhaseE(plan: PlmnMigrationPlan): Promise<PhaseResult> {
    const details: string[] = [];
    let consistent = true;
    try {
      const allConfigs = await this.configRepo.loadAll();
      const expectedEpcDomain = deriveEpcDomain(plan.newMcc, plan.newMnc);

      // General cross-service checks (NRF/PFCP/slice/topology + the PLMN
      // cross-check extended in cross-service-validator.ts for this feature).
      const validation = new CrossServiceValidator().validate(allConfigs);
      for (const issue of validation.allIssues) {
        details.push(`[${issue.severity}] ${issue.field}: ${issue.message}`);
        if (issue.severity === 'error') consistent = false;
      }

      // mme/amf raw plmn_id fields
      const mmeRaw = (allConfigs.mme as any)?.rawYaml?.mme;
      const mmeOk = (mmeRaw?.gummei ?? []).every((g: any) => g?.plmn_id?.mcc === plan.newMcc && g?.plmn_id?.mnc === plan.newMnc);
      details.push(`mme.yaml gummei plmn_id: ${mmeOk ? 'OK' : 'MISMATCH'}`);
      if (!mmeOk) consistent = false;

      const amfPlmnSupport = allConfigs.amf.plmn_support ?? [];
      const amfOk = amfPlmnSupport.length > 0 && amfPlmnSupport.every(p => p.plmn_id.mcc === plan.newMcc && p.plmn_id.mnc === plan.newMnc);
      details.push(`amf.yaml plmn_support: ${amfOk ? 'OK' : 'MISMATCH'}`);
      if (!amfOk) consistent = false;

      // freeDiameter Identity for the EPC mesh — the real source of truth for
      // mme/hss/pcrf/smf's PLMN, since none of their yaml schemas carry it directly.
      for (const svc of ['mme', 'hss', 'pcrf', 'smf'] as const) {
        try {
          const raw = await this.hostExecutor.readFile(`/proc/1/root/etc/freeDiameter/${svc}.conf`);
          const identity = raw.match(/^Identity\s*=\s*"([^"]+)"/m)?.[1] ?? '';
          const ok = identity.endsWith(expectedEpcDomain);
          details.push(`${svc}.conf Identity: ${identity || '(none)'} ${ok ? '[OK]' : '[MISMATCH]'}`);
          if (!ok) consistent = false;
        } catch {
          details.push(`${svc}.conf: not found`);
        }
      }

      // IMS/VoWiFi — subscriber-adjacent modules, checked directly against their
      // own persisted state rather than AllConfigs (they're not part of the
      // 17-NF config schema).
      const imsConfig = readCurrentImsConfig();
      if (imsConfig) {
        const imsOk = imsConfig.mcc === plan.newMcc && imsConfig.mnc === plan.newMnc;
        details.push(`IMS config: mcc=${imsConfig.mcc} mnc=${imsConfig.mnc} ${imsOk ? '[OK]' : '[MISMATCH]'}`);
        if (!imsOk) consistent = false;
      }
      const vowifiState = loadVowifiState();
      if (vowifiState.configured && vowifiState.aaaFqdn) {
        const vowifiOk = vowifiState.aaaFqdn.endsWith(expectedEpcDomain);
        details.push(`VoWiFi aaaFqdn: ${vowifiState.aaaFqdn} ${vowifiOk ? '[OK]' : '[MISMATCH]'}`);
        if (!vowifiOk) consistent = false;
      }

      for (const svc of ['mme', 'hss', 'pcrf', 'amf', 'smf'] as const) {
        const unit = SERVICE_UNIT_MAP[svc];
        const active = await this.hostExecutor.isServiceActive(unit);
        details.push(`${unit}: ${active ? 'active' : 'INACTIVE'}`);
        if (!active) consistent = false;
      }

      await this.auditLogger.log({ action: 'plmn_migration_verify', user: 'admin', details: details.join('; '), success: consistent });
      return { phase: 'E', success: consistent, details, error: consistent ? undefined : 'One or more services report a PLMN mismatch or are inactive — see details' };
    } catch (err) {
      const error = String(err);
      this.logger.error({ err: error }, 'plmn-migration: Phase E failed');
      await this.auditLogger.log({ action: 'plmn_migration_verify', user: 'admin', details: error, success: false });
      return { phase: 'E', success: false, details, error };
    }
  }

  // ── Rollback — mirrors DnsMigrationUseCase.rollbackMigration, plus restoring
  // IMS/VoWiFi's own module state files and restarting their services too (the
  // DNS-only rollback never had to touch those). ──────────────────────────────

  async rollbackMigration(backupId: string): Promise<PhaseResult> {
    const details: string[] = [];
    try {
      const dnsResult = await this.dnsMigrationUseCase.rollbackMigration(backupId);
      details.push(...dnsResult.details);
      if (!dnsResult.success) throw new Error(dnsResult.error ?? 'DNS/core rollback failed');

      const backupDir = `/etc/open5gs/backups/dns-migration/${backupId}`;
      const imsBackup = `${backupDir}/.ims-config.json`;
      const vowifiBackup = `${backupDir}/.vowifi-state.json`;

      let imsRestored = false;
      if (await this.hostExecutor.fileExists(imsBackup)) {
        await this.hostExecutor.copyFile(imsBackup, IMS_STATE_FILE);
        details.push('Restored .ims-config.json');
        imsRestored = true;
      }
      let vowifiRestored = false;
      if (await this.hostExecutor.fileExists(vowifiBackup)) {
        await this.hostExecutor.copyFile(vowifiBackup, VOWIFI_STATE_FILE);
        details.push('Restored .vowifi-state.json');
        vowifiRestored = true;
      }

      // The rolled-back state files describe the OLD config — re-run each
      // module's own configure so its live Kamailio/PyHSS/osmo-epdg/BIND config
      // actually matches what the JSON now (again) says, rather than leaving
      // stale on-disk config from the migration attempt.
      if (imsRestored) {
        const imsConfig = readCurrentImsConfig();
        if (imsConfig) {
          const { imsDomain } = await configureIms(imsConfig);
          details.push(`IMS reconfigured from rolled-back state: ${imsDomain}`);
        }
      }
      const smsConfig = readCurrentSmsConfig();
      if (smsConfig) {
        const { mcc, mnc } = await configureSms(smsConfig);
        details.push(`SMS reconfigured from rolled-back state: mcc=${mcc} mnc=${mnc}`);
      }
      if (vowifiRestored) {
        const vowifiState = loadVowifiState();
        if (vowifiState.installStatus === 'complete' && vowifiState.configured &&
            vowifiState.epdgIp && vowifiState.epdgInterfaceMode && vowifiState.s6bLocalIp && vowifiState.gsupPort) {
          const result = await configureVowifi({
            epdgIp: vowifiState.epdgIp, s6bLocalIp: vowifiState.s6bLocalIp,
            gsupPort: vowifiState.gsupPort, interfaceMode: vowifiState.epdgInterfaceMode,
          });
          details.push(`VoWiFi reconfigured from rolled-back state: aaaFqdn=${result.aaaFqdn}`);
        }
      }

      await this.hostExecutor.createDirectory(BACKUP_ROOT).catch(() => {});
      await this.hostExecutor.writeFile(STATE_FILE, JSON.stringify({}, null, 2)).catch(() => {});

      await this.auditLogger.log({ action: 'plmn_migration_rollback', user: 'admin', details: details.join('; '), success: true });
      return { phase: 'plan', success: true, details };
    } catch (err) {
      const error = String(err);
      this.logger.error({ err: error }, 'plmn-migration: rollback failed');
      await this.auditLogger.log({ action: 'plmn_migration_rollback', user: 'admin', details: error, success: false });
      return { phase: 'plan', success: false, details, error };
    }
  }
}
