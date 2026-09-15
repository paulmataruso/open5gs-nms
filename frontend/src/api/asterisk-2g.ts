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
  echoTestNumber: string;
  // osmo-sip-connector's own live local bind, read fresh off the GSM
  // module's own state every poll — null if the SIP tab has no concrete
  // address configured yet.
  sipConnPeer: { ip: string; port: number } | null;
  hasSavedConfig: boolean;
  configuredWithVersion?: string;
  configStale: boolean;
  appVersion: string;
  // Follower copy of the Cross-RAN Calling toggle — read-only here, no
  // matching enable/disable methods on this API: the one-button toggle
  // lives entirely on the Voice Gateway page's Extensions tab (pstnApi),
  // this instance's own half is only ever driven from there.
  crossRanEnabled: boolean;
}

export interface Asterisk2gConfigFile {
  path: string; label: string; group: string; language: string;
  restartServices: string[]; exists: boolean;
}

export interface Asterisk2gExtension {
  extension: string;
  subscriberImsi: string;
  subscriberNickname?: string;
  subscriberMsisdn?: string;
  label?: string;
  createdAt: string;
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
  configure: async (input: { bindIp?: string; bindPort?: number; msisdnMatchPattern?: string; echoTestNumber?: string }): Promise<{ success: boolean; bindIp: string; sipConnPeer: string }> => {
    const { data } = await api.post('/configure', input);
    return data;
  },
  start:   async () => { const { data } = await api.post('/start');   return data; },
  stop:    async () => { const { data } = await api.post('/stop');    return data; },
  restart: async () => { const { data } = await api.post('/restart'); return data; },
  getConfigs: async (): Promise<{ success: boolean; files: Asterisk2gConfigFile[] }> => {
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
  listExtensions: async (): Promise<{ extensions: Asterisk2gExtension[] }> => {
    const { data } = await api.get('/extensions');
    return data;
  },
  addExtension: async (extension: string, subscriberImsi: string, label?: string) => {
    const { data } = await api.post('/extensions', { extension, subscriberImsi, label });
    return data;
  },
  removeExtension: async (extension: string) => {
    const { data } = await api.delete(`/extensions/${encodeURIComponent(extension)}`);
    return data;
  },
};
