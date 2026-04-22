// ── Service Types ──
export type ServiceName = 'nrf' | 'scp' | 'amf' | 'smf' | 'upf' | 'ausf' | 'udm' | 'udr' | 'pcf' | 'nssf' | 'bsf' | 'mme' | 'hss' | 'pcrf' | 'sgwc' | 'sgwu';

export interface ServiceStatus {
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

// ── Common SBI Structures ──
export interface SbiServer {
  address: string;
  port: number;
  advertise?: string;
  dev?: string;
}

export interface SbiClient {
  nrf?: Array<{ uri: string }>;
  scp?: Array<{ uri: string }>;
}

export interface Sbi {
  server: SbiServer[];
  client?: SbiClient;
}

// ── Common Structures ──
export interface PlmnId {
  mcc: string;
  mnc: string;
}

export interface Snssai {
  sst: number;
  sd?: string;
}

export interface Logger {
  file?: { path: string };
  level?: string;
}

export interface Global {
  max?: {
    ue?: number;
    peer?: number;
  };
}

export interface Metrics {
  server?: Array<{ address: string; port: number }>;
}

// ── NRF ──
export interface NrfConfig {
  sbi: Sbi;
  logger?: Logger;
  global?: Global;
}

// ── SCP ──
export interface ScpConfig {
  sbi: Sbi;
  logger?: Logger;
  global?: Global;
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
export interface AmfConfig {
  sbi: Sbi;
  ngap: { server: Array<{ address: string; port?: number; dev?: string }> };
  metrics?: Metrics;
  guami: Array<{
    plmn_id: PlmnId;
    amf_id: { region: number; set: number; pointer: number };
  }>;
  tai: Array<{ plmn_id: PlmnId; tac: number | number[] }>;
  plmn_support: Array<{ plmn_id: PlmnId; s_nssai: Snssai[] }>;
  security?: { integrity_order?: string[]; ciphering_order?: string[] };
  network_name?: { full?: string; short?: string };
  amf_name?: string;
  time?: {
    t3502?: { value?: number };
    t3512?: { value?: number };
    t3522?: { value?: number };
  };
  logger?: Logger;
  global?: Global;
}

// ── SMF ──
export interface SmfConfig {
  sbi: Sbi;
  pfcp: { server: Array<{ address: string; port?: number; dev?: string }> };
  gtpc?: { server?: Array<{ address: string; dev?: string }> };
  gtpu?: { server?: Array<{ address: string; port?: number; dev?: string }> };
  metrics?: Metrics;
  subnet: Array<{
    addr: string;
    dnn?: string;
  }>;
  dns?: string[];
  mtu?: number;
  ctf?: { enabled?: string };
  freeDiameter?: string;
  info?: Array<{ s_nssai: Snssai[]; dnn: string[] }>;
  time?: {
    t3502?: { value?: number };
    t3512?: { value?: number };
  };
  logger?: Logger;
  global?: Global;
}

// ── UPF ──
export interface UpfConfig {
  pfcp: { server: Array<{ address: string; port?: number; dev?: string }> };
  gtpu: { server: Array<{ address: string; port?: number; dev?: string }> };
  metrics?: Metrics;
  subnet: Array<{
    addr: string;
    dnn?: string;
    dev?: string;
  }>;
  logger?: Logger;
  global?: Global;
}

// ── AUSF ──
export interface AusfConfig {
  sbi: Sbi;
  logger?: Logger;
  global?: Global;
}

// ── UDM ──
export interface UdmConfig {
  sbi: Sbi;
  hnet?: Array<{
    id: number;
    scheme: number;
    key: string;
  }>;
  logger?: Logger;
  global?: Global;
}

// ── UDR ──
export interface UdrConfig {
  db_uri: string;
  sbi: Sbi;
  logger?: Logger;
  global?: Global;
}

// ── PCF ──
export interface PcfConfig {
  sbi: Sbi;
  metrics?: Metrics;
  policy?: Array<{
    plmn_id?: PlmnId;
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
  logger?: Logger;
  global?: Global;
}

// ── NSSF ──
export interface NssfConfig {
  sbi: Sbi;
  nsi?: Array<{
    s_nssai: Snssai;
    nrf?: { sbi: Sbi };
  }>;
  logger?: Logger;
  global?: Global;
}

// ── BSF ──
export interface BsfConfig {
  sbi: Sbi;
  logger?: Logger;
  global?: Global;
}

// ── MME ──
export interface MmeConfig {
  freeDiameter?: string;
  s1ap: { server: Array<{ address: string; dev?: string }> };
  gtpc: {
    server: Array<{ address: string }>;
    client?: {
      sgwc?: Array<{ address: string; tac?: number | number[]; e_cell_id?: string | string[] }>;
      smf?: Array<{ address: string; apn?: string | string[] }>;
    };
  };
  metrics?: Metrics;
  gummei: Array<{
    plmn_id: PlmnId;
    mme_gid: number;
    mme_code: number;
  }>;
  tai: Array<{ plmn_id: PlmnId; tac: number | number[] }>;
  security: { integrity_order: string[]; ciphering_order: string[] };
  network_name?: { full?: string; short?: string };
  mme_name?: string;
  time?: {
    t3402?: { value?: number };
    t3412?: { value?: number };
    t3423?: { value?: number };
  };
  logger?: Logger;
  global?: Global;
}

// ── HSS ──
export interface HssConfig {
  freeDiameter: string;
  logger?: Logger;
  global?: Global;
}

// ── PCRF ──
export interface PcrfConfig {
  freeDiameter: string;
  metrics?: Metrics;
  logger?: Logger;
  global?: Global;
}

// ── SGW-C ──
export interface SgwcConfig {
  gtpc: {
    server: Array<{ address: string }>;
  };
  pfcp: {
    server: Array<{ address: string; port?: number; dev?: string }>;
    client?: {
      sgwu?: Array<{ address: string }>;
    };
  };
  logger?: Logger;
  global?: Global;
}

// ── SGW-U ──
export interface SgwuConfig {
  pfcp: {
    server: Array<{ address: string; port?: number; dev?: string }>;
  };
  gtpu: {
    server: Array<{ address: string; port?: number; dev?: string }>;
  };
  logger?: Logger;
  global?: Global;
}

// ── All Configs ──
export interface AllConfigs {
  nrf: NrfConfig;
  scp: ScpConfig;
  amf: AmfConfig;
  smf: SmfConfig;
  upf: UpfConfig;
  ausf: AusfConfig;
  udm: UdmConfig;
  udr: UdrConfig;
  pcf: PcfConfig;
  nssf: NssfConfig;
  bsf: BsfConfig;
  mme: MmeConfig;
  hss: HssConfig;
  pcrf: PcrfConfig;
  sgwc: SgwcConfig;
  sgwu: SgwuConfig;
}

// ── Topology Types ──
export interface TopologyNode {
  id: string;
  type: ServiceName;
  label: string;
  address: string;
  port: number;
  active: boolean;
}

export interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  label: string;
  valid: boolean;
  errorMessage?: string;
}

export interface TopologyGraph {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

// ── Subscriber Types ──
export interface AmbrValue {
  value: number;
  unit: number;
}

export interface Ambr {
  uplink: AmbrValue;
  downlink: AmbrValue;
}

export interface SubscriberQos {
  index: number;
  arp: {
    priority_level: number;
    pre_emption_capability: number;
    pre_emption_vulnerability: number;
  };
}

export interface SubscriberSession {
  _id?: string;
  name: string;  // DNN/APN
  type: number;  // 1=IPv4, 2=IPv6, 3=IPv4v6
  ambr: Ambr;
  qos: SubscriberQos;
  ue?: { 
    ipv4?: string;   // UE IPv4 address (note: ipv4, not addr)
    ipv6?: string;   // UE IPv6 address (note: ipv6, not addr6)
  };
  smf?: {
    ipv4?: string;   // SMF IPv4 address
    ipv6?: string;   // SMF IPv6 address
  };
  pcc_rule?: unknown[];
}

export interface SubscriberSlice {
  _id?: string;
  sst: number;
  sd?: string;
  default_indicator?: boolean;
  session: SubscriberSession[];
}

export interface Subscriber {
  imsi: string;
  msisdn?: string[];
  imeisv?: string | string[];  // Can be string or array
  mme_host?: string | string[];  // MME hostname
  mme_realm?: string | string[];  // MME realm
  purge_flag?: boolean | boolean[];  // Purge flag for detach
  mme_timestamp?: number;  // MME timestamp
  security: {
    k: string;
    op?: string | null;
    opc: string;
    amf: string;
    sqn?: number;
  };
  ambr: Ambr;
  slice: SubscriberSlice[];
  subscribed_rau_tau_timer?: number;  // in minutes
  subscriber_status?: number;  // 0=SERVICE_GRANTED, 1=OPERATOR_DETERMINED_BARRING
  operator_determined_barring?: number;  // Bitmask
  access_restriction_data?: number;  // Bitmask (32 = default)
  network_access_mode?: number;  // 0=PACKET_AND_CIRCUIT, 2=ONLY_PACKET
}

export interface SubscriberListItem {
  imsi: string;
  msisdn?: string[];
  slice_count: number;
  session_count: number;
}

// ── Validation ──
export interface ValidationError {
  field: string;
  message: string;
  service?: string;
  severity: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// ── Apply ──
export interface ApplyResult {
  success: boolean;
  diff: string;
  validationErrors: ValidationError[];
  restartResults: Array<{ service: string; success: boolean; error?: string }>;
  rollback: boolean;
  prometheusReloaded?: boolean;
  prometheusReloadError?: string;
}

// ── Audit ──
export interface AuditLogEntry {
  id: string;
  timestamp: string;
  action: string;
  user: string;
  target?: string;
  details?: string;
  diffSummary?: string;
  success: boolean;
}
