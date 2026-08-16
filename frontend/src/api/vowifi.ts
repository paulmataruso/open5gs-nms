import axios from 'axios';

const api = axios.create({ baseURL: '/api/vowifi', withCredentials: true });

export type VowifiInstallStatus =
  | 'idle' | 'preparing' | 'installing_apt_deps' | 'installing_vectorcore_epdg'
  | 'installing_vectorcore_aaa' | 'verifying' | 'complete' | 'failed';

export interface VowifiStatus {
  success: boolean;
  installedOnDisk: boolean;
  builtWithVectorcoreEpdgCommit: string | null;
  currentVectorcoreEpdgCommit: string;
  builtWithVectorcoreAaaCommit: string | null;
  currentVectorcoreAaaCommit: string;
  builtWithVectorcorePatchRev: number | null;
  currentVectorcorePatchRev: number;
  buildStale: boolean;
  installStatus: VowifiInstallStatus;
  installStartedAt: string | null;
  installCompletedAt: string | null;
  installError: string | null;
  configured: boolean;
  configuredAt: string | null;
  configuredWithVersion: number | null;
  currentConfigGenVersion: number;
  configStale: boolean;
  epdgIp: string | null;
  epdgInterfaceMode: 'dummy' | 'existing' | null;
  aaaListenIp: string | null;
  aaaFqdn: string | null;
  smfConnectPeerPresent: boolean;
  dummyInterfaceUp: boolean;
  activeClients: number;
  services: {
    'vowifi-vectorcore-epdg': boolean;
    'vowifi-vectorcore-aaa': boolean;
  };
}

export interface VowifiConfigureInput {
  epdgIp?: string;
  aaaListenIp?: string;
  // 'dummy' (default): create+own a new dummy-epdg interface with epdgIp assigned.
  // 'existing': skip interface creation — epdgIp must already be bound to a loopback
  // alias or a real LAN interface by the operator (any L3-reachable IP works).
  interfaceMode?: 'dummy' | 'existing';
}

export interface VowifiConfigFile {
  path: string;
  label: string;
  group: string;
  language: string;
  restartServices: string[];
  exists: boolean;
}

// Admin API shapes, from VectorCore ePDG's own /docs/API.md — kept minimal/loose
// (only the fields the status panel actually renders) since this is a third-party
// upstream schema, not something this project owns.
export interface VectorcoreClient {
  imsi: string;
  ue_ip: string;
  outer_ip: string;
  apn: string;
  state: string;
}

export interface VectorcoreStats {
  active_clients: number;
  active_ike_sas: number;
  active_child_sas: number;
  active_bearers: number;
}

// GET /api/v1/sessions — richer than /api/v1/clients: real IKE/ESP SPIs and the S2b
// GTP-C tunnel identifiers to the PGW (SMF), not just the coarse client summary.
export interface VectorcoreSession {
  imsi: string;
  ue_ip: string;
  outer_ip: string;
  apn: string;
  state: string;
  ike_sa: { spi_i: string; spi_r: string };
  child_sa: { esp_spi_in: string; esp_spi_out: string };
  s2b: { pgw: string; control_teid: number; data_teid: number };
}

// GET /api/v1/clients/{imsi}/diag — per-bearer traffic counters + timestamps, fetched
// lazily per client (Details button) rather than eagerly for every session on every poll.
export interface VectorcoreBearer {
  ebi: number;
  local_teid: number;
  pgw_teid: number;
  qci: number;
  uplink_packets: number;
  uplink_bytes: number;
  downlink_packets: number;
  downlink_bytes: number;
  last_uplink_packet: string | null;
}
export interface VectorcoreClientDiag {
  imsi: string;
  ue_ip: string;
  outer_ip: string;
  apn: string;
  state: string;
  ike_spi_i: string;
  ike_spi_r: string;
  esp_spi_in: string;
  esp_spi_out: string;
  pgw_control_ip: string;
  pgw_control_teid: number;
  default_bearer: VectorcoreBearer;
  dedicated_bearers: VectorcoreBearer[] | null;
  last_activity: string;
}

export interface VectorcoreIpsecStats {
  active_ike_sas: number;
  active_child_sas: number;
  esp_packets_in: number;
  esp_packets_out: number;
  esp_bytes_in: number;
  esp_bytes_out: number;
}

export interface VectorcoreGtpuStats {
  uplink_rx_packets: number;
  uplink_tx_packets: number;
  downlink_rx_packets: number;
  downlink_tx_packets: number;
  dropped_bad_teid: number;
  dropped_bad_peer: number;
  dropped_unsupported: number;
  dropped_malformed: number;
  error_indications_sent: number;
  error_indications_rate_limited: number;
  active_tunnels: number;
  active_bearers: number;
}

export interface VectorcoreStatusInfo {
  version: string;
  build_date: string;
  uptime_seconds: number;
  active_clients: number;
}

export const vowifiApi = {
  getStatus: async (): Promise<VowifiStatus> => { const { data } = await api.get('/status'); return data; },

  install: () => fetch('/api/vowifi/install', { method: 'POST', credentials: 'include' }),
  getInstallLog: async (): Promise<string> => { const { data } = await api.get('/install/log', { responseType: 'text' }); return data; },
  streamInstallLog: () => fetch('/api/vowifi/install/log/stream', { credentials: 'include' }),

  configure: async (input: VowifiConfigureInput) => { const { data } = await api.post('/configure', input); return data; },

  start:   async () => { const { data } = await api.post('/start');   return data; },
  stop:    async () => { const { data } = await api.post('/stop');    return data; },
  restart: async () => { const { data } = await api.post('/restart'); return data; },

  getConfigs:        async (): Promise<{ success: boolean; configs: VowifiConfigFile[] }> => { const { data } = await api.get('/configs'); return data; },
  getConfigContent:  async (filePath: string): Promise<{ success: boolean; content: string }> => {
    const { data } = await api.get('/configs/content', { params: { path: filePath } });
    return data;
  },
  saveConfigContent: async (filePath: string, content: string): Promise<{ ok: boolean }> => {
    const { data } = await api.put('/configs/content', { path: filePath, content });
    return data;
  },

  // Thin proxy into VectorCore ePDG's own read-only admin API (see vowifi-controller.ts's
  // /admin/* route) — same pattern as the MMS admin-proxy panel.
  getClients: async (): Promise<VectorcoreClient[]> => { const { data } = await api.get('/admin/api/v1/clients'); return data ?? []; },
  getStats:   async (): Promise<VectorcoreStats> => { const { data } = await api.get('/admin/api/v1/stats'); return data; },
  getSessions:    async (): Promise<VectorcoreSession[]> => { const { data } = await api.get('/admin/api/v1/sessions'); return data ?? []; },
  getClientDiag:  async (imsi: string): Promise<VectorcoreClientDiag> => { const { data } = await api.get(`/admin/api/v1/clients/${imsi}/diag`); return data; },
  getIpsecStats:  async (): Promise<VectorcoreIpsecStats> => { const { data } = await api.get('/admin/api/v1/stats/ipsec'); return data; },
  getGtpuStats:   async (): Promise<VectorcoreGtpuStats> => { const { data } = await api.get('/admin/api/v1/stats/gtpu'); return data; },
  getVectorcoreStatusInfo: async (): Promise<VectorcoreStatusInfo> => { const { data } = await api.get('/admin/api/v1/status'); return data; },

  uninstall: () => fetch('/api/vowifi/uninstall', { method: 'POST', credentials: 'include' }),
};
