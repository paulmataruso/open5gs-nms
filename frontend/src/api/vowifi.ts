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

  uninstall: () => fetch('/api/vowifi/uninstall', { method: 'POST', credentials: 'include' }),
};
