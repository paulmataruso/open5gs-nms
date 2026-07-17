import axios from 'axios';

const api = axios.create({ baseURL: '/api/ims', withCredentials: true });

export interface ImsStatus {
  installed: boolean;
  pyhssInstalled?: boolean;
  hssBackend: 'pyhss';
  services: {
    pcscf: boolean; icscf: boolean; scscf: boolean; smsc: boolean;
    rtpengine: boolean; bind9: boolean; mariadb: boolean;
    redis: boolean;
    'pyhss-diameter': boolean; 'pyhss-hss': boolean; 'pyhss-api': boolean;
  };
  imsSubscribers: number;
  open5gsSubscribers: number;
  smfImsConfigured: boolean;
  dnsConfigured: boolean;
  imsEnabled: boolean;
  hasSavedConfig: boolean;
  imsDomain?: string;
  currentConfig?: ImsConfigureInput;
}

export interface ImsConfigureInput {
  pcscfIp: string;    pcscfPort: number;
  icscfIp: string;    icscfPort: number;
  scscfIp: string;    scscfPort: number;
  rtpEngineIp: string; rtpPortMin: number; rtpPortMax: number;
  dnsIp: string;
  mcc?: string;
  mnc?: string;
  additionalPlmns?: { mcc: string; mnc: string }[];
}

export interface ValidationCheck {
  name: string;
  pass: boolean;
  detail: string;
  remediation?: string;
}

export interface ImsConfigFile {
  path: string;
  label: string;
  group: string;
  language: string;
  restartServices: string[];
  exists: boolean;
}

export const imsApi = {
  getStatus:       async (): Promise<ImsStatus>         => { const { data } = await api.get('/status');            return data; },
  configure:       async (input: ImsConfigureInput)     => { const { data } = await api.post('/configure', input); return data; },
  syncSubscribers: async ()                             => { const { data } = await api.post('/sync-subscribers'); return data; },
  getDnsRecords:   async ()                             => { const { data } = await api.get('/dns-records');       return data; },
  validate:        async ()                             => { const { data } = await api.post('/validate');          return data; },
  enable:          async ()                             => { const { data } = await api.post('/enable');            return data; },
  disable:         async ()                             => { const { data } = await api.post('/disable');           return data; },
  restart:         async ()                             => { const { data } = await api.post('/restart');           return data; },
  install:         () => fetch('/api/ims/install', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }),
  remove:          () => fetch('/api/ims/remove',  { method: 'POST', credentials: 'include' }),
  getConfigs:        async (): Promise<{ files: ImsConfigFile[] }> => { const { data } = await api.get('/configs'); return data; },
  getConfigContent:  async (filePath: string): Promise<{ content: string; exists: boolean }> => {
    const { data } = await api.get('/configs/content', { params: { path: filePath } });
    return data;
  },
  saveConfigContent: async (filePath: string, content: string): Promise<{ success: boolean }> => {
    const { data } = await api.put('/configs/content', { path: filePath, content });
    return data;
  },
  restartServices:   async (services: string[]): Promise<{ success: boolean; results: string[] }> => {
    const { data } = await api.post('/configs/restart', { services });
    return data;
  },
};
