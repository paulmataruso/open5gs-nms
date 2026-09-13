import axios from 'axios';

const api = axios.create({ baseURL: '/api/asterisk-2g', withCredentials: true });

export interface Asterisk2gStatus {
  success: boolean;
  installed: boolean;
  serviceActive: boolean;
  codecGsmLoaded: boolean;
  bindIp: string;
  bindPort: number;
  msisdnMatchPattern: string;
  // osmo-sip-connector's own live local bind, read fresh off the GSM
  // module's own state every poll — null if the SIP tab has no concrete
  // address configured yet.
  sipConnPeer: { ip: string; port: number } | null;
  hasSavedConfig: boolean;
  configuredWithVersion?: string;
  configStale: boolean;
  appVersion: string;
}

export const asterisk2gApi = {
  getStatus: async (): Promise<Asterisk2gStatus> => {
    const { data } = await api.get('/status');
    return data;
  },
  // Raw fetch (not the axios instance) so the caller can read the response
  // body as a stream — matches gsmApi.install()/pstnApi's own convention for
  // every long-running apt-get/build install endpoint in this app.
  install: (): Promise<Response> =>
    fetch('/api/asterisk-2g/install', { method: 'POST', credentials: 'include' }),
  uninstall: (): Promise<Response> =>
    fetch('/api/asterisk-2g/uninstall', { method: 'POST', credentials: 'include' }),
  configure: async (input: { bindIp?: string; bindPort?: number; msisdnMatchPattern?: string }): Promise<{ success: boolean; bindIp: string; sipConnPeer: string }> => {
    const { data } = await api.post('/configure', input);
    return data;
  },
  start:   async () => { const { data } = await api.post('/start');   return data; },
  stop:    async () => { const { data } = await api.post('/stop');    return data; },
  restart: async () => { const { data } = await api.post('/restart'); return data; },
};
