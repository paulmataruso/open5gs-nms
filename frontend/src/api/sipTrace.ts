import axios from 'axios';

const api = axios.create({ baseURL: '/api/sip-trace', withCredentials: true });

export type SipTraceSource = 'pcscf' | 'icscf' | 'scscf' | 'unknown';

export interface SipTraceMessage {
  callId: string;
  timestamp: string;
  source: SipTraceSource;
  captureAgentId: number;
  srcIp: string;
  srcPort: number;
  dstIp: string;
  dstPort: number;
  transport: string;
  method?: string;
  statusCode?: number;
  statusReason?: string;
  cseqMethod?: string;
  cseqNumber?: number;
  fromUri?: string;
  fromUser?: string;
  toUri?: string;
  toUser?: string;
  raw: string;
  seq: number;
}

export interface CallSummary {
  callId: string;
  startTime: string;
  endTime: string;
  messageCount: number;
  initialMethod?: string;
  fromUser?: string;
  toUser?: string;
  lastStatus?: number;
  sources: SipTraceSource[];
}

export interface HepCollectorStats {
  running: boolean;
  bind: string;
  listeners: { source: SipTraceSource; port: number; bound: boolean }[];
  startedAt: string | null;
  packetsReceived: number;
  packetsBySource: Record<string, number>;
  messagesStored: number;
  nonSipIgnored: number;
  dropped: Record<string, number>;
  queueDepth: number;
  queueOverflowDrops: number;
  lastPacketAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

export interface SipTraceStatus {
  enabled: boolean;
  collector: HepCollectorStats;
  runtime: { role: string; loaded: boolean; status: string }[];
  messages: number;
  capturePorts: Record<string, number>;
  settings: { retentionHours: number };
}

export interface SipTracingApplyReport {
  enabled: boolean;
  restarted: boolean;
  instances: { role: string; action: 'rpc' | 'restarted' | 'failed'; detail?: string }[];
}

export interface CallListParams {
  from?: string;
  to?: string;
  search?: string;
  method?: string;
  source?: SipTraceSource;
  page?: number;
  pageSize?: number;
}

export const sipTraceApi = {
  getStatus: async (): Promise<SipTraceStatus> => {
    const { data } = await api.get('/status');
    return data;
  },
  enable: async (): Promise<SipTracingApplyReport> => {
    const { data } = await api.post('/enable');
    return data.report;
  },
  disable: async (): Promise<SipTracingApplyReport> => {
    const { data } = await api.post('/disable');
    return data.report;
  },
  listCalls: async (
    p: CallListParams,
  ): Promise<{ rows: CallSummary[]; total: number; page: number; pageSize: number }> => {
    const { data } = await api.get('/calls', { params: p });
    return data;
  },
  getCallMessages: async (callId: string): Promise<SipTraceMessage[]> => {
    const { data } = await api.get(`/calls/${encodeURIComponent(callId)}/messages`);
    return data.messages;
  },
  setRetention: async (retentionHours: number): Promise<{ retentionHours: number }> => {
    const { data } = await api.post('/settings', { retentionHours });
    return data.settings;
  },
};
