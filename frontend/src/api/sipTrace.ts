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
  /**
   * An instance has no siptrace module loaded, so the change could not reach
   * it. Only ever true while enabling, and only on a deployment whose live
   * CSCF config predates capture being loaded unconditionally — an IMS
   * Configure fixes it. Nothing in this feature restarts a CSCF.
   */
  needsConfigure: boolean;
  instances: { role: string; action: 'rpc' | 'not-loaded' | 'failed'; detail?: string }[];
}

export type EndpointRole = 'ue' | 'pcscf' | 'icscf' | 'scscf' | 'other';

export type HopClass =
  | 'request'
  | 'provisional'
  | 'success'
  | 'redirect'
  | 'client-error'
  | 'server-error'
  | 'global-error';

export interface FlowEndpoint {
  id: string;
  ip: string;
  port: number;
  role: EndpointRole;
  label: string;
  address: string;
}

export interface FlowHop {
  index: number;
  timestamp: string;
  deltaMs: number;
  offsetMs: number;
  from: string;
  to: string;
  callId: string;
  label: string;
  cls: HopClass;
  method?: string;
  statusCode?: number;
  cseqNumber?: number;
  cseqMethod?: string;
  retransmission: boolean;
  sources: SipTraceSource[];
  /** Indices into `messages` — what clicking the arrow opens. */
  messageRefs: number[];
}

export interface CallFlow {
  endpoints: FlowEndpoint[];
  hops: FlowHop[];
  dialogs: string[];
  startTime: string | null;
  endTime: string | null;
  messages: SipTraceMessage[];
  /** Raw rows merged away as duplicate observations of one wire message. */
  mergedDuplicates: number;
}

export interface CallListParams {
  from?: string;
  to?: string;
  search?: string;
  method?: string;
  source?: SipTraceSource;
  /**
   * 'calls' (the server's default) lists only dialogs containing an INVITE.
   * 'all' includes registrations, keepalives, messaging and fragments.
   */
  kind?: 'calls' | 'all';
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
  /**
   * The end-to-end ladder. `related` additionally pulls in other Call-IDs that
   * look like the same real call — needed when a B2BUA split one call into two
   * dialogs, and off by default because the link is a heuristic.
   */
  getCallFlow: async (
    callId: string,
    related = false,
  ): Promise<{ flow: CallFlow; related: string[]; includedDialogs: string[] }> => {
    const { data } = await api.get(`/calls/${encodeURIComponent(callId)}/flow`, {
      params: related ? { related: 1 } : undefined,
    });
    return { flow: data.flow, related: data.related ?? [], includedDialogs: data.includedDialogs ?? [callId] };
  },
  setRetention: async (retentionHours: number): Promise<{ retentionHours: number }> => {
    const { data } = await api.post('/settings', { retentionHours });
    return data.settings;
  },
};
