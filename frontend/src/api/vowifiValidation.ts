const BASE = '/api/validation/vowifi';

export interface VowifiValidationStatus {
  success: boolean;
  imsConfigured: boolean;
  imsDomain: string | null;
  running: boolean;
  tunnelAlreadyRunning: boolean;
}

export interface VowifiTestStep {
  type: 'step';
  name: string;
  ok: boolean;
  detail?: string;
  logExcerpt?: string;
  durationMs: number;
}

export interface VowifiTestResultLine {
  type: 'result';
  success: boolean;
  error?: string;
}

export type VowifiTestLine = VowifiTestStep | VowifiTestResultLine;

export async function getVowifiStatus(): Promise<VowifiValidationStatus> {
  const r = await fetch(`${BASE}/status`, { credentials: 'include' });
  return r.json();
}

export function runVowifiTest(): Promise<Response> {
  return fetch(`${BASE}/run`, { method: 'POST', credentials: 'include' });
}
