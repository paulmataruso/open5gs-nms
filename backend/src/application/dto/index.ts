import { ServiceName } from '../../domain/entities/service-status';

// ── Config DTOs ──
//
// GET /api/config and PUT /api/config carry each NF's WHOLE parsed YAML
// document, exactly as ConfigMapper.toAllDto() reads it out of `rawYaml`. So
// an NF's own settings sit one level down under its own name, next to the
// document-level `logger`/`global`:
//
//   { logger: {...}, global: {...}, amf: { sbi, ngap, guami, ... } }
//
// These used to be hand-written interfaces that declared the INNER fields at
// their own top level -- off by one level for every NF -- and the mismatch was
// invisible because the mapper assigned `rawYaml` behind an `as any` and the
// frontend unwrapped `configs.amf as any` back to the real shape. Nothing was
// broken at runtime; the types simply described a payload the API has never
// sent. Three further shape errors hid behind the same casts: smf/upf declared
// a `subnet:` block (the real key is `session:`), sepp declared `n32.server`
// as an object (it is a list) and `tls` one level too high, and nssf declared
// an `nsi:` list at top level (it lives under `sbi.client.nsi`).
//
// They are therefore ALIASES now, not copies. The documents are defined and
// verified in domain/entities/open5gs-yaml.ts; a second hand-written copy
// drifting from the first is what produced the original bug.
export type {
  AmfYamlDocument as AmfConfigDto,
  AusfYamlDocument as AusfConfigDto,
  BsfYamlDocument as BsfConfigDto,
  HssYamlDocument as HssConfigDto,
  MmeYamlDocument as MmeConfigDto,
  NrfYamlDocument as NrfConfigDto,
  NssfYamlDocument as NssfConfigDto,
  PcfYamlDocument as PcfConfigDto,
  PcrfYamlDocument as PcrfConfigDto,
  ScpYamlDocument as ScpConfigDto,
  SeppYamlDocument as SeppConfigDto,
  SgwcYamlDocument as SgwcConfigDto,
  SgwuYamlDocument as SgwuConfigDto,
  SmfYamlDocument as SmfConfigDto,
  UdmYamlDocument as UdmConfigDto,
  UdrYamlDocument as UdrConfigDto,
  UpfYamlDocument as UpfConfigDto,
} from '../../domain/entities/open5gs-yaml';

import type {
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
} from '../../domain/entities/open5gs-yaml';

// ── All Configs ──
//
// `sepp1` is the DTO key; the document inside it nests under `sepp`.
export interface AllConfigsDto {
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
  mme: MmeYamlDocument;
  hss: HssYamlDocument;
  pcrf: PcrfYamlDocument;
  sgwc: SgwcYamlDocument;
  sgwu: SgwuYamlDocument;
}

// ── Subscriber DTOs ──
export interface SubscriberDto {
  imsi: string;
  msisdn?: string[];
  imeisv?: string | string[];
  mme_host?: string | string[];
  mme_realm?: string | string[];
  purge_flag?: boolean | boolean[];
  mme_timestamp?: number;
  security: {
    k: string;
    op?: string | null;
    opc: string;
    amf: string;
    sqn?: number;
  };
  ambr: {
    uplink: { value: number; unit: number };
    downlink: { value: number; unit: number };
  };
  slice: Array<{
    sst: number;
    sd?: string;
    default_indicator?: boolean;
    session: Array<{
      name: string;
      type: number;
      ambr: {
        uplink: { value: number; unit: number };
        downlink: { value: number; unit: number };
      };
      qos: {
        index: number;
        arp: {
          priority_level: number;
          pre_emption_capability: number;
          pre_emption_vulnerability: number;
        };
      };
      ue?: { ipv4?: string; ipv6?: string };
      smf?: { ipv4?: string; ipv6?: string };
      pcc_rule?: unknown[];
      ipv4_framed_routes?: string[];
      ipv6_framed_routes?: string[];
      framed_routes_static?: boolean;
    }>;
  }>;
  subscribed_rau_tau_timer?: number;
  subscriber_status?: number;
  operator_determined_barring?: number;
  access_restriction_data?: number;
  network_access_mode?: number;
  gsmEnabled?: boolean;
  simType?: 'esim' | 'physical' | null;
}

// ── Service DTOs ──
export interface ServiceStatusDto {
  name: ServiceName;
  unitName: string;
  active: boolean;
  enabled: boolean;
  state: string;
  subState: string;
  pid: number | null;
  uptime: string | null;
  restartCount: number;
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryPercent: number | null;
  lastChecked: string;
}

export interface ServiceActionDto {
  service: ServiceName;
  action: 'start' | 'stop' | 'restart' | 'enable' | 'disable';
}

// ── Apply ──
export interface ApplyResultDto {
  success: boolean;
  diff: string;
  validationErrors: Array<{
    field: string;
    message: string;
    service?: string;
    severity: string;
  }>;
  restartResults: Array<{
    service: string;
    success: boolean;
    error?: string;
  }>;
  rollback: boolean;
  prometheusReloaded?: boolean;
  prometheusReloadError?: string;
}

// ── Validation ──
export interface ValidationResultDto {
  valid: boolean;
  errors: Array<{
    field: string;
    message: string;
    service?: string;
    severity: string;
  }>;
}

// ── Backup/Restore DTOs ──
export interface BackupListItemDto {
  name: string;
  timestamp: string;
  type: 'config' | 'mongodb';
}

export interface BackupSettingsDto {
  configBackupsToKeep: number;
  mongoBackupsToKeep: number;
}

export interface CreateBackupResponseDto {
  success: boolean;
  backupName: string;
  error?: string;
}

export interface RestoreBackupResponseDto {
  success: boolean;
  error?: string;
}

export interface RestoreBothResponseDto {
  success: boolean;
  errors: string[];
}

export interface BackupListResponseDto {
  mongoBackups: BackupListItemDto[];
  configBackups: BackupListItemDto[];
}
