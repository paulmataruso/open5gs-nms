import axios from 'axios';

const api = axios.create({ baseURL: '/api/twamp', withCredentials: true });

export interface TwampStatus {
  installed: boolean;
  installedWithVersion?: string;
  installStale: boolean;
  appVersion: string;
}

export type TwampMode = 'unauthenticated' | 'authenticated' | 'encrypted';
// full = RFC 5357 main body (TCP TWAMP-Control then UDP test packets).
// light = RFC 5357 Appendix I (connectionless UDP only) — confirmed live
// against a real Nokia AirScale radio, which only speaks this variant.
export type TwampProtocol = 'full' | 'light';

export interface TwampTestResult {
  success: boolean;
  error?: string;
  packetsSent?: number;
  packetsReceived?: number;
  packetsLost?: number;
  minRttMs?: number;
  maxRttMs?: number;
  avgRttMs?: number;
  jitterMs?: number;
  avgForwardDelayMs?: number;
  avgReverseDelayMs?: number;
  delayAsymmetryMs?: number;
}

export interface TwampCachedResult extends TwampTestResult {
  targetId: string;
  name: string;
  host: string;
  timestamp: number;
}

export interface TwampTarget {
  _id: string;
  name: string;
  host: string;
  port: number;
  protocol: TwampProtocol;
  mode: TwampMode;
  sharedSecret?: string;
  keyId?: string;
  packetCount: number;
  bindIp?: string;
  pollIntervalSeconds: number;
  enabled: boolean;
  createdAt: number;
  latest: TwampCachedResult | null;
}

export interface TwampTargetInput {
  name: string;
  host: string;
  port: number;
  protocol: TwampProtocol;
  mode: TwampMode;
  sharedSecret?: string;
  keyId?: string;
  packetCount: number;
  bindIp?: string;
  pollIntervalSeconds: number;
  enabled: boolean;
}

export interface TwampServerStatus {
  installed: boolean;
  serviceActive: boolean;
  hasSavedConfig: boolean;
  currentConfig?: {
    listenIp: string;
    listenPort: number;
    enableFull: boolean;
    enableLight: boolean;
    modes: TwampMode[];
    secretKeyId?: string;
    hasSecret: boolean;
    allowCidrs: string[];
  };
  appVersion: string;
  configuredWithVersion?: string;
  configStale: boolean;
}

export interface TwampServerConfigInput {
  listenIp: string;
  listenPort: number;
  enableFull: boolean;
  enableLight: boolean;
  modes: TwampMode[];
  secretKeyId?: string;
  secretValue?: string;
  allowCidrs?: string[];
}

export interface TwampServerConnection {
  peerIp: string;
  peerPort: string;
  localAddr: string;
  protocol: TwampProtocol;
  // Light-only (connectionless UDP has no OS-level connection to read a
  // local address from) — the server tracks these itself.
  packetCount?: number;
  lastSeenMs?: number;
}

export interface TwampMetricSample {
  metric: string;
  labels: Record<string, string>;
  value: number;
}

export interface TwampHistorySummaryRow {
  targetId: string;
  name: string;
  host: string;
  protocol: TwampProtocol;
  sampleCount: number;
  successCount: number;
  avgRttMs: number | null;
  minRttMs: number | null;
  maxRttMs: number | null;
  avgJitterMs: number | null;
  avgPacketLossRatio: number | null;
  lastTimestampMs: number;
  lastSuccess: boolean;
}

export interface TwampHistorySeriesPoint {
  ts: number;
  avgRttMs: number | null;
  minRttMs: number | null;
  maxRttMs: number | null;
  jitterMs: number | null;
  packetLossRatio: number | null;
  sampleCount: number;
}

export const twampApi = {
  getStatus: async (): Promise<TwampStatus> => { const { data } = await api.get('/status'); return data; },
  install:   () => fetch('/api/twamp/install',   { method: 'POST', credentials: 'include' }),
  uninstall: () => fetch('/api/twamp/uninstall', { method: 'POST', credentials: 'include' }),

  getTargets: async (): Promise<TwampTarget[]> => { const { data } = await api.get('/targets'); return data.data; },
  createTarget: async (input: TwampTargetInput): Promise<TwampTarget> => { const { data } = await api.post('/targets', input); return data.data; },
  updateTarget: async (id: string, input: Partial<TwampTargetInput>) => { const { data } = await api.put(`/targets/${id}`, input); return data; },
  deleteTarget: async (id: string) => { const { data } = await api.delete(`/targets/${id}`); return data; },
  testTarget: async (id: string): Promise<TwampTestResult> => { const { data } = await api.post(`/targets/${id}/test`); return data; },

  getServerStatus: async (): Promise<TwampServerStatus> => { const { data } = await api.get('/server/status'); return data; },
  configureServer: async (input: TwampServerConfigInput) => { const { data } = await api.post('/server/configure', input); return data; },
  startServer:   async () => { const { data } = await api.post('/server/start');   return data; },
  stopServer:    async () => { const { data } = await api.post('/server/stop');    return data; },
  restartServer: async () => { const { data } = await api.post('/server/restart'); return data; },

  getServerConnections: async (): Promise<TwampServerConnection[]> => { const { data } = await api.get('/server/connections'); return data.data; },
  getServerMetrics: async (): Promise<{ available: boolean; data: TwampMetricSample[] }> => {
    const { data } = await api.get('/server/metrics');
    return { available: data.available, data: data.data };
  },

  getHistorySettings: async (): Promise<{ retentionDays: number }> => {
    const { data } = await api.get('/history/settings');
    return { retentionDays: data.retentionDays };
  },
  updateHistorySettings: async (retentionDays: number): Promise<{ retentionDays: number }> => {
    const { data } = await api.put('/history/settings', { retentionDays });
    return { retentionDays: data.retentionDays };
  },
  getHistorySummary: async (fromMs: number, toMs: number): Promise<TwampHistorySummaryRow[]> => {
    const { data } = await api.get('/history/summary', { params: { fromMs, toMs } });
    return data.data;
  },
  getHistorySeries: async (targetId: string, fromMs: number, toMs: number): Promise<{ bucketMs: number; data: TwampHistorySeriesPoint[] }> => {
    const { data } = await api.get('/history/series', { params: { targetId, fromMs, toMs } });
    return { bucketMs: data.bucketMs, data: data.data };
  },
};
