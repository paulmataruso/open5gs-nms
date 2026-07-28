import axios from 'axios';

const api = axios.create({ baseURL: '/api/pstn', withCredentials: true });

export interface PstnStatus {
  installed: boolean;
  services: { asterisk: boolean; 'kamailio-scscf': boolean };
  codecAmrLoaded: boolean;
  imsConfigured: boolean;
  hasSavedConfig: boolean;
  dispatcherWired: boolean;
  pstnEnabled: boolean;
  currentConfig?: { asteriskIp: string };
  extensionCount: number;
}

export interface PstnExtension {
  extension: string;
  subscriberImsi: string;
  subscriberNickname?: string;
  subscriberMsisdn?: string;
  label?: string;
  createdAt: string;
}

export const pstnApi = {
  getStatus:  async (): Promise<PstnStatus> => { const { data } = await api.get('/status'); return data; },
  configure:  async (asteriskIp?: string) => { const { data } = await api.post('/configure', { asteriskIp }); return data; },
  enable:     async () => { const { data } = await api.post('/enable'); return data; },
  disable:    async () => { const { data } = await api.post('/disable'); return data; },
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
};
