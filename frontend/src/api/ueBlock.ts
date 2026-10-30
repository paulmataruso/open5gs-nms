const BASE = '/api/ue-block';
// Bouncing a UE installs no block, so it lives outside the blocking namespace
// on purpose — see ue-deregister-controller.ts.
const UE_BASE = '/api/ue';

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

export type UeDeregisterStatus =
  | 'detached-sent'
  | 'not-attached'
  | 'not-reachable-idle'
  | 'not-reachable-deregistered'
  | 'lookup-failed'
  | 'rejected'
  | 'timeout'
  | 'unsupported'
  | 'error';

export interface UeDeregisterResult {
  success: boolean;
  imsi: string;
  generation: '2g' | '4g' | '5g' | 'unknown';
  status: UeDeregisterStatus;
  reattachRequested: boolean;
  message: string;
  resultCode?: number;
  experimentalResultCode?: number;
}

/**
 * "Bounce" a UE: detach it with the re-attach flag set, so it comes straight
 * back by itself. Not a block — nothing persists.
 *
 * Expected outcomes (a UE that was not attached, a 5G UE the AMF cannot page)
 * come back as a 200 with a `status` that says so, NOT as a thrown error, so
 * the caller can report them accurately instead of as a failure.
 */
export async function deregisterUe(imsi: string): Promise<UeDeregisterResult> {
  const r = await fetch(`${UE_BASE}/${encodeURIComponent(imsi)}/deregister`, {
    method: 'POST', credentials: 'include',
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? 'Failed to bounce UE');
  return j;
}
