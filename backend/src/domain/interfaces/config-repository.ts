import { NrfConfig } from '../entities/nrf-config';
import { AmfConfig } from '../entities/amf-config';
import { SmfConfig } from '../entities/smf-config';
import { UpfConfig } from '../entities/upf-config';
import { AusfConfig } from '../entities/ausf-config';
import { GenericServiceConfig } from '../entities/generic-config';
import {
  AmfYamlDocument,
  AusfYamlDocument,
  BsfYamlDocument,
  HssYamlDocument,
  MmeYamlDocument,
  NrfYamlDocument,
  NssfYamlDocument,
  PcfYamlDocument,
  PcrfYamlDocument,
  ScpYamlDocument,
  SeppYamlDocument,
  SgwcYamlDocument,
  SgwuYamlDocument,
  SmfYamlDocument,
  UdmYamlDocument,
  UdrYamlDocument,
  UpfYamlDocument,
  YamlDocumentCommon,
} from '../entities/open5gs-yaml';

/**
 * Every config file basename the NMS reads or writes under /etc/open5gs, and
 * the single source of truth for the set -- backupAll()/restoreBackup() walk
 * this list rather than each keeping its own copy.
 */
export const ALL_CONFIG_SERVICES = [
  'nrf', 'amf', 'smf', 'upf', 'ausf', 'scp', 'udm', 'udr', 'pcf',
  'nssf', 'bsf', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu', 'sepp1', 'sepp2',
] as const;

/** Any config file basename the NMS knows about. */
export type Open5gsServiceName = (typeof ALL_CONFIG_SERVICES)[number];

/**
 * Every Open5GS NF that runs as its own systemd daemon on the host -- so
 * every NF with a unit to restart, a log file under /var/log/open5gs, and a
 * place in any "all the NFs" enumeration.
 *
 * This is NOT the same set as ALL_CONFIG_SERVICES above, which is one entry
 * longer: `sepp2.yaml` is a second N32 peering's config file, with no
 * open5gs-sepp2d unit and no sepp2.log, so it belongs in the config-file list
 * and not in this one.
 *
 * It exists because this list was written out seven times across six files
 * -- service-controller.ts held two identical copies of its own -- and two of
 * them had drifted to sixteen by omitting sepp1, which is the stale core-NF
 * list CLAUDE.md calls out by name. backup-restore.ts had already been bitten
 * by exactly that and fixed its own copy, with a comment naming the bug
 * class, which did nothing for the two that were still wrong. The failure is
 * always the same shape: the feature works, reports success, and silently
 * leaves one NF out. Import this rather than writing the names again.
 *
 * Order is the NF registration/dependency order used elsewhere and is not
 * significant to any current consumer -- restart SEQUENCING is a different
 * concern and lives in service-status.ts's own ordered list.
 */
export const OPEN5GS_DAEMON_SERVICES = [
  'nrf', 'amf', 'smf', 'upf', 'ausf', 'scp', 'udm', 'udr', 'pcf',
  'nssf', 'bsf', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu', 'sepp1',
] as const;

/** Any Open5GS NF that runs as a host daemon. */
export type Open5gsDaemonName = (typeof OPEN5GS_DAEMON_SERVICES)[number];

/**
 * Config-file basename -> parsed document shape, for every file the NMS reads
 * or writes under /etc/open5gs.
 *
 * This is the ONE place the filename -> shape mapping is allowed to live,
 * because the filename is the only thing that determines it. Note `sepp1` and
 * `sepp2` both map to `SeppYamlDocument`: the document key is `sepp:` in both
 * files, so the service name and the top-level YAML key genuinely differ here
 * and a per-service type is the only way to say so.
 *
 * The `extends Record<Open5gsServiceName, YamlDocumentCommon>` guarantees that
 * EVERY name in ALL_CONFIG_SERVICES has a document type here, so
 * `Open5gsConfigDocuments[K]` is always valid. It does NOT force a new service
 * to be given a SPECIFIC document type -- an interface inherits a key it does
 * not declare, so a nineteenth service added to the list above silently gets
 * the loose `YamlDocumentCommon` instead of failing to compile. Checked by
 * experiment on 2026-11-26, not assumed: adding one produced zero tsc errors.
 * If you add an NF, add its document type here too.
 *
 * Added 2026-11-26 replacing twelve hand-written entity interfaces (ScpConfig,
 * UdmConfig, ... SeppConfig) that the implementation satisfied by casting
 * through `as any`. They were never populated: `MmeConfig` for instance
 * declared `s1ap` as REQUIRED while `loadGeneric()` has never set it, so any
 * caller trusting that declaration and reading `mme.s1ap.server[0]` would
 * have thrown. Every one of them was imported by this file and nothing else.
 */
export interface Open5gsConfigDocuments extends Record<Open5gsServiceName, YamlDocumentCommon> {
  nrf: NrfYamlDocument;
  scp: ScpYamlDocument;
  amf: AmfYamlDocument;
  smf: SmfYamlDocument;
  upf: UpfYamlDocument;
  ausf: AusfYamlDocument;
  udm: UdmYamlDocument;
  udr: UdrYamlDocument;
  pcf: PcfYamlDocument;
  nssf: NssfYamlDocument;
  bsf: BsfYamlDocument;
  sepp1: SeppYamlDocument;
  sepp2: SeppYamlDocument;
  mme: MmeYamlDocument;
  hss: HssYamlDocument;
  pcrf: PcrfYamlDocument;
  sgwc: SgwcYamlDocument;
  sgwu: SgwuYamlDocument;
}

/** The generic (unparsed-beyond-the-basics) config for one named service. */
export type NfConfig<K extends Open5gsServiceName> =
  GenericServiceConfig<Open5gsConfigDocuments[K]>;

export interface AllConfigs {
  // 5G Core
  nrf: NrfConfig;
  scp?: NfConfig<'scp'>;
  amf: AmfConfig;
  smf: SmfConfig;
  upf: UpfConfig;
  ausf: AusfConfig;
  udm?: NfConfig<'udm'>;
  udr?: NfConfig<'udr'>;
  pcf?: NfConfig<'pcf'>;
  nssf?: NfConfig<'nssf'>;
  bsf?: NfConfig<'bsf'>;
  sepp1?: NfConfig<'sepp1'>;
  // 4G EPC
  mme?: NfConfig<'mme'>;
  hss?: NfConfig<'hss'>;
  pcrf?: NfConfig<'pcrf'>;
  sgwc?: NfConfig<'sgwc'>;
  sgwu?: NfConfig<'sgwu'>;
}

export interface IConfigRepository {
  loadNrf(): Promise<NrfConfig>;
  loadAmf(): Promise<AmfConfig>;
  loadSmf(): Promise<SmfConfig>;
  loadUpf(): Promise<UpfConfig>;
  loadAusf(): Promise<AusfConfig>;
  loadScp(): Promise<NfConfig<'scp'>>;
  loadUdm(): Promise<NfConfig<'udm'>>;
  loadUdr(): Promise<NfConfig<'udr'>>;
  loadPcf(): Promise<NfConfig<'pcf'>>;
  loadNssf(): Promise<NfConfig<'nssf'>>;
  loadBsf(): Promise<NfConfig<'bsf'>>;
  loadSepp1(): Promise<NfConfig<'sepp1'>>;
  loadMme(): Promise<NfConfig<'mme'>>;
  loadHss(): Promise<NfConfig<'hss'>>;
  loadPcrf(): Promise<NfConfig<'pcrf'>>;
  loadSgwc(): Promise<NfConfig<'sgwc'>>;
  loadSgwu(): Promise<NfConfig<'sgwu'>>;
  loadAll(): Promise<AllConfigs>;

  saveNrf(config: NrfConfig): Promise<void>;
  saveAmf(config: AmfConfig): Promise<void>;
  saveSmf(config: SmfConfig): Promise<void>;
  saveUpf(config: UpfConfig): Promise<void>;
  saveAusf(config: AusfConfig): Promise<void>;
  saveScp(config: NfConfig<'scp'>): Promise<void>;
  saveUdm(config: NfConfig<'udm'>): Promise<void>;
  saveUdr(config: NfConfig<'udr'>): Promise<void>;
  savePcf(config: NfConfig<'pcf'>): Promise<void>;
  saveNssf(config: NfConfig<'nssf'>): Promise<void>;
  saveBsf(config: NfConfig<'bsf'>): Promise<void>;
  saveSepp1(config: NfConfig<'sepp1'>): Promise<void>;
  saveMme(config: NfConfig<'mme'>): Promise<void>;
  saveHss(config: NfConfig<'hss'>): Promise<void>;
  savePcrf(config: NfConfig<'pcrf'>): Promise<void>;
  saveSgwc(config: NfConfig<'sgwc'>): Promise<void>;
  saveSgwu(config: NfConfig<'sgwu'>): Promise<void>;

  backupAll(backupDir: string): Promise<void>;
  restoreBackup(backupDir: string): Promise<void>;
  getRawYaml(service: string): Promise<string>;
}
