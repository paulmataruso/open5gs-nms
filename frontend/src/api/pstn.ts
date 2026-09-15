import axios from 'axios';

const api = axios.create({ baseURL: '/api/pstn', withCredentials: true });

export interface PstnStatus {
  installed: boolean;
  services: { asterisk: boolean; 'kamailio-scscf': boolean };
  codecAmrLoaded: boolean;
  codecGsmLoaded: boolean;
  crossRanEnabled: boolean;
  imsInstalled: boolean;
  imsConfigured: boolean;
  hasSavedConfig: boolean;
  dispatcherWired: boolean;
  pstnEnabled: boolean;
  currentConfig?: { asteriskIp: string; echoTestNumber?: string };
  extensionCount: number;
  appVersion: string;
  configuredWithVersion?: string;
  configStale: boolean;
}

export interface PstnExtension {
  extension: string;
  subscriberImsi: string;
  subscriberNickname?: string;
  subscriberMsisdn?: string;
  label?: string;
  createdAt: string;
}

export interface PstnConfigFile {
  path: string; label: string; group: string; language: string;
  restartServices: string[]; exists: boolean;
}

export const pstnApi = {
  getStatus:  async (): Promise<PstnStatus> => { const { data } = await api.get('/status'); return data; },
  configure:  async (asteriskIp?: string, echoTestNumber?: string) => { const { data } = await api.post('/configure', { asteriskIp, echoTestNumber }); return data; },
  enable:     async () => { const { data } = await api.post('/enable'); return data; },
  disable:    async () => { const { data } = await api.post('/disable'); return data; },
  // Same shape as enable/disable above — a 400 throws (caller catches
  // err.response.data.error/.collisions), matching every other mutating
  // call in this file rather than swallowing the error here.
  enableCrossRan:  async () => { const { data } = await api.post('/cross-ran/enable'); return data; },
  disableCrossRan: async () => { const { data } = await api.post('/cross-ran/disable'); return data; },
  start:      async () => { const { data } = await api.post('/start'); return data; },
  stop:       async () => { const { data } = await api.post('/stop'); return data; },
  restart:    async () => { const { data } = await api.post('/restart'); return data; },
  install:    () => fetch('/api/pstn/install', { method: 'POST', credentials: 'include' }),
  uninstall:  () => fetch('/api/pstn/uninstall', { method: 'POST', credentials: 'include' }),
  listExtensions: async (): Promise<{ extensions: PstnExtension[] }> => { const { data } = await api.get('/extensions'); return data; },
  addExtension:   async (extension: string, subscriberImsi: string, label?: string) => {
    const { data } = await api.post('/extensions', { extension, subscriberImsi, label }); return data;
  },
  removeExtension: async (extension: string) => {
    const { data } = await api.delete(`/extensions/${encodeURIComponent(extension)}`); return data;
  },
  getConfigs: async (): Promise<{ success: boolean; files: PstnConfigFile[] }> => {
    const { data } = await api.get('/configs');
    return data;
  },
  getConfigContent: async (path: string): Promise<{ success: boolean; content: string }> => {
    const { data } = await api.get('/configs/content', { params: { path } });
    return data;
  },
  saveConfigContent: async (path: string, content: string) => {
    const { data } = await api.put('/configs/content', { path, content });
    return data;
  },
  restartServices: async (services: string[]) => {
    const { data } = await api.post('/configs/restart', { services });
    return data;
  },
};
