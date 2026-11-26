// ── Service Types ──
// Mirrors backend/src/domain/entities/service-status.ts's own ServiceName
// union — keep these two in sync. This one had drifted badly out of date
// (missing mongodb, sepp1, and every Osmocom/HNBGW/OCS entry added since);
// caught live when a direct `s.name === 'ocs'` comparison failed to
// typecheck with "no overlap" even though the real backend can send it.
export type ServiceName =
  | 'mongodb'
  | 'nrf' | 'scp' | 'amf' | 'smf' | 'upf' | 'ausf' | 'udm' | 'udr' | 'pcf' | 'nssf' | 'bsf' | 'sepp1'
  | 'mme' | 'hss' | 'pcrf' | 'sgwc' | 'sgwu'
  | 'osmo-stp' | 'osmo-hlr' | 'osmo-msc'
  | 'osmo-bsc' | 'osmo-mgw' | 'osmo-bts-virtual' | 'osmo-pcu' | 'osmo-sgsn' | 'osmo-ggsn' | 'osmo-meas-udp2db' | 'osmo-sip-connector'
  | 'osmo-hnbgw' | 'osmo-mgw-hnbgw'
  | 'ocs';

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
  source?: 'systemd' | 'docker' | 'direct';
}

// ── Open5GS NF config shapes ──
//
// GET /api/config returns each NF's WHOLE parsed YAML document, so the NF's
// own settings sit one level down under its own name, beside the
// document-level `logger`/`global`:
//
//   { logger: {...}, global: {...}, amf: { sbi, ngap, guami, ... } }
//
// This file used to hand-declare the INNER fields at the top level for all 17
// NFs -- a second copy of the same off-by-one-level mistake the backend DTOs
// had, which is why neither side's compiler ever contradicted the other. Every
// consumer then wrote `configs.amf as any` and unwrapped `.amf` by hand, so the
// runtime was right and only the types were wrong.
//
// The shapes now come from ./open5gs-yaml, a verbatim mirror of
// backend/src/domain/entities/open5gs-yaml.ts, pinned by a backend test. None
// of the 17 old per-NF interfaces had an importer outside this file.
export type {
  YamlPlmnId, YamlSnssai, YamlServerEntry, YamlEndpoint, YamlSession,
  YamlUriEntry, YamlSbiClient, YamlSbiEndpoint, YamlPeerEntry,
  YamlSgsapMap, YamlSgsapClient,
  YamlAmf, YamlMme, YamlSmf, YamlUpf, YamlSgwc, YamlSgwu, YamlNrf,
  YamlScp, YamlAusf, YamlUdm, YamlUdr, YamlPcf, YamlNssf, YamlBsf,
  YamlSepp, YamlHss, YamlPcrf,
  YamlDocumentCommon,
  AmfYamlDocument, MmeYamlDocument, SmfYamlDocument, UpfYamlDocument,
  SgwcYamlDocument, SgwuYamlDocument, NrfYamlDocument, ScpYamlDocument,
  AusfYamlDocument, UdmYamlDocument, UdrYamlDocument, PcfYamlDocument,
  NssfYamlDocument, BsfYamlDocument, SeppYamlDocument, HssYamlDocument,
  PcrfYamlDocument,
} from './open5gs-yaml';

import type {
  YamlSbiClient, YamlSbiEndpoint, YamlEndpoint,
  AmfYamlDocument, MmeYamlDocument, SmfYamlDocument, UpfYamlDocument,
  SgwcYamlDocument, SgwuYamlDocument, NrfYamlDocument, ScpYamlDocument,
  AusfYamlDocument, UdmYamlDocument, UdrYamlDocument, PcfYamlDocument,
  NssfYamlDocument, BsfYamlDocument, SeppYamlDocument, HssYamlDocument,
  PcrfYamlDocument, YamlDocumentCommon,
} from './open5gs-yaml';

// Names the config editors import directly. Aliases rather than duplicate
// declarations, so an editor and the document it edits cannot disagree.
export type Sbi = YamlSbiEndpoint;
export type SbiClient = YamlSbiClient;
export type Logger = NonNullable<YamlDocumentCommon['logger']>;
export type Global = NonNullable<YamlDocumentCommon['global']>;
export type Metrics = YamlEndpoint;

// ── All Configs ──
//
// `sepp1` is the key here; the document inside it nests under `sepp`.
export interface AllConfigs {
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
    pre_emption_capability: number;  // 1=Disabled (NOT_PRE-EMPTIVE), 2=Enabled (MAY_PRE-EMPT)
    pre_emption_vulnerability: number;
  };
}

export interface PccRule {
  qos: {
    index: number;
    arp: {
      priority_level: number;
      pre_emption_capability: number;
      pre_emption_vulnerability: number;
    };
    mbr: { downlink: AmbrValue; uplink: AmbrValue };
    gbr: { downlink: AmbrValue; uplink: AmbrValue };
  };
}

export interface SubscriberSession {
  _id?: string;
  name: string;  // DNN/APN
  type: number;  // 1=IPv4, 2=IPv6, 3=IPv4v6
  ambr: Ambr;
  qos: SubscriberQos;
  ue?: {
    ipv4?: string;
    ipv6?: string;
  };
  smf?: {
    ipv4?: string;
    ipv6?: string;
  };
  pcc_rule?: PccRule[];
  ipv4_framed_routes?: string[];  // Framed Routing (TS 23.501 §5.6.14) — IPv4 CIDRs routed behind the UE
  ipv6_framed_routes?: string[];  // Framed Routing — IPv6 prefixes routed behind the UE
  framed_routes_static?: boolean;  // Auto-manage a static host route for the above
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
  nickname?: string;
  iccid?: string;
  simType?: 'esim' | 'physical' | null;
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
  gsmEnabled?: boolean;  // Opt-in: sync this subscriber's K/OPc into OsmoHLR (2G/3G auth) even without an MSISDN
}

export interface SubscriberListItem {
  imsi: string;
  nickname?: string;
  iccid?: string;
  simType?: 'esim' | 'physical' | null;
  msisdn?: string[];
  slice_count: number;
  session_count: number;
  ue_ipv4?: string;
  apn?: string;
  sessions?: { apn: string; ipv4?: string; framedRoutes?: string[] }[];
}

export interface FramedRouteEntry {
  imsi: string;
  nickname?: string;
  apn: string;
  ipv4: string[];
  ipv6: string[];
  static: boolean;
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
