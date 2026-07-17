import axios from 'axios';
import type { AuthUser } from '../contexts/AuthContext';
import type {
  AllConfigs,
  ServiceStatus,
  Subscriber,
  SubscriberListItem,
  TopologyGraph,
  ValidationResult,
  ApplyResult,
  AuditLogEntry,
  FramedRouteEntry,
} from '../types';
import type { InterfaceStatus } from '../stores';

const API_URL = import.meta.env.VITE_API_URL || '';

const api = axios.create({
  baseURL: `${API_URL}/api`,
  timeout: 60000, // 60 seconds for apply operations that restart all services
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true, // send session cookie on every request
});

// ── 401 / 403 interceptor ──
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (
      error.response?.status === 401 &&
      !error.config?.url?.includes('/auth/me') &&
      !error.config?.url?.includes('/auth/login')
    ) {
      window.location.reload();
    }
    if (error.response?.status === 403) {
      // Lazy import toast to avoid circular deps
      import('react-hot-toast').then(({ default: toast }) => {
        toast.error(
          '🔒 Permission denied — your account is view-only and cannot make changes.',
          { id: 'forbidden', duration: 5000 },
        );
      });
    }
    return Promise.reject(error);
  },
);

// ── Config ──
export const configApi = {
  getAll: () => api.get<{ success: boolean; data: AllConfigs }>('/config').then((r) => r.data.data),
  getService: (name: string) => api.get(`/config/${name}`).then((r) => r.data.data),
  validate: (configs?: AllConfigs) =>
    api.post<{ success: boolean; data: ValidationResult }>('/config/validate', configs || {}).then((r) => r.data.data),
  apply: (configs: AllConfigs) =>
    api.post<{ success: boolean; data: ApplyResult }>('/config/apply', configs).then((r) => r.data.data),
  getTopology: () =>
    api.get<{ success: boolean; data: TopologyGraph }>('/config/topology/graph').then((r) => r.data.data),
  syncSD: (sd: string, sst?: number) =>
    api.post<{ success: boolean; data: { smf_slices: number; subscribers: number } }>('/config/sync-sd', { sd, sst }).then((r) => r.data),
};

// ── Services ──
export const serviceApi = {
  getAll: () => api.get<{ success: boolean; data: ServiceStatus[] }>('/services').then((r) => r.data.data),
  getOne: (name: string) =>
    api.get<{ success: boolean; data: ServiceStatus }>(`/services/${name}`).then((r) => r.data.data),
  action: (name: string, action: 'start' | 'stop' | 'restart' | 'enable' | 'disable') =>
    api.post<{ success: boolean; message: string }>(`/services/${name}/${action}`).then((r) => r.data),
  bulkAction: (action: 'start' | 'stop' | 'restart', services?: string[]) =>
    api.post<{ success: boolean; message: string; results: Array<{ service: string; success: boolean }> }>(`/services/all/${action}`, { services }).then((r) => r.data),
};

// ── Subscribers ──
export const radioTagsApi = {
  getAll: () =>
    api.get<Record<string, string>>('/radio-tags').then(r => r.data),
  set: (ip: string, nickname: string) =>
    api.put(`/radio-tags/${encodeURIComponent(ip)}`, { nickname }).then(r => r.data),
  remove: (ip: string) =>
    api.delete(`/radio-tags/${encodeURIComponent(ip)}`).then(r => r.data),
};

export const tunApi = {
  list: () =>
    api.get<{ interfaces: TunInterface[]; networkdActive: boolean; nextName: string }>('/tun-interfaces').then(r => r.data),
  create: (data: { name: string; ip: string; prefix: number }) =>
    api.post('/tun-interfaces', data).then(r => r.data),
  edit: (name: string, data: { ip: string; prefix: number }) =>
    api.put(`/tun-interfaces/${name}`, data).then(r => r.data),
  delete: (name: string) =>
    api.delete(`/tun-interfaces/${name}`).then(r => r.data),
  setUp: (name: string) =>
    api.post(`/tun-interfaces/${name}/up`).then(r => r.data),
  setDown: (name: string) =>
    api.post(`/tun-interfaces/${name}/down`).then(r => r.data),
};

export interface TunInterface {
  name: string;
  ip: string;
  prefix: number;
  state: 'up' | 'down';
  managed: boolean;
  default: boolean;
  exists: boolean;
}

export const subscriberApi = {
  list: (skip = 0, limit = 50, search?: string, sortOrder?: 'asc' | 'desc', sortBy?: 'imsi' | 'ue_ipv4' | 'apn') =>
    api.get<{ subscribers: SubscriberListItem[]; total: number }>('/subscribers', { params: { skip, limit, search, sortOrder, sortBy } }).then((r) => r.data),
  get: (imsi: string) =>
    api.get<Subscriber>(`/subscribers/${imsi}`).then((r) => r.data),
  create: (subscriber: Subscriber) =>
    api.post<{ message: string; warnings?: string[] }>('/subscribers', subscriber).then((r) => r.data),
  update: (imsi: string, subscriber: Partial<Subscriber>) =>
    api.put<{ message: string; warnings?: string[] }>(`/subscribers/${imsi}`, subscriber).then((r) => r.data),
  getFramedRoutes: () =>
    api.get<FramedRouteEntry[]>('/subscribers/framed-routes').then((r) => r.data),
  delete: (imsi: string) =>
    api.delete(`/subscribers/${imsi}`).then((r) => r.data),
  getAutoAssignIPsPool: () =>
    api.get<{ success: boolean; data: { ipPool: string; startIp: string; endIp: string; gatewayIp: string | null; totalSubscribers: number; withIp: number; withoutIp: number; imsApn?: string; imsPool?: string; imsStartIp?: string; imsEndIp?: string; imsGatewayIp?: string | null; imsWithIp?: number; imsWithoutIp?: number } }>('/subscribers/auto-assign-ips/pool').then((r) => r.data),
  autoAssignIPs: (opts?: { startIp?: string; endIp?: string; overwrite?: boolean; imsStartIp?: string; imsEndIp?: string; imsOverwrite?: boolean }) =>
    api.post<{ success: boolean; data: { assigned: number; skipped: number; failed: number; ipPool: string; errors?: string[] } }>('/subscribers/auto-assign-ips', opts ?? {}).then((r) => r.data),
  autoAssignMsisdn: (startingNumber: string, overwrite: boolean) =>
    api.post<{ success: boolean; data: { assigned: number; skipped: number } }>('/subscribers/auto-assign-msisdn', { startingNumber, overwrite }).then((r) => r.data),
  getIPAssignments: () =>
    api.get<{ success: boolean; data: Array<{ imsi: string; ipv4: string }> }>('/subscribers/ip-assignments').then((r) => r.data),
  exportCSV: (format: 'csv' | 'tsv' = 'csv') =>
    `${API_URL}/api/subscribers/export?format=${format}`,
  importCSV: (csv: string, mode: 'skip' | 'overwrite' = 'skip') =>
    api.post<{ success: boolean; imported: number; skipped: number; overwritten: number; errors: string[] }>('/subscribers/import', { csv, mode }).then((r) => r.data),
  bulkAddApn: (sessions: any[], overwrite: boolean, sst: number, sd?: string) =>
    api.post<{ success: boolean; data: { updated: number; skipped: number; errors: string[] } }>('/subscribers/bulk-add-apn', { sessions, overwrite, sst, sd: sd || undefined }).then((r) => r.data),
};

// ── Subscriber Groups ──
export interface SubscriberGroup {
  _id: string;
  name: string;
  imsis: string[];
  color: string | null;
  createdAt: number;
}

export const subscriberGroupsApi = {
  list: () =>
    api.get<{ success: boolean; data: SubscriberGroup[] }>('/subscriber-groups').then(r => r.data.data),
  create: (name: string, imsis: string[], color?: string) =>
    api.post<{ success: boolean; data: SubscriberGroup }>('/subscriber-groups', { name, imsis, color }).then(r => r.data.data),
  update: (id: string, patch: { name?: string; imsis?: string[]; color?: string }) =>
    api.put(`/subscriber-groups/${id}`, patch).then(r => r.data),
  delete: (id: string) =>
    api.delete(`/subscriber-groups/${id}`).then(r => r.data),
};

// ── Audit ──
export const auditApi = {
  getAll: (skip = 0, limit = 100, action?: string) =>
    api
      .get<{ entries: AuditLogEntry[]; total: number }>('/audit', {
        params: { skip, limit, action },
      })
      .then((r) => r.data),
};

// ── Health ──
export const healthApi = {
  check: () => api.get('/health').then((r) => r.data),
};

// ── Interface Status ──
export const interfaceApi = {
  getStatus: () => api.get<InterfaceStatus>('/interface-status').then((r) => r.data),
};

// ── Backup & Restore ──
export const backupApi = {
  restoreDefaults: () => 
    api.post<{ success: boolean; message: string; backupCreated: string }>('/backup/restore-defaults').then((r) => r.data),
};

// ── Auth ──
export const authApi = {
  login: (username: string, password: string): Promise<AuthUser> =>
    api
      .post<{ success: boolean; data: { user: AuthUser } }>('/auth/login', { username, password })
      .then((r) => r.data.data.user),

  logout: (): Promise<void> =>
    api.post('/auth/logout').then(() => undefined),

  me: (): Promise<AuthUser> =>
    api
      .get<{ success: boolean; data: { user: AuthUser } }>('/auth/me')
      .then((r) => r.data.data.user),
};

// ── Users ──
export const usersApi = {
  list: (): Promise<AuthUser[]> =>
    api.get<{ success: boolean; data: { users: AuthUser[] } }>('/users').then((r) => r.data.data.users),

  create: (username: string, password: string, role: 'admin' | 'viewer' = 'admin'): Promise<AuthUser> =>
    api.post<{ success: boolean; data: { user: AuthUser } }>('/users', { username, password, role }).then((r) => r.data.data.user),

  updateRole: (id: string, role: 'admin' | 'viewer'): Promise<void> =>
    api.patch(`/users/${id}/role`, { role }).then(() => undefined),

  changePassword: (id: string, password: string): Promise<void> =>
    api.put(`/users/${id}/password`, { password }).then(() => undefined),

  delete: (id: string): Promise<void> =>
    api.delete(`/users/${id}`).then(() => undefined),
};

export interface PlmnConfig {
  mcc: string;
  mnc: string;
  mme_gid?: number;
  mme_code?: number;
  tac?: number;
}

export interface SessionPool {
  subnet: string;
  gateway?: string;
  dnn?: string;
  dev?: string;
}

export interface AutoConfigInput {
  plmn4g: PlmnConfig[];
  plmn5g: PlmnConfig[];
  s1mmeIP?: string;
  s1mmeDev?: string;
  sgwuGtpIP: string;
  amfNgapIP?: string;
  amfNgapDev?: string;
  upfGtpIP: string;
  smfPfcpIP?: string;
  localUpfPfcpIP?: string;
  localUpfOnly?: boolean;
  // 4G SGW-C / SGW-U PFCP addressing
  localSgwuOnly?: boolean;
  sgwcPfcpIP?: string;
  remoteSgwus?: Array<{
    pfcpIP: string;
    gtpuIP: string;
    tac?: number[];
    label?: string;
  }>;
  sessionPools: SessionPool[];
  sessionPoolIPv4Subnet?: string;
  sessionPoolIPv4Gateway?: string;
  sessionPoolIPv6Subnet?: string;
  sessionPoolIPv6Gateway?: string;
  configureNAT: boolean;
  natInterface?: string;
}

export interface AutoConfigResult {
  success: boolean;
  message: string;
  backupCreated?: string;
  updatedFiles: string[];
  errors?: string[];
}

export const autoConfigApi = {
  preview: (input: AutoConfigInput) =>
    api.post<{ success: boolean; message?: string; diffs: Record<string, string> }>('/auto-config/preview', input).then((r) => r.data),
  apply: (input: AutoConfigInput) =>
    api.post<AutoConfigResult>('/auto-config/apply', input).then((r) => r.data),
};

export { genieacsApi } from './genieacs';
export type { BaicellsRadio, ProvisionInput, NbiTask, RadioBackup, SercommRadio, SercommProvisionInput } from './genieacs';

// ── Sercomm NR (5G) ──
export interface SercommNRDevice {
  id: string;
  serial: string;
  model: string;
  ip: string | null;
  mac: string | null;
  lastInform: string | null;
  nrConfig: {
    plmn: string;
    gnbId: number;
    tac: number;
    amfIp: string;
    upfIp: string;
    adminState: string;
    pci: string | null;
    encAlg: string | null;
    intAlg: string | null;
    nrPci: string | null;
    nrArfcn: string | null;
    nrArfcn2: string | null;
    nrPci2: string | null;
    nrArfcn3: string | null;
    nrPci3: string | null;
    nrBandWidth: string | null;
    nrFreqBand: string | null;
    txPwr: string | null;
    prachCfgIdx: string | null;
    numDlSlot: string | null;
    numUlSlot: string | null;
    numDlSymbol: string | null;
    numUlSymbol: string | null;
    np2Pres: string | null;
    numDlSlot2: string | null;
    numUlSlot2: string | null;
    numDlSymbolP2: string | null;
    numUlSymbolP2: string | null;
    snssaiSst: number;
    snssaiSd: string;
    gNBCUName: string | null;
    maxNumUes: string | null;
    antennaGain: string | null;
    antennaAzimuth: string | null;
    antennaBeamwidth: string | null;
    antennaDowntilt: string | null;
    sasMaxTxPower: string | null;
  };
  sasConfig: {
    enable: boolean;
    url: string;
    latitude: number;
    longitude: number;
    category: string;
    location: string;
    heightType: string;
    groupId: string;
    peerVerify: boolean;
    bwAllowList: string;
    cellNum: number | null;
  };
  sasStatus: {
    state: string;
    registered: string;
    cbsdId: string;
    grantedArfcn: string;
    grantedArfcn2: string;
    grantedArfcn3: string;
    sasStatus: string;
  };
}

export interface NRConfigInput {
  mcc: string;
  mnc: string;
  tac: number;
  gnbId: number;
  cellCount: number;
  amfIp: string;
  upfIp: string;
  sasUrl: string;
  sasEnable: boolean;
  sasCategory?: string;
  sasLocation?: string;
  sasLocationSource?: string;
  sasHeightType?: string;
  sasIcgGroupId?: string;
  sasPeerCertVerify?: boolean;
  sasUserId?: string;
  latitude: number;
  longitude: number;
  unlockCell: boolean;
  neaAlgorithm?: string;
  niaAlgorithm?: string;
  nrPci?: number;
  nrArfcn?: number;
  nrArfcn2?: number; nrPci2?: number;
  nrArfcn3?: number; nrPci3?: number;
  sasCellNum?: number;
  nrBandWidth?: number;
  nrFreqBand?: number;
  txPwr?: number;
  prachCfgIdx?: number;
  numDlSlot?: number;
  numUlSlot?: number;
  numDlSymbol?: number;
  numUlSymbol?: number;
  np2Pres?: number;
  numDlSlot2?: number;
  numUlSlot2?: number;
  numDlSymbolP2?: number;
  numUlSymbolP2?: number;
  snssaiSst?: number;
  snssaiSd?: string;
  gNBCUName?: string;
  maxNumUes?: number;
  antennaGain?: number;
  antennaAzimuth?: number;
  antennaBeamwidth?: number;
  antennaDowntilt?: number;
  sasMaxTxPower?: number;
  bwAllowList?: string;
}

export const sercommNRApi = {
  listDevices: (): Promise<{ success: boolean; devices: SercommNRDevice[] }> =>
    api.get('/femto/nr/devices').then(r => r.data),

  configure: (id: string, input: NRConfigInput): Promise<{ success: boolean; message: string }> =>
    api.post(`/femto/nr/devices/${encodeURIComponent(id)}/configure`, input).then(r => r.data),

  unlock: (id: string): Promise<{ success: boolean }> =>
    api.post(`/femto/nr/devices/${encodeURIComponent(id)}/unlock`).then(r => r.data),

  lock: (id: string): Promise<{ success: boolean }> =>
    api.post(`/femto/nr/devices/${encodeURIComponent(id)}/lock`).then(r => r.data),

  reboot: (id: string): Promise<{ success: boolean }> =>
    api.post(`/femto/nr/devices/${encodeURIComponent(id)}/reboot`).then(r => r.data),

  refresh: (id: string): Promise<{ success: boolean }> =>
    api.post(`/femto/nr/devices/${encodeURIComponent(id)}/refresh`).then(r => r.data),

  sasRestart: (id: string): Promise<{ success: boolean; message: string }> =>
    api.post(`/femto/nr/devices/${encodeURIComponent(id)}/sas-restart`).then(r => r.data),
};
