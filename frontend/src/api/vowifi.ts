import axios from 'axios';

const api = axios.create({ baseURL: '/api/vowifi', withCredentials: true });

export type VowifiInstallStatus =
  | 'idle' | 'preparing' | 'installing_libosmocore' | 'installing_osmo_epdg'
  | 'installing_strongswan' | 'verifying' | 'complete' | 'failed';

export interface VowifiStatus {
  success: boolean;
  installedOnDisk: boolean;
  installStatus: VowifiInstallStatus;
  installStartedAt: string | null;
  installCompletedAt: string | null;
  installError: string | null;
  configured: boolean;
  configuredAt: string | null;
  epdgIp: string | null;
  epdgInterfaceMode: 'dummy' | 'existing' | null;
  s6bLocalIp: string | null;
  gsupPort: number | null;
  services: {
    'vowifi-osmo-epdg': boolean;
    'vowifi-charon': boolean;
  };
  running: boolean;
  gtpModuleLoaded: boolean;
  dummyInterfaceUp: boolean;
  activeIkeSas: number;
  smfConnectPeerPresent: boolean;
}

export interface VowifiConfigureInput {
  epdgIp?: string;
  s6bLocalIp?: string;
  gsupPort?: number;
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

export const vowifiApi = {
  getStatus: async (): Promise<VowifiStatus> => { const { data } = await api.get('/status'); return data; },

  install: (gsupPort?: number) => fetch('/api/vowifi/install', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(gsupPort ? { gsupPort } : {}),
  }),
  getInstallLog: async (): Promise<string> => { const { data } = await api.get('/install/log', { responseType: 'text' }); return data; },
  streamInstallLog: () => fetch('/api/vowifi/install/log/stream', { credentials: 'include' }),

  configure: async (input: VowifiConfigureInput) => { const { data } = await api.post('/configure', input); return data; },

  start:   async () => { const { data } = await api.post('/start');   return data; },
  stop:    async () => { const { data } = await api.post('/stop');    return data; },
  restart: async () => { const { data } = await api.post('/restart'); return data; },
  reloadGtpModule: async () => { const { data } = await api.post('/reload-gtp-module'); return data; },

  getConfigs:        async (): Promise<{ files: VowifiConfigFile[] }> => { const { data } = await api.get('/configs'); return data; },
  getConfigContent:  async (filePath: string): Promise<{ content: string; exists: boolean }> => {
    const { data } = await api.get('/configs/content', { params: { path: filePath } });
    return data;
  },
  saveConfigContent: async (filePath: string, content: string): Promise<{ success: boolean }> => {
    const { data } = await api.put('/configs/content', { path: filePath, content });
    return data;
  },

  uninstall: () => fetch('/api/vowifi/uninstall', { method: 'POST', credentials: 'include' }),
};
