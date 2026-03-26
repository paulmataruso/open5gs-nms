import { ServiceName } from '../../domain/entities/service-status';

// ── Common SBI Structures ──
export interface SbiServerDto {
  address: string;
  port: number;
  advertise?: string;
  dev?: string;
}

export interface SbiClientDto {
  nrf?: Array<{ uri: string }>;
  scp?: Array<{ uri: string }>;
}

export interface SbiDto {
  server: SbiServerDto[];
  client?: SbiClientDto;
}

// ── Logger ──
export interface LoggerDto {
  file?: { path: string };
  level?: string;
}

// ── Global ──
export interface GlobalDto {
  max?: {
    ue?: number;
    peer?: number;
  };
}

// ── Metrics ──
export interface MetricsDto {
  server?: Array<{ address: string; port: number }>;
}

// ── Config DTOs ──
export interface PlmnIdDto {
  mcc: string;
  mnc: string;
}

export interface SnssaiDto {
  sst: number;
  sd?: string;
}

// ── NRF ──
export interface NrfConfigDto {
  sbi: SbiDto;
  logger?: LoggerDto;
  global?: GlobalDto;
}

// ── SCP ──
export interface ScpConfigDto {
  sbi: SbiDto;
  logger?: LoggerDto;
  global?: GlobalDto;
  info?: {
    port?: { http?: number; https?: number };
    domain?: Array<{
      name: string;
      fqdn: string;
      port?: { http?: number; https?: number };
    }>;
  };
}

// ── AMF ──
export interface AmfConfigDto {
  sbi: SbiDto;
  ngap: { server: Array<{ address: string; port?: number; dev?: string }> };
  metrics?: MetricsDto;
  guami: Array<{
    plmn_id: PlmnIdDto;
    amf_id: { region: number; set: number; pointer: number };
  }>;
  tai: Array<{ plmn_id: PlmnIdDto; tac: number | number[] }>;
  plmn_support: Array<{ plmn_id: PlmnIdDto; s_nssai: SnssaiDto[] }>;
  security?: { integrity_order?: string[]; ciphering_order?: string[] };
  network_name?: { full?: string; short?: string };
  amf_name?: string;
  time?: {
    t3502?: { value?: number };
    t3512?: { value?: number };
    t3522?: { value?: number };
  };
  logger?: LoggerDto;
  global?: GlobalDto;
}

// ── SMF ──
export interface SmfConfigDto {
  sbi: SbiDto;
  pfcp: { server: Array<{ address: string; port?: number; dev?: string }> };
  gtpc?: { server?: Array<{ address: string; dev?: string }> };
  gtpu?: { server?: Array<{ address: string; port?: number; dev?: string }> };
  metrics?: MetricsDto;
  subnet: Array<{
    addr: string;
    dnn?: string;
  }>;
  dns?: string[];
  mtu?: number;
  ctf?: { enabled?: string };
  freeDiameter?: string;
  info?: Array<{ s_nssai: SnssaiDto[]; dnn: string[] }>;
  time?: {
    t3502?: { value?: number };
    t3512?: { value?: number };
  };
  logger?: LoggerDto;
  global?: GlobalDto;
}

// ── UPF ──
export interface UpfConfigDto {
  pfcp: { server: Array<{ address: string; port?: number; dev?: string }> };
  gtpu: { server: Array<{ address: string; port?: number; dev?: string }> };
  metrics?: MetricsDto;
  subnet: Array<{
    addr: string;
    dnn?: string;
    dev?: string;
  }>;
  logger?: LoggerDto;
  global?: GlobalDto;
}

// ── AUSF ──
export interface AusfConfigDto {
  sbi: SbiDto;
  logger?: LoggerDto;
  global?: GlobalDto;
}

// ── UDM ──
export interface UdmConfigDto {
  sbi: SbiDto;
  hnet?: Array<{
    id: number;
    scheme: number;
    key: string;
  }>;
  logger?: LoggerDto;
  global?: GlobalDto;
}

// ── UDR ──
export interface UdrConfigDto {
  db_uri: string;
  sbi: SbiDto;
  logger?: LoggerDto;
  global?: GlobalDto;
}

// ── PCF ──
export interface PcfConfigDto {
  sbi: SbiDto;
  metrics?: MetricsDto;
  policy?: Array<{
    plmn_id?: PlmnIdDto;
    slice?: Array<{
      sst: number;
      sd?: string;
      default_indicator?: boolean;
      session?: Array<{
        name: string;
        type?: number;
        qos?: {
          index?: number;
          arp?: {
            priority_level?: number;
            pre_emption_capability?: number;
            pre_emption_vulnerability?: number;
          };
        };
        ambr?: {
          uplink?: { value?: number; unit?: number };
          downlink?: { value?: number; unit?: number };
        };
      }>;
    }>;
  }>;
  logger?: LoggerDto;
  global?: GlobalDto;
}

// ── NSSF ──
export interface NssfConfigDto {
  sbi: SbiDto;
  nsi?: Array<{
    s_nssai: SnssaiDto;
    nrf?: { sbi: SbiDto };
  }>;
  logger?: LoggerDto;
  global?: GlobalDto;
}

// ── BSF ──
export interface BsfConfigDto {
  sbi: SbiDto;
  logger?: LoggerDto;
  global?: GlobalDto;
}

// ── MME ──
export interface MmeConfigDto {
  freeDiameter?: string;
  s1ap: { server: Array<{ address: string; dev?: string }> };
  gtpc: {
    server: Array<{ address: string }>;
    client?: {
      sgwc?: Array<{ address: string; tac?: number | number[]; e_cell_id?: string | string[] }>;
      smf?: Array<{ address: string; apn?: string | string[] }>;
    };
  };
  metrics?: MetricsDto;
  gummei: Array<{
    plmn_id: PlmnIdDto;
    mme_gid: number;
    mme_code: number;
  }>;
  tai: Array<{ plmn_id: PlmnIdDto; tac: number | number[] }>;
  security: { integrity_order: string[]; ciphering_order: string[] };
  network_name?: { full?: string; short?: string };
  mme_name?: string;
  time?: {
    t3402?: { value?: number };
    t3412?: { value?: number };
    t3423?: { value?: number };
  };
  logger?: LoggerDto;
  global?: GlobalDto;
}

// ── HSS ──
export interface HssConfigDto {
  freeDiameter: string;
  logger?: LoggerDto;
  global?: GlobalDto;
}

// ── PCRF ──
export interface PcrfConfigDto {
  freeDiameter: string;
  metrics?: MetricsDto;
  logger?: LoggerDto;
  global?: GlobalDto;
}

// ── SGW-C ──
export interface SgwcConfigDto {
  gtpc: {
    server: Array<{ address: string }>;
  };
  pfcp: {
    server: Array<{ address: string; port?: number; dev?: string }>;
    client?: {
      sgwu?: Array<{ address: string }>;
    };
  };
  logger?: LoggerDto;
  global?: GlobalDto;
}

// ── SGW-U ──
export interface SgwuConfigDto {
  pfcp: {
    server: Array<{ address: string; port?: number; dev?: string }>;
  };
  gtpu: {
    server: Array<{ address: string; port?: number; dev?: string }>;
  };
  logger?: LoggerDto;
  global?: GlobalDto;
}

// ── All Configs ──
export interface AllConfigsDto {
  nrf: NrfConfigDto;
  scp: ScpConfigDto;
  amf: AmfConfigDto;
  smf: SmfConfigDto;
  upf: UpfConfigDto;
  ausf: AusfConfigDto;
  udm: UdmConfigDto;
  udr: UdrConfigDto;
  pcf: PcfConfigDto;
  nssf: NssfConfigDto;
  bsf: BsfConfigDto;
  mme: MmeConfigDto;
  hss: HssConfigDto;
  pcrf: PcrfConfigDto;
  sgwc: SgwcConfigDto;
  sgwu: SgwuConfigDto;
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
    }>;
  }>;
  subscribed_rau_tau_timer?: number;
  subscriber_status?: number;
  operator_determined_barring?: number;
  access_restriction_data?: number;
  network_access_mode?: number;
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
