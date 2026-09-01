const BASE = '/api/ue-block';

export interface UeBlockInfo {
  imsi: string;
  lastIp: string | null;
  blockedBy: string;
  blockedAt: number;
}

export interface UeBlockStatus {
  success: boolean;
  built: boolean;
  open5gsSrcAvailable: boolean;
}

export interface UeBlockResult {
  success: boolean;
  imsi: string;
  detach: { attempted: boolean; status?: string; message?: string };
}

export async function getUeBlockStatus(): Promise<UeBlockStatus> {
  const r = await fetch(`${BASE}/status`, { credentials: 'include' });
  return r.json();
}

export function installUeDetachTool(): Promise<Response> {
  return fetch(`${BASE}/install`, { method: 'POST', credentials: 'include' });
}

export async function getBlockedUes(): Promise<UeBlockInfo[]> {
  const r = await fetch(`${BASE}`, { credentials: 'include' });
  if (!r.ok) return [];
  return r.json();
}

export async function blockUe(imsi: string): Promise<UeBlockResult> {
  const r = await fetch(`${BASE}/${encodeURIComponent(imsi)}`, { method: 'POST', credentials: 'include' });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? 'Failed to block UE');
  return j;
}

export async function unblockUe(imsi: string): Promise<void> {
  const r = await fetch(`${BASE}/${encodeURIComponent(imsi)}`, { method: 'DELETE', credentials: 'include' });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? 'Failed to unblock UE');
}
