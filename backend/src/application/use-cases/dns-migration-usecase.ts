import * as yaml from 'js-yaml';
import pino from 'pino';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { SERVICE_RESTART_ORDER, SERVICE_UNIT_MAP, ServiceName } from '../../domain/entities/service-status';

const OPEN5GS_DIR        = '/etc/open5gs';
const FREEDIAMETER_DIR   = '/proc/1/root/etc/freeDiameter';
const BIND_DIR           = '/proc/1/root/etc/bind';
const BIND_ZONES_DIR     = '/proc/1/root/etc/bind/zones';
// The plain (non-/proc/1/root) path — this is what goes inside named.conf.local's
// "file" directive. named itself runs natively on the host under an AppArmor profile
// that has no reason to understand /proc/1/root; that prefix only makes sense for
// this process's OWN file I/O (reaching the host's filesystem from inside the
// container). Confirmed live: using BIND_ZONES_DIR here caused named to log
// "loading from master file /proc/1/root/etc/bind/zones/....zone failed: permission
// denied" and refuse to load the zone at all, even though the file itself was fine.
const BIND_ZONES_DIR_HOST = '/etc/bind/zones';
const MIGRATION_BACKUP_ROOT = '/etc/open5gs/backups/dns-migration';
const MIGRATION_STATE_FILE  = '/etc/open5gs/backups/dns-migration/state.json';

// All NFs that get a DNS A record in the 5gc SBI-mesh zone (NRF is the hub itself).
// sepp1's LOCAL sbi.server/client (to our own SCP/NRF) belongs here just like any
// other NF — only its N32 interface (to the visited PLMN's SEPP) is out of scope,
// see the note below.
const SGC_ZONE_SERVICES = ['nrf', 'scp', 'amf', 'smf', 'ausf', 'udm', 'udr', 'pcf', 'bsf', 'nssf', 'sepp1'] as const;
// NFs whose client.nrf/client.scp (or client.nsi for nssf) URI gets rewritten to FQDN.
const SBI_CLIENT_SERVICES = ['scp', 'amf', 'smf', 'ausf', 'udm', 'udr', 'pcf', 'bsf', 'nssf', 'sepp1'] as const;
// Core EPC Diameter mesh — freeDiameter .conf files that reference each other directly.
const EPC_CONF_SERVICES = ['mme', 'hss', 'pcrf', 'smf'] as const;

type EpcConfService = typeof EPC_CONF_SERVICES[number];

const SAVE_METHOD: Record<typeof SGC_ZONE_SERVICES[number], keyof IConfigRepository> = {
  nrf: 'saveNrf', scp: 'saveScp', amf: 'saveAmf', smf: 'saveSmf', ausf: 'saveAusf',
  udm: 'saveUdm', udr: 'saveUdr', pcf: 'savePcf', bsf: 'saveBsf', nssf: 'saveNssf',
  sepp1: 'saveSepp1',
};
const LOAD_METHOD: Record<typeof SGC_ZONE_SERVICES[number], keyof IConfigRepository> = {
  nrf: 'loadNrf', scp: 'loadScp', amf: 'loadAmf', smf: 'loadSmf', ausf: 'loadAusf',
  udm: 'loadUdm', udr: 'loadUdr', pcf: 'loadPcf', bsf: 'loadBsf', nssf: 'loadNssf',
  sepp1: 'loadSepp1',
};
// The config-repo service name (matches the .yaml filename, e.g. sepp1.yaml — chosen
// to match the pre-existing systemd unit's ExecStart) doesn't always match the file's
// own top-level YAML key. Every other NF's filename and top-level key are identical;
// SEPP is the one exception (file: sepp1.yaml, top-level key: "sepp", matching
// upstream open5gs's own tutorial example configs). Use this wherever drilling into
// or patching the parsed/rawYaml object — never use the service name directly there.
const YAML_KEY: Partial<Record<typeof SGC_ZONE_SERVICES[number], string>> = { sepp1: 'sepp' };
const yamlKeyFor = (svc: string): string => (YAML_KEY as Record<string, string>)[svc] ?? svc;

export interface DnsEntry { fqdn: string; ip: string; zone: '5gc' | 'epc'; }
export interface SbiChange { service: string; field: string; oldUri: string; newUri: string; }
export interface AdvertiseChange { service: string; oldAdvertise: string | null; newAdvertise: string; }
export interface FreeDiameterPeerChange { peer: string; identityOld: string; identityNew: string; droppedConnectTo: string | null; }
export interface FreeDiameterChange {
  file: string;
  identityOld: string; identityNew: string;
  realmOld: string; realmNew: string;
  peers: FreeDiameterPeerChange[];
}

export interface DnsMigrationPlan {
  mcc: string; mnc: string;
  sgcDomain: string; epcDomain: string;
  dnsEntries: DnsEntry[];
  freeDiameterChanges: FreeDiameterChange[];
  sbiChanges: SbiChange[];
  advertiseChanges: AdvertiseChange[];
  warnings: string[];
}

export interface PhaseResult {
  phase: 'A' | 'B' | 'C';
  success: boolean;
  details: string[];
  error?: string;
}

export interface MigrationBackupInfo {
  backupId: string;
  configBackupDir: string;
  freeDiameterFiles: string[];
  bindFiles: string[];
}

// Persisted after every successful Phase A — the only place the real IPs behind
// mme/hss/pcrf/smf's Diameter ConnectPeer entries are known. Once Phase B drops
// ConnectTo (relying on DNS instead), those IPs no longer appear anywhere in the
// freeDiameter confs themselves — this state file is what lets a later PLMN change
// re-derive the DNS record without re-deriving from an IP that's no longer there.
interface MigrationState {
  sgcDomain: string;
  epcDomain: string;
  peerIps: Partial<Record<EpcConfService, string>>;
}

export class DnsMigrationUseCase {
  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly configRepo: IConfigRepository,
    private readonly auditLogger: IAuditLogger,
    private readonly logger: pino.Logger,
  ) {}

  // ── Shared helpers ────────────────────────────────────────────────────────

  private async readMccMnc(): Promise<{ mcc: string; mnc: string }> {
    try {
      const raw = await this.hostExecutor.readFile(`${OPEN5GS_DIR}/mme.yaml`);
      const mccM = raw.match(/mcc:\s*['"]?(\d+)['"]?/);
      const mncM = raw.match(/mnc:\s*['"]?(\d+)['"]?/);
      return { mcc: mccM?.[1] ?? '001', mnc: mncM?.[1] ?? '01' };
    } catch {
      return { mcc: '001', mnc: '01' };
    }
  }

  private deriveSgcDomain(mcc: string, mnc: string): string {
    return `5gc.mnc${mnc.padStart(3, '0')}.mcc${mcc}.3gppnetwork.org`;
  }

  private deriveEpcDomain(mcc: string, mnc: string): string {
    return `epc.mnc${mnc.padStart(3, '0')}.mcc${mcc}.3gppnetwork.org`;
  }

  private upsertNamedZone(raw: string, zoneName: string, zoneFilePath: string): string {
    const zoneBlock = `zone "${zoneName}" {\n    type master;\n    file "${zoneFilePath}";\n};\n`;
    if (raw.includes(`zone "${zoneName}"`)) {
      const zoneRe = new RegExp(`zone\\s+"${zoneName.replace(/\./g, '\\.')}"\\s*\\{[^}]*\\};?\\s*`, 'g');
      return raw.replace(zoneRe, zoneBlock);
    }
    return raw.trimEnd() + '\n\n' + zoneBlock;
  }

  private removeNamedZone(raw: string, zoneName: string): string {
    const zoneRe = new RegExp(`zone\\s+"${zoneName.replace(/\./g, '\\.')}"\\s*\\{[^}]*\\};?\\s*`, 'g');
    return raw.replace(zoneRe, '');
  }

  private async readMigrationState(): Promise<MigrationState | null> {
    try {
      const raw = await this.hostExecutor.readFile(MIGRATION_STATE_FILE);
      return JSON.parse(raw) as MigrationState;
    } catch {
      return null;
    }
  }

  private async writeMigrationState(state: MigrationState): Promise<void> {
    await this.hostExecutor.createDirectory(MIGRATION_BACKUP_ROOT);
    await this.hostExecutor.writeFile(MIGRATION_STATE_FILE, JSON.stringify(state, null, 2));
  }

  // Real incident (2026-07-17): Phase A can make BIND answer every record perfectly
  // (confirmed via `dig @127.0.0.1`) while every NF still crash-loops at Phase C,
  // because `dig` talks DNS directly but getaddrinfo() — what every NF actually calls
  // to resolve its own advertise FQDN at startup — goes through /etc/resolv.conf. If
  // that still points at systemd-resolved's stub (127.0.0.53, the stock Ubuntu
  // default), BIND being perfectly healthy is irrelevant; it's never consulted. This
  // used to require a separate manual call to POST /api/bind/fix-resolver after Phase
  // A and before Phase C — folded in here so it can't be forgotten.
  private async ensureSystemResolverUsesBind(details: string[]): Promise<void> {
    const resolvConfPath = '/proc/1/root/etc/resolv.conf';
    let firstNameserver: string | undefined;
    try {
      const raw = await this.hostExecutor.readFile(resolvConfPath);
      firstNameserver = raw.match(/^nameserver\s+(\S+)/m)?.[1];
    } catch { /* doesn't exist yet — treat as needing a fix */ }

    if (firstNameserver === '127.0.0.1') {
      details.push('System resolver already routes through BIND (127.0.0.1) — no fix needed');
      return;
    }

    const resolvedConfPath = '/proc/1/root/etc/systemd/resolved.conf';
    if (await this.hostExecutor.fileExists(resolvedConfPath)) {
      let raw = await this.hostExecutor.readFile(resolvedConfPath);
      raw = /^#?DNSStubListener=/m.test(raw)
        ? raw.replace(/^#?DNSStubListener=.*/m, 'DNSStubListener=no')
        : raw.trimEnd() + '\nDNSStubListener=no\n';
      await this.hostExecutor.writeFile(resolvedConfPath, raw);
    }
    await this.hostExecutor.restartService('systemd-resolved').catch(() => {});

    // writeFile() writes to a temp path then rename()s over the target — rename()
    // replaces whatever directory entry is there (symlink or not) rather than
    // following it, so this safely swaps out the systemd-resolved symlink instead of
    // corrupting its stub file the way a naive open-and-truncate write would.
    await this.hostExecutor.writeFile(resolvConfPath, 'nameserver 127.0.0.1\n');
    details.push(`Fixed system resolver: /etc/resolv.conf was pointing at ${firstNameserver ?? '(unreadable)'}, now static "nameserver 127.0.0.1" with systemd-resolved's stub listener disabled`);
  }

  // ── Phase 1: dry-run diff, writes nothing ────────────────────────────────

  async computeMigrationPlan(): Promise<DnsMigrationPlan> {
    const { mcc, mnc } = await this.readMccMnc();
    const sgcDomain = this.deriveSgcDomain(mcc, mnc);
    const epcDomain = this.deriveEpcDomain(mcc, mnc);
    const dnsEntries: DnsEntry[] = [];
    const sbiChanges: SbiChange[] = [];
    const advertiseChanges: AdvertiseChange[] = [];
    const freeDiameterChanges: FreeDiameterChange[] = [];
    const warnings: string[] = [
      "SEPP1's LOCAL sbi.server/client (to our own SCP/NRF) IS migrated like any other NF. Its N32 interface (to the visited PLMN's SEPP) is NOT — that peer is the other operator's SEPP per roaming agreement, not something local NRF/DNS discovery resolves.",
      "GTP-C/GTP-U/S1AP/PFCP bearer-plane peer addresses (SGWC/SGWU/UPF/MME) stay as IPs — open5gs's yaml schema doesn't support hostnames there.",
      'Radios and IMS/VoWiFi are entirely out of scope for this migration — VoWiFi already derives its own FQDNs independently and needs no change.',
    ];

    // 5gc zone: read each NF's own sbi.server[0].address for the DNS A record,
    // and compute the "advertise" identity it should broadcast to NRF instead of
    // that raw address — this is what lets OTHER NFs doing dynamic discovery via
    // NRF/SCP resolve it by FQDN too, not just NFs with a static client.nrf/scp URI.
    for (const svc of SGC_ZONE_SERVICES) {
      try {
        const raw = await this.configRepo.getRawYaml(svc);
        const parsed = yaml.load(raw) as any;
        const server = parsed?.[yamlKeyFor(svc)]?.sbi?.server?.[0];
        const address = server?.address;
        if (address) dnsEntries.push({ fqdn: `${svc}.${sgcDomain}`, ip: address, zone: '5gc' });

        const port = server?.port ?? 7777;
        const newAdvertise = `${svc}.${sgcDomain}:${port}`;
        advertiseChanges.push({ service: svc, oldAdvertise: server?.advertise ?? null, newAdvertise });
      } catch (err) {
        this.logger.debug({ svc, err: String(err) }, 'dns-migration: could not read sbi.server address');
      }
    }

    // SBI client URIs that need rewriting to FQDN.
    for (const svc of SBI_CLIENT_SERVICES) {
      try {
        const raw = await this.configRepo.getRawYaml(svc);
        const parsed = yaml.load(raw) as any;
        const client = parsed?.[yamlKeyFor(svc)]?.sbi?.client;
        const nrfUri = client?.nrf?.[0]?.uri;
        if (nrfUri) sbiChanges.push({ service: svc, field: 'sbi.client.nrf[0].uri', oldUri: nrfUri, newUri: `http://nrf.${sgcDomain}:7777` });
        const scpUri = client?.scp?.[0]?.uri;
        if (scpUri) sbiChanges.push({ service: svc, field: 'sbi.client.scp[0].uri', oldUri: scpUri, newUri: `http://scp.${sgcDomain}:7777` });
        if (svc === 'nssf') {
          const nsiUri = client?.nsi?.[0]?.uri;
          if (nsiUri) sbiChanges.push({ service: svc, field: 'sbi.client.nsi[0].uri', oldUri: nsiUri, newUri: `http://nrf.${sgcDomain}:7777` });
        }
      } catch (err) {
        this.logger.debug({ svc, err: String(err) }, 'dns-migration: could not read sbi.client');
      }
    }

    // epc zone + freeDiameter core mesh (mme/hss/pcrf/smf reference each other directly).
    // Generalized to match a peer identity in ANY current form — the original
    // "X.localdomain" placeholder on a first-ever migration, or an already-FQDN
    // identity from a previous migration (e.g. after a prior PLMN change) — not just
    // the literal ".localdomain" suffix, so re-running this after the PLMN changes
    // again correctly detects what still needs updating instead of silently no-op'ing.
    const priorState = await this.readMigrationState();
    for (const svc of EPC_CONF_SERVICES) {
      try {
        const raw = await this.hostExecutor.readFile(`${FREEDIAMETER_DIR}/${svc}.conf`);
        const identityM = raw.match(/^Identity\s*=\s*"([^"]+)"/m);
        const realmM = raw.match(/^Realm\s*=\s*"([^"]+)"/m);
        const identityOld = identityM?.[1] ?? `${svc}.localdomain`;
        const realmOld = realmM?.[1] ?? 'localdomain';

        const peers: FreeDiameterPeerChange[] = [];
        const peerRe = /ConnectPeer\s*=\s*"([a-z0-9]+)\.([^"]+)"\s*\{([^}]*)\}/g;
        let m: RegExpExecArray | null;
        while ((m = peerRe.exec(raw)) !== null) {
          const peerName = m[1];
          if (!(EPC_CONF_SERVICES as readonly string[]).includes(peerName)) continue;

          const peerIdentityOld = `${peerName}.${m[2]}`;
          const connectToM = m[3].match(/ConnectTo\s*=\s*"([^"]+)"/);
          // First migration: IP comes straight from ConnectTo. Any migration after
          // that: ConnectTo is already gone, so fall back to the last-known IP
          // recorded in state by a previous successful Phase A.
          const ip = connectToM?.[1] ?? priorState?.peerIps?.[peerName as EpcConfService] ?? null;

          peers.push({
            peer: peerName,
            identityOld: peerIdentityOld,
            identityNew: `${peerName}.${epcDomain}`,
            droppedConnectTo: connectToM?.[1] ?? null,
          });
          if (ip && !dnsEntries.some(e => e.fqdn === `${peerName}.${epcDomain}`)) {
            dnsEntries.push({ fqdn: `${peerName}.${epcDomain}`, ip, zone: 'epc' });
          }
          if (!ip) {
            warnings.push(`No known IP for ${peerName} — ConnectTo already dropped and no prior migration state found. Its epc DNS record can't be generated; re-run after Phase A has recorded it once, or restore ConnectTo manually first.`);
          }
        }

        freeDiameterChanges.push({
          file: `${svc}.conf`,
          identityOld, identityNew: `${svc}.${epcDomain}`,
          realmOld, realmNew: epcDomain,
          peers,
        });
      } catch (err) {
        this.logger.debug({ svc, err: String(err) }, 'dns-migration: could not read freeDiameter conf');
      }
    }

    return { mcc, mnc, sgcDomain, epcDomain, dnsEntries, freeDiameterChanges, sbiChanges, advertiseChanges, warnings };
  }

  // ── Backup (supplementary — freeDiameter confs + BIND state aren't covered
  // by the existing config backup, which only knows about /etc/open5gs/*.yaml) ──

  async createMigrationBackup(): Promise<MigrationBackupInfo> {
    const backupId = `${Date.now()}`;
    const backupDir = `${MIGRATION_BACKUP_ROOT}/${backupId}`;
    const fdDir = `${backupDir}/freeDiameter`;
    const bindDir = `${backupDir}/bind`;

    await this.hostExecutor.createDirectory(fdDir);
    await this.hostExecutor.createDirectory(`${bindDir}/zones`);

    const freeDiameterFiles: string[] = [];
    for (const svc of EPC_CONF_SERVICES) {
      const src = `${FREEDIAMETER_DIR}/${svc}.conf`;
      if (await this.hostExecutor.fileExists(src)) {
        await this.hostExecutor.copyFile(src, `${fdDir}/${svc}.conf`);
        freeDiameterFiles.push(`${svc}.conf`);
      }
    }

    const bindFiles: string[] = [];
    const namedLocal = `${BIND_DIR}/named.conf.local`;
    if (await this.hostExecutor.fileExists(namedLocal)) {
      await this.hostExecutor.copyFile(namedLocal, `${bindDir}/named.conf.local`);
      bindFiles.push('named.conf.local');
    }

    // Snapshot the migration state file too — otherwise a rollback restores the old
    // named.conf.local/confs but leaves state.json pointing at the (rolled-back-from)
    // domains, confusing the next plan computation.
    if (await this.hostExecutor.fileExists(MIGRATION_STATE_FILE)) {
      await this.hostExecutor.copyFile(MIGRATION_STATE_FILE, `${backupDir}/state.json`);
    }

    // config (17 NF yaml) — reuse the existing per-file backup, same directory layout
    // BackupRestoreUseCase/YamlConfigRepository already uses, so restore can reuse it too.
    const configBackupDir = `${backupDir}/config`;
    await this.configRepo.backupAll(configBackupDir);

    this.logger.info({ backupId }, 'DNS migration backup created');
    return { backupId, configBackupDir, freeDiameterFiles, bindFiles };
  }

  async rollbackMigration(backupId: string): Promise<PhaseResult> {
    const details: string[] = [];
    const backupDir = `${MIGRATION_BACKUP_ROOT}/${backupId}`;
    try {
      if (!(await this.hostExecutor.fileExists(backupDir))) {
        throw new Error(`Backup ${backupId} not found`);
      }

      // Restore NF yaml
      await this.configRepo.restoreBackup(`${backupDir}/config`);
      details.push('Restored NF yaml config');

      // Restore freeDiameter confs
      for (const svc of EPC_CONF_SERVICES) {
        const src = `${backupDir}/freeDiameter/${svc}.conf`;
        if (await this.hostExecutor.fileExists(src)) {
          await this.hostExecutor.copyFile(src, `${FREEDIAMETER_DIR}/${svc}.conf`);
          details.push(`Restored ${svc}.conf`);
        }
      }

      // Restore BIND named.conf.local (leaves any newer zone files in place — harmless,
      // they just won't be referenced once named.conf.local is rolled back)
      const namedLocalBackup = `${backupDir}/bind/named.conf.local`;
      if (await this.hostExecutor.fileExists(namedLocalBackup)) {
        await this.hostExecutor.copyFile(namedLocalBackup, `${BIND_DIR}/named.conf.local`);
        details.push('Restored named.conf.local');
      }

      // Restore migration state so a future plan computation reflects the rolled-back
      // domains, not the migration that was just undone.
      const stateBackup = `${backupDir}/state.json`;
      if (await this.hostExecutor.fileExists(stateBackup)) {
        await this.hostExecutor.copyFile(stateBackup, MIGRATION_STATE_FILE);
        details.push('Restored migration state');
      }

      await this.hostExecutor.restartService('bind9').catch(() => {});
      details.push('Restarted bind9');

      // Restart every service touched by any phase, in dependency order
      for (const service of SERVICE_RESTART_ORDER) {
        await this.hostExecutor.restartService(SERVICE_UNIT_MAP[service]).catch(() => {});
      }
      details.push('Restarted all core services');

      await this.auditLogger.log({ action: 'dns_migration_rollback', user: 'admin', details: details.join('; '), success: true });
      return { phase: 'A', success: true, details };
    } catch (err) {
      const error = String(err);
      await this.auditLogger.log({ action: 'dns_migration_rollback', user: 'admin', details: error, success: false });
      return { phase: 'A', success: false, details, error };
    }
  }

  // ── Phase A — DNS only. Zero risk, touches no NF config. ─────────────────

  async applyPhaseA(plan: DnsMigrationPlan): Promise<PhaseResult> {
    const details: string[] = [];
    try {
      await this.hostExecutor.createDirectory(BIND_ZONES_DIR);

      // If a previous migration left different zones behind (e.g. the PLMN changed
      // since the last run), remove the stale ones — otherwise they linger orphaned
      // in named.conf.local/BIND_ZONES_DIR forever, referenced by nothing.
      const priorState = await this.readMigrationState();
      let namedLocalForCleanup = '';
      if (priorState && (priorState.sgcDomain !== plan.sgcDomain || priorState.epcDomain !== plan.epcDomain)) {
        try { namedLocalForCleanup = await this.hostExecutor.readFile(`${BIND_DIR}/named.conf.local`); } catch { /* nothing to clean */ }
        if (namedLocalForCleanup) {
          if (priorState.sgcDomain !== plan.sgcDomain) {
            namedLocalForCleanup = this.removeNamedZone(namedLocalForCleanup, priorState.sgcDomain);
            await this.hostExecutor.executeLocalCommand('rm', ['-f', `${BIND_ZONES_DIR}/${priorState.sgcDomain}.zone`]).catch(() => {});
            details.push(`Removed stale zone ${priorState.sgcDomain} (superseded by ${plan.sgcDomain})`);
          }
          if (priorState.epcDomain !== plan.epcDomain) {
            namedLocalForCleanup = this.removeNamedZone(namedLocalForCleanup, priorState.epcDomain);
            await this.hostExecutor.executeLocalCommand('rm', ['-f', `${BIND_ZONES_DIR}/${priorState.epcDomain}.zone`]).catch(() => {});
            details.push(`Removed stale zone ${priorState.epcDomain} (superseded by ${plan.epcDomain})`);
          }
          await this.hostExecutor.writeFile(`${BIND_DIR}/named.conf.local`, namedLocalForCleanup);
        }
      }

      const zoneFile = (domain: string, records: DnsEntry[]): string => {
        const serial = Math.floor(Date.now() / 1000);
        const dnsIp = records[0]?.ip || '127.0.0.1';
        const lines = records.map(r => `${r.fqdn.replace(`.${domain}`, '')} IN A ${r.ip}`);
        return `$TTL 300\n$ORIGIN ${domain}.\n\n@   IN SOA   ns1 hostmaster (${serial} 3600 1800 604800 300)\n@   IN NS    ns1\nns1 IN A     ${dnsIp}\n\n${lines.join('\n')}\n`;
      };

      const sgcRecords = plan.dnsEntries.filter(e => e.zone === '5gc');
      const epcRecords = plan.dnsEntries.filter(e => e.zone === 'epc');

      await this.hostExecutor.writeFile(`${BIND_ZONES_DIR}/${plan.sgcDomain}.zone`, zoneFile(plan.sgcDomain, sgcRecords));
      await this.hostExecutor.writeFile(`${BIND_ZONES_DIR}/${plan.epcDomain}.zone`, zoneFile(plan.epcDomain, epcRecords));
      details.push(`Wrote ${plan.sgcDomain} (${sgcRecords.length} records) and ${plan.epcDomain} (${epcRecords.length} records)`);

      let namedLocal = '';
      try { namedLocal = await this.hostExecutor.readFile(`${BIND_DIR}/named.conf.local`); } catch { /* fresh file */ }
      namedLocal = this.upsertNamedZone(namedLocal, plan.sgcDomain, `${BIND_ZONES_DIR_HOST}/${plan.sgcDomain}.zone`);
      namedLocal = this.upsertNamedZone(namedLocal, plan.epcDomain, `${BIND_ZONES_DIR_HOST}/${plan.epcDomain}.zone`);
      await this.hostExecutor.writeFile(`${BIND_DIR}/named.conf.local`, namedLocal);
      details.push('Updated named.conf.local');

      const restartResult = await this.hostExecutor.restartService('bind9');
      if (restartResult.exitCode !== 0) throw new Error(`bind9 restart failed: ${restartResult.stderr}`);
      details.push('Restarted bind9');

      for (const rec of plan.dnsEntries) {
        // dig isn't installed in this container's own image — executeCommand (nsenter
        // into the host's mount namespace) is required here, not executeLocalCommand,
        // which was silently failing with "command not found" on every single record
        // regardless of whether DNS/BIND was actually working.
        const dig = await this.hostExecutor.executeCommand('dig', ['+short', rec.fqdn, '@127.0.0.1']);
        const resolved = dig.stdout.trim();
        details.push(`dig ${rec.fqdn} -> ${resolved || 'NO ANSWER'}${resolved === rec.ip ? ' [OK]' : ' [MISMATCH]'}`);
      }

      // Persist the current domains + peer IPs — this is the only remaining record of
      // mme/hss/pcrf/smf's real IPs once Phase B drops ConnectTo, and it's what lets a
      // future PLMN change clean up these exact zones instead of leaving them orphaned.
      const peerIps: Partial<Record<EpcConfService, string>> = { ...priorState?.peerIps };
      for (const rec of plan.dnsEntries.filter(e => e.zone === 'epc')) {
        const peerName = rec.fqdn.split('.')[0] as EpcConfService;
        if ((EPC_CONF_SERVICES as readonly string[]).includes(peerName)) peerIps[peerName] = rec.ip;
      }
      await this.writeMigrationState({ sgcDomain: plan.sgcDomain, epcDomain: plan.epcDomain, peerIps });
      details.push('Recorded migration state for future re-runs');

      // BIND itself answering correctly (verified above via dig) isn't sufficient —
      // make sure the host's actual resolver path (getaddrinfo(), what every NF calls)
      // routes through it too, before any NF is asked to resolve its own FQDN.
      await this.ensureSystemResolverUsesBind(details);

      await this.auditLogger.log({ action: 'dns_migration_phase_a', user: 'admin', details: details.join('; '), success: true });
      return { phase: 'A', success: true, details };
    } catch (err) {
      const error = String(err);
      this.logger.error({ err: error }, 'dns-migration: Phase A failed');
      await this.auditLogger.log({ action: 'dns_migration_phase_a', user: 'admin', details: error, success: false });
      return { phase: 'A', success: false, details, error };
    }
  }

  // ── Phase B — EPC/Diameter mesh (mme/hss/pcrf/smf reference each other by FQDN,
  // drop ConnectTo so freeDiameter resolves via DNS instead of a pinned IP). ──────

  async applyPhaseB(plan: DnsMigrationPlan): Promise<PhaseResult> {
    const details: string[] = [];
    const restartOrder: EpcConfService[] = SERVICE_RESTART_ORDER.filter(
      (s): s is EpcConfService => (EPC_CONF_SERVICES as readonly string[]).includes(s),
    );
    try {
      for (const change of plan.freeDiameterChanges) {
        const svc = change.file.replace('.conf', '') as EpcConfService;
        const filePath = `${FREEDIAMETER_DIR}/${change.file}`;
        let raw = await this.hostExecutor.readFile(filePath);

        raw = raw.replace(/^(Identity\s*=\s*)"[^"]+"/m, `$1"${change.identityNew}"`);
        raw = raw.replace(/^(Realm\s*=\s*)"[^"]+"/m, `$1"${change.realmNew}"`);

        // freeDiameter validates its own TLS_Cred certificate's CN/SAN against Identity
        // at startup — unconditionally, even though every ConnectPeer here already opts
        // out of TLS per-connection with No_TLS. The certs on this host were issued for
        // the OLD "*.localdomain" identities, so changing Identity alone makes that
        // startup check fail and the service refuses to start (confirmed live: "TLS:
        // The certificate owner does not match the hostname ..." -> FATAL assertion ->
        // core-dump).
        //
        // Fix attempt #1 (WRONG, confirmed live): a top-level `No_TLS;` directive.
        // freeDiameter's own grammar (libfdcore/fdd.y) does NOT accept No_TLS as a
        // top-level statement at all — it's only valid inside a ConnectPeer{} block —
        // so this produced "syntax error, unexpected NOTLS" and crashed all 4 services
        // a second time.
        //
        // Real fix (confirmed against libfdcore/config.c): `tls_disabled` is not a
        // settable flag — it's computed true only when BOTH (a) TLS_Cred's key_file
        // was never configured, AND (b) the TLS port is 0. Commenting out TLS_Cred
        // satisfies (a) but NOT (b) on its own — libfdcore/core.c initializes
        // cnf_port_tls to the standard DIAMETER_SECURE_PORT default (nonzero) BEFORE
        // the config file is even parsed, so without an explicit override it's never
        // 0. Confirmed live: commenting out TLS_Cred alone still crashed with "Missing
        // private key configuration for TLS" (a THIRD distinct failure, after the
        // rejected top-level No_TLS attempt). Both conditions are required together.
        raw = raw.replace(/^(\s*)(TLS_Cred\s*=.*;)/m, '$1#$2');
        raw = raw.replace(/^(\s*)(TLS_CA\s*=.*;)/m, '$1#$2');
        if (!/^\s*SecPort\s*=\s*0\s*;/m.test(raw)) {
          raw = raw.replace(/^(Realm\s*=\s*"[^"]+"\s*;)/m, `$1\nSecPort = 0;`);
        }

        for (const peer of change.peers) {
          // Replace "peer.localdomain" { ... ConnectTo = "IP"; ... } with the FQDN
          // identity and no ConnectTo — freeDiameter resolves the Identity via DNS.
          const peerBlockRe = new RegExp(
            `ConnectPeer\\s*=\\s*"${peer.identityOld.replace(/\./g, '\\.')}"\\s*\\{([^}]*)\\}`,
          );
          raw = raw.replace(peerBlockRe, (_full, inner: string) => {
            const withoutConnectTo = inner.replace(/\s*ConnectTo\s*=\s*"[^"]+"\s*;/, '');
            return `ConnectPeer = "${peer.identityNew}" {${withoutConnectTo}}`;
          });
        }

        await this.hostExecutor.writeFile(filePath, raw);
        details.push(`Rewrote ${change.file}: Identity=${change.identityNew}, Realm=${change.realmNew}, disabled TLS_Cred/TLS_CA, dropped ConnectTo for ${change.peers.length} peer(s)`);
      }

      for (const svc of restartOrder) {
        const result = await this.hostExecutor.restartService(SERVICE_UNIT_MAP[svc]);
        if (result.exitCode !== 0) throw new Error(`${svc} restart failed: ${result.stderr}`);
      }
      details.push(`Restarted: ${restartOrder.join(', ')}`);

      // Verify each Diameter peer pair actually connected. Two things make a single
      // immediate check unreliable here, both confirmed live:
      //  1. freeDiameter's own startup log reports "Pref. proto: SCTP" — it tries
      //     SCTP first and only falls back to TCP if that's unavailable, so which
      //     protocol a given connection lands on varies between runs. Checking only
      //     one protocol produced a false "not connected" even though the link was
      //     genuinely open.
      //  2. Checking immediately after the restart loop can catch services mid-
      //     handshake — freeDiameter needs a moment after startup to resolve DNS,
      //     connect, and complete CER/CEA. A one-shot check right after restart can
      //     report "not connected" on a link that finishes connecting a second later.
      // So: check both protocols, and retry for a few seconds before giving up.
      const pairs = plan.freeDiameterChanges.flatMap(change => {
        const svc = change.file.replace('.conf', '');
        const svcIp = plan.dnsEntries.find(e => e.fqdn === `${svc}.${plan.epcDomain}`)?.ip;
        return change.peers.map(peer => ({
          svc, peer: peer.peer,
          svcIp,
          peerIp: plan.dnsEntries.find(e => e.fqdn === `${peer.peer}.${plan.epcDomain}`)?.ip,
        }));
      });

      const checkAllConnected = async (): Promise<Map<string, boolean>> => {
        const [tcpCheck, sctpCheck] = await Promise.all([
          this.hostExecutor.executeCommand('ss', ['-tn', 'state', 'established']),
          this.hostExecutor.executeCommand('ss', ['-San']),
        ]);
        const establishedLines = [
          ...tcpCheck.stdout.split('\n'),
          ...sctpCheck.stdout.split('\n').filter(line => line.trim().startsWith('ESTAB')),
        ];
        const isConnected = (ipA: string, ipB: string): boolean =>
          establishedLines.some(line => line.includes(ipA) && line.includes(ipB));
        const result = new Map<string, boolean>();
        for (const p of pairs) {
          result.set(`${p.svc}<->${p.peer}`, !!(p.svcIp && p.peerIp && isConnected(p.svcIp, p.peerIp)));
        }
        return result;
      };

      let lastResult = await checkAllConnected();
      for (let attempt = 0; attempt < 5 && ![...lastResult.values()].every(Boolean); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        lastResult = await checkAllConnected();
      }

      for (const p of pairs) {
        const connected = lastResult.get(`${p.svc}<->${p.peer}`) ?? false;
        details.push(`Diameter link ${p.svc} <-> ${p.peer}: ${connected ? 'connected' : 'not connected — check logs'}`);
      }

      await this.auditLogger.log({ action: 'dns_migration_phase_b', user: 'admin', details: details.join('; '), success: true });
      return { phase: 'B', success: true, details };
    } catch (err) {
      const error = String(err);
      this.logger.error({ err: error }, 'dns-migration: Phase B failed');
      await this.auditLogger.log({ action: 'dns_migration_phase_b', user: 'admin', details: error, success: false });
      return { phase: 'B', success: false, details, error };
    }
  }

  // ── Phase C — 5GC SBI mesh (client.nrf/client.scp/client.nsi URIs -> FQDN). ────

  async applyPhaseC(plan: DnsMigrationPlan): Promise<PhaseResult> {
    const details: string[] = [];
    try {
      // Defense in depth: Phase A already does this at its own end, but Phase C is the
      // highest-risk phase (every restarted NF does a synchronous getaddrinfo() on its
      // own advertise FQDN and FATAL-aborts if it can't resolve) — re-check right before
      // restarting anything in case something reverted the resolver since Phase A ran.
      await this.ensureSystemResolverUsesBind(details);

      const bySvc = new Map<string, SbiChange[]>();
      for (const change of plan.sbiChanges) {
        if (!bySvc.has(change.service)) bySvc.set(change.service, []);
        bySvc.get(change.service)!.push(change);
      }

      // Every SBI-mesh NF gets its own advertise rewrite (including NRF itself, which
      // has no client.nrf/scp of its own but still needs to broadcast its FQDN so
      // OTHER NFs doing dynamic discovery find it by name, not raw IP) — so iterate
      // the full service list, not just the ones with a client-uri change.
      for (const svc of SGC_ZONE_SERVICES) {
        const changes = bySvc.get(svc) ?? [];
        const advertise = plan.advertiseChanges.find(a => a.service === svc);

        const loadMethod = LOAD_METHOD[svc];
        const saveMethod = SAVE_METHOD[svc];
        const existing = await (this.configRepo[loadMethod] as () => Promise<any>)();
        const yamlKey = yamlKeyFor(svc);

        const clientPatch: any = {};
        for (const change of changes) {
          if (change.field === 'sbi.client.nrf[0].uri') clientPatch.nrf = [{ uri: change.newUri }];
          if (change.field === 'sbi.client.scp[0].uri') clientPatch.scp = [{ uri: change.newUri }];
          if (change.field === 'sbi.client.nsi[0].uri') {
            const currentNsi = (existing?.rawYaml?.[yamlKey]?.sbi?.client?.nsi?.[0]) ?? {};
            clientPatch.nsi = [{ ...currentNsi, uri: change.newUri }];
          }
        }

        const currentServer = (existing?.rawYaml?.[yamlKey]?.sbi?.server?.[0]) ?? {};
        const serverPatch = advertise ? [{ ...currentServer, advertise: advertise.newAdvertise }] : undefined;

        const sbiPatch: any = {};
        if (Object.keys(clientPatch).length > 0) sbiPatch.client = clientPatch;
        if (serverPatch) sbiPatch.server = serverPatch;
        if (Object.keys(sbiPatch).length === 0) continue;

        const patch = { rawYaml: { [yamlKey]: { sbi: sbiPatch } } } as any;
        await (this.configRepo[saveMethod] as (c: any) => Promise<void>)({ ...existing, ...patch });

        const changeSummary = changes.map(c => `${c.field} -> ${c.newUri}`);
        if (advertise) changeSummary.push(`advertise -> ${advertise.newAdvertise}`);
        details.push(`Updated ${svc}.yaml: ${changeSummary.join(', ')}`);
      }

      // NRF is the hub everything depends on — restart it first, then everyone else
      // in dependency order so they re-register against the (unchanged) NRF address
      // using their new FQDN-based client config.
      for (const service of SERVICE_RESTART_ORDER) {
        if (!(SGC_ZONE_SERVICES as readonly string[]).includes(service)) continue;
        const result = await this.hostExecutor.restartService(SERVICE_UNIT_MAP[service]);
        if (result.exitCode !== 0) throw new Error(`${service} restart failed: ${result.stderr}`);
        details.push(`Restarted ${service}`);
      }

      // Give any fatal FQDN-resolution abort a moment to actually manifest — Open5GS
      // exits near-instantly on an unresolvable advertise FQDN, but a restart command
      // returning exit 0 only means systemd successfully issued the start, not that the
      // process stayed up (the exact historical bug this phase used to have: reporting
      // success:true while one of 11 NF restarts had actually crashed).
      await new Promise(resolve => setTimeout(resolve, 2000));

      const crashedServices: string[] = [];
      for (const svc of SGC_ZONE_SERVICES) {
        const unit = SERVICE_UNIT_MAP[svc];
        const active = await this.hostExecutor.isServiceActive(unit);
        details.push(`${unit}: ${active ? 'active' : 'INACTIVE — crashed after restart'}`);
        if (!active) crashedServices.push(svc);
      }

      // SBI reachability via FQDN. Open5GS's SBI servers are HTTP/2-cleartext (h2c)
      // only and expect prior-knowledge, not the classic Upgrade: h2c dance — a plain
      // HTTP/1.1 request (curl's default) gets its request line parsed as garbage HTTP/2
      // framing and the server drops the connection ("nghttp2_session_mem_recv() failed
      // (-903:Received bad client magic byte string)" in the NF's own log), which showed
      // up as a misleading "HTTP 000" even when the NF was perfectly healthy. Confirmed
      // live (2026-07-17): a healthy NRF returns HTTP 000 to a plain request but a real
      // 400 (hitting "/", not a registered SBI route, but still a genuine HTTP response)
      // to the same request with --http2-prior-knowledge.
      // Bug found live (2026-07-23), first misdiagnosed as a timing race: this used
      // to call executeLocalCommand, which runs curl inside the BACKEND CONTAINER's
      // own network context. The container's /etc/resolv.conf is Docker's
      // auto-generated default (nameserver 1.1.1.1 / 8.8.8.8) — it does NOT route
      // through the host's BIND server, unlike the host's own /etc/resolv.conf
      // (fixed by ensureSystemResolverUsesBind() elsewhere in this flow, which only
      // touches /proc/1/root/etc/resolv.conf, i.e. the HOST's file). So the
      // container could never resolve these custom 3GPP FQDNs at all — confirmed via
      // `getent hosts` returning empty from inside the container — and curl failed
      // with "HTTP 000" on every single attempt regardless of retries, which is why
      // an earlier retry-with-backoff fix here did nothing. The real NFs themselves
      // resolve fine because they run on the host directly. Using executeCommand
      // (nsenter into the host's mount/network namespace, same as every other
      // host-context check in this file, e.g. the `dig` verification in Phase A)
      // makes curl resolve via the host's correctly-configured resolver instead.
      // Kept a short 2-attempt retry on top — a genuine, smaller timing race can
      // still exist for whichever NF restarts last in SERVICE_RESTART_ORDER and
      // hasn't bound its SBI listener yet by the time this loop reaches it.
      for (const entry of plan.dnsEntries.filter(e => e.zone === '5gc')) {
        let code = '';
        const maxAttempts = 2;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const curl = await this.hostExecutor.executeCommand('curl', ['-s', '--http2-prior-knowledge', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '3', `http://${entry.fqdn}:7777/`]);
          code = curl.stdout.trim();
          if (code !== '' && code !== '000') break;
          if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, 1500));
        }
        const reachable = code !== '' && code !== '000';
        details.push(`curl --http2-prior-knowledge http://${entry.fqdn}:7777/ -> HTTP ${code || 'no response'}${reachable ? ' [OK]' : ' [UNREACHABLE]'}`);
      }

      if (crashedServices.length > 0) {
        throw new Error(`${crashedServices.length} NF(s) not active after restart: ${crashedServices.join(', ')} — check journalctl -u <unit> for FQDN resolution or other startup failures`);
      }

      await this.auditLogger.log({ action: 'dns_migration_phase_c', user: 'admin', details: details.join('; '), success: true });
      return { phase: 'C', success: true, details };
    } catch (err) {
      const error = String(err);
      this.logger.error({ err: error }, 'dns-migration: Phase C failed');
      await this.auditLogger.log({ action: 'dns_migration_phase_c', user: 'admin', details: error, success: false });
      return { phase: 'C', success: false, details, error };
    }
  }
}
