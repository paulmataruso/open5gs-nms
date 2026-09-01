const BASE = '/api/validation/qci-hw-test';

export interface QciHwTestStatus {
  success: boolean;
  built: boolean;
  open5gsSrcAvailable: boolean;
  open5gsSrcDir: string;
  running: boolean;
}

export interface AttachedUe {
  imsi: string;
  nickname?: string;
}

export interface QciHwTestEvent {
  type: 'guard_ok' | 'test_number' | 'waiting' | 'probe_event' | 'outcome' | 'error';
  attachedUEs?: AttachedUe[];
  msisdn?: string;
  message?: string;
  event?: {
    type: 'ready' | 'request_seen' | 'result' | 'error';
    mmeUeS1apId?: number;
    enbUeS1apId?: number;
    erabId?: number;
    originalQci?: number;
    testQci?: number;
    success?: boolean;
    causeGroup?: number;
    causeValue?: number;
  };
  status?: 'success' | 'rejected' | 'timeout' | 'error';
  causeGroup?: number;
  causeValue?: number;
  radioIp?: string;
  qci?: number;
}

export async function getQciHwTestStatus(): Promise<QciHwTestStatus> {
  const r = await fetch(`${BASE}/status`, { credentials: 'include' });
  return r.json();
}

export function installQciHwTest(): Promise<Response> {
  return fetch(`${BASE}/install`, { method: 'POST', credentials: 'include' });
}

export async function getAttachedUes(radioIp: string): Promise<AttachedUe[]> {
  const r = await fetch(`${BASE}/attached-ues?radioIp=${encodeURIComponent(radioIp)}`, { credentials: 'include' });
  const j = await r.json();
  return j.ues ?? [];
}

export function runQciHwTest(radioIp: string, qci: number): Promise<Response> {
  return fetch(`${BASE}/run`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ radioIp, qci }),
  });
}
