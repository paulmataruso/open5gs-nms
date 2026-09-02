import axios from 'axios';

const api = axios.create({ baseURL: '/api/radio-signal', withCredentials: true });

export interface SignalRadio {
  id: string;
  name: string;
  vendor: 'baicells' | 'generic';
  baseUrl: string;
  username: string;
  password?: string;
  passwordConfigured: boolean;
  metricsPath: string;
  enabled: boolean;
  allowSelfSigned: boolean;
}

export interface SignalHistoryPoint {
  sampledAt: number;
  rsrp?: number | null;
  rsrq?: number | null;
  rssi?: number | null;
  sinr?: number | null;
  bler?: number | null;
}

export interface SignalUe {
  radioId: string;
  radioName: string;
  vendor: string;
  ueId: string;
  imsi?: string;
  iccid?: string;
  msisdn?: string;
  nickname?: string;
  sampledAt: number;
  rsrp?: number | null;
  rsrq?: number | null;
  rssi?: number | null;
  sinr?: number | null;
  snr?: number | null;
  dlMcs?: number | null;
  ulMcs?: number | null;
  bler?: number | null;
  dlMbps?: number | null;
  ulMbps?: number | null;
  txPower?: number | null;
  pathLoss?: number | null;
  primaryDlCqi?: number | null;
  secondaryDlCqi?: number | null;
  history: SignalHistoryPoint[];
}

export const radioSignalApi = {
  overview: (search = '', hours = 24) =>
    api.get<{ radios: SignalRadio[]; ues: SignalUe[] }>('/overview', { params: { search, hours } }).then(r => r.data),
  saveRadio: (radio: Partial<SignalRadio>) => api.post('/radios', radio).then(r => r.data),
  deleteRadio: (id: string) => api.delete(`/radios/${id}`).then(r => r.data),
  poll: () => api.post<{ results: Array<{ radioId: string; success: boolean; count?: number; error?: string }> }>('/poll').then(r => r.data),
  wake: (radioId: string, imsi?: string) => api.post<{ success: boolean; targets: number; packets: number }>('/wake', { radioId, imsi }).then(r => r.data),
  discover: () => api.post<{ discovered: Array<{ ip: string; radioId: string; imsis: string[]; added: boolean }> }>('/discover').then(r => r.data),
};
