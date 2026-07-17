import axios from 'axios';

const api = axios.create({ baseURL: '/api/sms', withCredentials: true });

export interface SmsStatus {
  installed: boolean;
  services: { stp: boolean; hlr: boolean; msc: boolean };
  hlrSubscribers: number;
  open5gsSubscribers: number;
  mmeSgsConfigured: boolean;
  smsEnabled: boolean;
  hasSavedConfig: boolean;
  currentConfig?: { mscBindIp: string; hlrBindIp: string; mmeLocalIp: string };
}

export interface SmsConfigureInput {
  mscBindIp:  string;
  hlrBindIp:  string;
  mmeLocalIp: string;
}

export interface SmsConfigFile {
  path: string; label: string; group: string; language: string;
  restartServices: string[]; exists: boolean;
}

export const smsApi = {
  getStatus:       async (): Promise<SmsStatus> => { const { data } = await api.get('/status'); return data; },
  configure:       async (input: SmsConfigureInput) => { const { data } = await api.post('/configure', input); return data; },
  syncSubscribers: async () => { const { data } = await api.post('/sync-subscribers'); return data; },
  sendTest:        async (to: string, from: string, text: string): Promise<{ success: boolean; output?: string; error?: string }> => {
    const { data } = await api.post('/send-test', { to, from, text }); return data;
  },
  enable:          async () => { const { data } = await api.post('/enable'); return data; },
  disable:         async () => { const { data } = await api.post('/disable'); return data; },
  start:           async () => { const { data } = await api.post('/start'); return data; },
  stop:            async () => { const { data } = await api.post('/stop'); return data; },
  restart:         async () => { const { data } = await api.post('/restart'); return data; },
  install:         () => fetch('/api/sms/install', { method: 'POST', credentials: 'include' }),
  getConfigs:        async (): Promise<{ files: SmsConfigFile[] }> => { const { data } = await api.get('/configs'); return data; },
  getConfigContent:  async (filePath: string): Promise<{ content: string; exists: boolean }> => {
    const { data } = await api.get('/configs/content', { params: { path: filePath } }); return data;
  },
  saveConfigContent: async (filePath: string, content: string): Promise<{ success: boolean }> => {
    const { data } = await api.put('/configs/content', { path: filePath, content }); return data;
  },
  restartServices:   async (services: string[]): Promise<{ success: boolean; results: string[] }> => {
    const { data } = await api.post('/configs/restart', { services }); return data;
  },
};
