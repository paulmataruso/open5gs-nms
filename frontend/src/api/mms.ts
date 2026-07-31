import axios from 'axios';

const api = axios.create({ baseURL: '/api/mms', withCredentials: true });

export interface MmsStatus {
  installed: boolean;
  serviceActive: boolean;
  healthy: boolean;
  proxyActive: boolean;
  hasSavedConfig: boolean;
  esmeActive: boolean;
  smsConfigured: boolean;
  imsInstalled: boolean;
  imsConfigured: boolean;
  currentConfig?: { deliveryPath: 'sgs'; mm1PublicIp: string };
  appVersion: string;
  configuredWithVersion?: string;
  configStale: boolean;
}

export interface MmsSyncResult {
  success: boolean;
  synced: number;
  failed: string[];
  removed: number;
  message?: string;
}

export interface VectorCoreMessage {
  id: string;
  transactionId?: string;
  status: string;
  direction: string;
  origin: string;
  from: string;
  to: string[];
  contentType?: string;
  createdAt?: string;
}

export const mmsApi = {
  getStatus:       async (): Promise<MmsStatus>     => { const { data } = await api.get('/status'); return data; },
  configure:       async (mm1PublicIp: string)      => { const { data } = await api.post('/configure', { mm1PublicIp }); return data; },
  syncSubscribers: async (): Promise<MmsSyncResult>  => { const { data } = await api.post('/sync-subscribers'); return data; },
  start:           async () => { const { data } = await api.post('/start');   return data; },
  stop:            async () => { const { data } = await api.post('/stop');    return data; },
  restart:         async () => { const { data } = await api.post('/restart'); return data; },
  install:         () => fetch('/api/mms/install',   { method: 'POST', credentials: 'include' }),
  uninstall:       () => fetch('/api/mms/uninstall', { method: 'POST', credentials: 'include' }),
  // Read-only proxy into VectorCore's own admin API (backend-authenticated —
  // VectorCore's :8090 has zero auth of its own). subPath is everything after
  // /api/mms/admin/, e.g. 'api/v1/messages'.
  getAdmin: async <T = any>(subPath: string): Promise<T> => {
    const { data } = await api.get(`/admin/${subPath}`);
    return data;
  },
};
