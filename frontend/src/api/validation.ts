const BASE = '/api/validation';

export interface DnnSubnet {
  dnn: string;
  cidr: string;
  gateway: string;
}

export interface InferredConfig {
  plmn: { mcc: string; mnc: string };
  amfIp: string;
  upfIp: string;
  tac5g: number;
  slices: Array<{ sst: number; sd?: string }>;
  dnns: string[];
  subnets: DnnSubnet[];
  mmeIp: string;
  tac4g: number;
  mmeGroupId: number;
  mmeCode: number;
  apns: string[];
}

export interface UeStatus {
  imsi: string;
  type: '5g' | '4g';
  nodeId: string;
  state: 'starting' | 'registered' | 'session_established' | 'failed' | 'stopped';
  ip?: string;
  error?: string;
}

export interface SessionSummary {
  id: string;
  startedAt: string;
  status: 'provisioning' | 'running' | 'stopping' | 'stopped' | 'failed';
  imsiCount: number;
  containerCount: number;
  ueStatuses: Record<string, UeStatus>;
  error?: string;
  logs?: string[];
}

export interface StartParams {
  enable5G: boolean;
  enable4G: boolean;
  gnbCount: number;
  gnbUeCount: number;
  enbCount: number;
  enbUeCount: number;
  sliceOverride?: { sst: number; sd?: string };
  dnnOverride?: string;
  apnOverride?: string;
  amfIpOverride?: string;
  upfIpOverride?: string;
}

export async function inferConfig(): Promise<InferredConfig> {
  const r = await fetch(`${BASE}/infer`, { credentials: 'include' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j.config;
}

export interface HostCapacity {
  cores: number;
  totalMemGB: number;
  recommended4G: { enb: number; uePerEnb: number };
  recommended5G: { gnb: number; uePerGnb: number };
}

export async function getCapacity(): Promise<HostCapacity> {
  const r = await fetch(`${BASE}/capacity`, { credentials: 'include' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j;
}

export interface PingResult {
  reachable: boolean;
  lossPct: number;
  avgRttMs?: number;
  raw: string;
}

export async function pingUe(sessionId: string, ip: string): Promise<PingResult> {
  const r = await fetch(`${BASE}/ping/${sessionId}?ip=${encodeURIComponent(ip)}`, { method: 'POST', credentials: 'include' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j;
}

export async function getSessions(): Promise<SessionSummary[]> {
  const r = await fetch(`${BASE}/sessions`, { credentials: 'include' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j.sessions;
}

export async function startSession(params: StartParams): Promise<{ sessionId: string }> {
  const r = await fetch(`${BASE}/start`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return { sessionId: j.sessionId };
}

export async function stopSession(id: string): Promise<void> {
  const r = await fetch(`${BASE}/stop/${id}`, { method: 'POST', credentials: 'include' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
}

export async function fetchSessionStatus(id: string): Promise<SessionSummary | null> {
  try {
    const r = await fetch(`${BASE}/status/${id}`, { credentials: 'include' });
    const j = await r.json();
    return j.ok ? j.session : null;
  } catch { return null; }
}

export interface RawLogs { gnb: string[]; enb: string[]; ue5g: string[]; ue4g: string[] }
const EMPTY_RAW_LOGS: RawLogs = { gnb: [], enb: [], ue5g: [], ue4g: [] };

export async function fetchRawLogs(id: string): Promise<RawLogs> {
  try {
    const r = await fetch(`${BASE}/raw-logs/${id}`, { credentials: 'include' });
    const j = await r.json();
    return j.ok ? { gnb: j.gnb, enb: j.enb, ue5g: j.ue5g, ue4g: j.ue4g } : EMPTY_RAW_LOGS;
  } catch { return EMPTY_RAW_LOGS; }
}

export async function forceCleanup(): Promise<string[]> {
  const r = await fetch(`${BASE}/force-cleanup`, { method: 'POST', credentials: 'include' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j.results as string[];
}

export async function stopAll(): Promise<void> {
  const r = await fetch(`${BASE}/stop-all`, { method: 'POST', credentials: 'include' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
}

export function createEventSource(onEvent: (event: string, data: unknown) => void): () => void {
  const es = new EventSource(`${BASE}/events`, { withCredentials: true });
  es.addEventListener('init',    e => onEvent('init',    JSON.parse(e.data)));
  es.addEventListener('session', e => onEvent('session', JSON.parse(e.data)));
  es.addEventListener('log',     e => onEvent('log',     JSON.parse(e.data)));
  es.onerror = () => es.close();
  return () => es.close();
}
