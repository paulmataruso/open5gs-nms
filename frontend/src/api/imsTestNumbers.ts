const BASE = '/api/validation/ims-test-numbers';

export type OutboundCallState = 'dialing' | 'ringing' | 'answered' | 'ended' | 'failed';

export interface ImsTestNumberInfo {
  msisdn: string;
  imsi: string;
  localPort: number;
  createdAt: string;
  callsHandled: number;
  outboundCall: { targetNumber: string; state: OutboundCallState; failReason?: string } | null;
}

export async function listImsTestNumbers(): Promise<ImsTestNumberInfo[]> {
  const r = await fetch(BASE, { credentials: 'include' });
  const j = await r.json();
  if (!j.success) throw new Error(j.error ?? 'Failed to list test numbers');
  return j.testNumbers;
}

export async function createImsTestNumber(msisdn?: string): Promise<ImsTestNumberInfo> {
  const r = await fetch(BASE, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msisdn ? { msisdn } : {}),
  });
  const j = await r.json();
  if (!j.success) throw new Error(j.error ?? 'Failed to create test number');
  return j.testNumber;
}

export async function stopImsTestNumber(msisdn: string): Promise<void> {
  const r = await fetch(`${BASE}/${encodeURIComponent(msisdn)}`, { method: 'DELETE', credentials: 'include' });
  const j = await r.json();
  if (!j.success) throw new Error(j.error ?? 'Failed to stop test number');
}

export async function placeImsTestCall(msisdn: string, targetNumber: string): Promise<void> {
  const r = await fetch(`${BASE}/${encodeURIComponent(msisdn)}/call`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetNumber }),
  });
  const j = await r.json();
  if (!j.success) throw new Error(j.error ?? 'Failed to place call');
}

export async function hangupImsTestCall(msisdn: string): Promise<void> {
  const r = await fetch(`${BASE}/${encodeURIComponent(msisdn)}/hangup`, { method: 'POST', credentials: 'include' });
  const j = await r.json();
  if (!j.success) throw new Error(j.error ?? 'Failed to hang up');
}
