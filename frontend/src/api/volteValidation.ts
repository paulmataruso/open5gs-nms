const BASE = '/api/validation/volte';

export interface VolteValidationStatus {
  success: boolean;
  imsConfigured: boolean;
  imsDomain: string | null;
  running: boolean;
}

export interface VolteTestStep {
  type: 'step';
  name: string;
  ok: boolean;
  detail?: string;
  durationMs: number;
}

export interface VolteTestResultLine {
  type: 'result';
  success: boolean;
  error?: string;
}

export type VolteTestLine = VolteTestStep | VolteTestResultLine;

export async function getVolteStatus(): Promise<VolteValidationStatus> {
  const r = await fetch(`${BASE}/status`, { credentials: 'include' });
  return r.json();
}

export function runVolteTest(): Promise<Response> {
  return fetch(`${BASE}/run`, { method: 'POST', credentials: 'include' });
}
