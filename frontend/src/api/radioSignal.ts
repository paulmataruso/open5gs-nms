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
  lastPolledAt?: number | null;
  lastError?: string | null;
  ueCount?: number | null;
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
  source?: 'radio' | 'subscriber';
  radioUrl?: string;
  imeisv?: string | string[];
  simType?: string | null;
  subscriberStatus?: number;
  msisdns?: string[];
  cmState?: string;
  mmState?: string;
  coreIp?: string;
  coreRadioIp?: string;
  coreSessions?: Array<{ apn: string; ip: string }>;
  sessions?: Array<{ apn: string; type: number; sst: number; sd?: string; ipv4?: string; ipv6?: string; qos: { index: number }; ambr: { uplink: { value: number; unit: number }; downlink: { value: number; unit: number } }; ipv4FramedRoutes?: string[]; ipv6FramedRoutes?: string[] }>;
  details?: Record<string, string | number>;
  sampledAt: number | null;
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

// A successful latest radio poll or a connected core context is live evidence.
export function isOnlineSignalUe(ue: SignalUe, radios: SignalRadio[], now = Date.now()): boolean {
  if (ue.cmState === 'connected' && ue.mmState !== 'deregistered') return true;
  const radio = radios.find(r => r.id === ue.radioId);
  if (!radio?.enabled || radio.lastError || !radio.lastPolledAt || !ue.sampledAt) return false;
  return now - radio.lastPolledAt < 45000 && radio.lastPolledAt <= now + 1000
    && ue.sampledAt >= radio.lastPolledAt - 1000 && ue.sampledAt <= now + 1000;
}

export const radioSignalApi = {
  overview: (search = '', hours = 24) =>
    api.get<{ radios: SignalRadio[]; ues: SignalUe[]; coreAvailable?: boolean; collectedAt?: number }>('/overview', { params: { search, hours } }).then(r => ({ ...r.data, ues: r.data.ues.filter(ue => isOnlineSignalUe(ue, r.data.radios)) })),
  saveRadio: (radio: Partial<SignalRadio>) => api.post('/radios', radio).then(r => r.data),
  deleteRadio: (id: string) => api.delete(`/radios/${id}`).then(r => r.data),
  poll: () => api.post<{ results: Array<{ radioId: string; success: boolean; count?: number; error?: string }> }>('/poll').then(r => r.data),
  wake: (radioId: string, imsi?: string) => api.post<{ success: boolean; targets: number; packets: number }>('/wake', { radioId, imsi }).then(r => r.data),
  discover: () => api.post<{ discovered: Array<{ ip: string; radioId: string; imsis: string[]; added: boolean }> }>('/discover').then(r => r.data),
};
