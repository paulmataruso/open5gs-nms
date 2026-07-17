// All Open5GS Network Functions (4G EPC + 5G Core) + infrastructure + Osmocom services
export type ServiceName =
  // Infrastructure
  | 'mongodb' // MongoDB database (required by HSS, UDR, PCRF)
  // 5G Core (SA)
  | 'nrf'    // Network Repository Function
  | 'scp'    // Service Communication Proxy
  | 'amf'    // Access and Mobility Management Function
  | 'smf'    // Session Management Function
  | 'upf'    // User Plane Function
  | 'ausf'   // Authentication Server Function
  | 'udm'    // Unified Data Management
  | 'udr'    // Unified Data Repository
  | 'pcf'    // Policy Control Function
  | 'nssf'   // Network Slice Selection Function
  | 'bsf'    // Binding Support Function
  | 'sepp1'  // Security Edge Protection Proxy (roaming — N32 to a visited PLMN's SEPP)
  // 4G EPC
  | 'mme'    // Mobility Management Entity
  | 'hss'    // Home Subscriber Server
  | 'pcrf'   // Policy and Charging Rules Function
  | 'sgwc'   // Serving Gateway Control Plane
  | 'sgwu'   // Serving Gateway User Plane
  // Osmocom (SMS over SGs)
  | 'osmo-stp'  // Signalling Transfer Point
  | 'osmo-hlr'  // Home Location Register
  | 'osmo-msc'; // Mobile Switching Centre

export const SERVICE_UNIT_MAP: Record<ServiceName, string> = {
  // Infrastructure
  mongodb: 'mongod',
  // 5G Core
  nrf: 'open5gs-nrfd',
  scp: 'open5gs-scpd',
  amf: 'open5gs-amfd',
  smf: 'open5gs-smfd',
  upf: 'open5gs-upfd',
  ausf: 'open5gs-ausfd',
  udm: 'open5gs-udmd',
  udr: 'open5gs-udrd',
  pcf: 'open5gs-pcfd',
  nssf: 'open5gs-nssfd',
  bsf: 'open5gs-bsfd',
  sepp1: 'open5gs-seppd',
  // 4G EPC
  mme: 'open5gs-mmed',
  hss: 'open5gs-hssd',
  pcrf: 'open5gs-pcrfd',
  sgwc: 'open5gs-sgwcd',
  sgwu: 'open5gs-sgwud',
  // Osmocom
  'osmo-stp': 'osmo-stp',
  'osmo-hlr': 'osmo-hlr',
  'osmo-msc': 'osmo-msc',
};

// Proper restart order: Control plane BEFORE user plane to avoid PFCP errors
export const SERVICE_RESTART_ORDER: ServiceName[] = [
  // Infrastructure first — all NFs depend on MongoDB
  'mongodb',
  // Subscriber data and AAA support (4G)
  'hss',
  'pcrf',
  // Service discovery — all NFs register here on startup
  'nrf',
  'scp',
  // Support NFs (depend on NRF)
  'ausf',
  'udm',
  'udr',
  'pcf',
  'nssf',
  'bsf',
  'sepp1',
  // User plane BEFORE control plane — SMF/SGWC establish PFCP to UPF/SGWU on startup.
  // If UPF is up first, PFCP association is ready immediately when SMF comes up.
  'upf',
  'sgwu',
  // Session/gateway control plane BEFORE access management.
  // SMF must be fresh and PFCP-associated BEFORE AMF restarts. When AMF restarts, the
  // gNB drops all UE N2 connections, forcing every UE to re-register and request a new
  // PDU session. If SMF is not ready first, the new sm-contexts land in a stale SMF
  // and UEs immediately enter a 404 loop that persists until they manually reconnect.
  'smf',
  'sgwc',
  // Access management LAST — restarting AMF is what triggers mass UE re-registration.
  // By this point UPF+SMF are fresh, so re-registering UEs get clean PDU sessions.
  'amf',
  'mme',
];

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
  // 'systemd' = found via systemctl, 'docker' = found via docker, 'direct' = TCP ping
  source?: 'systemd' | 'docker' | 'direct';
}

export interface ServiceStatusMap {
  [key: string]: ServiceStatus;
}
