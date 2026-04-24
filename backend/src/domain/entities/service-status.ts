// All Open5GS Network Functions (4G EPC + 5G Core) + infrastructure services
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
  // 4G EPC
  | 'mme'    // Mobility Management Entity
  | 'hss'    // Home Subscriber Server
  | 'pcrf'   // Policy and Charging Rules Function
  | 'sgwc'   // Serving Gateway Control Plane
  | 'sgwu';  // Serving Gateway User Plane

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
  // 4G EPC
  mme: 'open5gs-mmed',
  hss: 'open5gs-hssd',
  pcrf: 'open5gs-pcrfd',
  sgwc: 'open5gs-sgwcd',
  sgwu: 'open5gs-sgwud',
};

// Proper restart order: Control plane BEFORE user plane to avoid PFCP errors
export const SERVICE_RESTART_ORDER: ServiceName[] = [
  // Infrastructure first — all NFs depend on MongoDB
  'mongodb',
  // Core services
  'hss',
  'pcrf',
  'nrf',
  'scp',
  // Note: 'sepp' not included (not in current deployment)
  'ausf',
  'udm',
  'pcf',
  'nssf',
  'bsf',
  'udr',
  // Control plane (MUST be before user plane)
  'amf',
  'smf',    // SMF control plane before UPF user plane
  'mme',
  'sgwc',   // SGWC control plane before SGWU user plane
  // User plane LAST (depends on control plane PFCP association)
  'upf',    // UPF after SMF
  'sgwu',   // SGWU after SGWC
];

export interface ServiceStatus {
  name: ServiceName;
  unitName: string;
  active: boolean;
  enabled: boolean;  // Boot-time enabled status
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

export interface ServiceStatusMap {
  [key: string]: ServiceStatus;
}
