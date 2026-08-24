import axios from 'axios';

const api = axios.create({ baseURL: '/api/vectorcore-smsc', withCredentials: true });

export interface VectorcoreSmscStatus {
  installed: boolean;
  serviceActive: boolean;
  healthy: boolean;
  hasSavedConfig: boolean;
  installedWithVersion?: string;
  installStale: boolean;
  imsInstalled: boolean;
  imsConfigured: boolean;
  // Live-derived from the IMS module's own config, not something the
  // operator enters here.
  imsDomain?: string;
  currentConfig?: { imsDomain: string };
  appVersion: string;
  configuredWithVersion?: string;
  configStale: boolean;
  sipAddress: string;
}

export const vectorcoreSmscApi = {
  getStatus:  async (): Promise<VectorcoreSmscStatus> => { const { data } = await api.get('/status'); return data; },
  configure:  async () => { const { data } = await api.post('/configure'); return data; },
  start:      async () => { const { data } = await api.post('/start');   return data; },
  stop:       async () => { const { data } = await api.post('/stop');    return data; },
  restart:    async () => { const { data } = await api.post('/restart'); return data; },
  install:    () => fetch('/api/vectorcore-smsc/install',   { method: 'POST', credentials: 'include' }),
  uninstall:  () => fetch('/api/vectorcore-smsc/uninstall', { method: 'POST', credentials: 'include' }),
  // Read-only proxy into VectorCore's own admin API (backend-authenticated —
  // VectorCore SMSC's :8092 has zero auth of its own). subPath is everything
  // after /api/vectorcore-smsc/admin/, e.g. 'api/v1/messages'.
  getAdmin: async <T = any>(subPath: string): Promise<T> => {
    const { data } = await api.get(`/admin/${subPath}`);
    return data;
  },
};
