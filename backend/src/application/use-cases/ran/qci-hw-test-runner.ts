import * as fs from 'fs';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { HOST_ROOT } from '../twamp/twamp-runner';

const execFileAsync = promisify(execFile);

// ── On-demand QCI/dedicated-bearer hardware test ─────────────────────────────
//
// Tests whether a REAL, physical radio actually admits a given QCI value —
// not the core's own request logic (that's what the simulated-eNB QCI
// validation test would have covered, and was explicitly removed as not
// useful: "does not test real radio bearer setup"). This is the real thing:
// an operator physically attaches a real phone to the radio they want to
// test, this tool intercepts the resulting real E-RABSetupRequest via
// nftables NFQUEUE (scoped to that one radio's IP only, for the duration of
// one test), patches its QCI to the requested test value, and reports
// exactly what the real radio's own admission control decided.
//
// Same mechanism as the original qciprobe diagnostic tool built live during
// the Nokia VoLTE investigation (2026-08-29/30) — see PROJECT_STATE.md —
// rebuilt here as a permanent, on-demand, single-QCI, single-test-session
// tool instead of an always-on multi-QCI sweep.

export const QCI_HW_TEST_DIR = '/opt/open5gs-nms/qci-hw-test';
export const QCI_HW_TEST_SRC = `${QCI_HW_TEST_DIR}/main.go`;
export const QCI_HW_TEST_BIN = `${QCI_HW_TEST_DIR}/qci-hw-test`;
export const QCI_HW_TEST_CSHIM_DIR = `${QCI_HW_TEST_DIR}/cshim`;

// The one real portability caveat of this whole feature: it needs Open5GS's
// own compiled S1AP ASN.1 codec (headers + .so files), which only exist on a
// host where Open5GS was built from source with its dev artifacts still
// present — not a packaged/stripped install. Overridable via env var for a
// deployment where that tree lives somewhere else; defaults to where it's
// confirmed present on this project's own dev host.
export const OPEN5GS_SRC_DIR = process.env.OPEN5GS_SRC_DIR || '/home/paulmataruso/open5gs';

// nfqueue/v2's own go.mod requires this — confirmed live during the original
// qciprobe build (go get auto-upgraded from 1.22.2 to 1.24.0).
export const GO_VERSION = '1.24.0';

export function isQciHwTestBuilt(): boolean {
  return fs.existsSync(`${HOST_ROOT}${QCI_HW_TEST_BIN}`);
}

// Distinguishes "not installed yet" from "can't be installed on this host at
// all" so the UI can give an accurate message instead of a cryptic compile
// failure — checked before attempting a build.
export function isOpen5gsSrcTreeAvailable(): boolean {
  const marker = `${HOST_ROOT}${OPEN5GS_SRC_DIR}/build/lib/s1ap/libogss1ap.so`;
  return fs.existsSync(marker);
}

export interface QciHwTestEvent {
  type: 'ready' | 'request_seen' | 'result' | 'error';
  mmeUeS1apId?: number;
  enbUeS1apId?: number;
  erabId?: number;
  originalQci?: number;
  testQci?: number;
  success?: boolean;
  causeGroup?: number;
  causeValue?: number;
  message?: string;
}

export interface QciHwTestOutcome {
  status: 'success' | 'rejected' | 'timeout' | 'error';
  causeGroup?: number;
  causeValue?: number;
  errorMessage?: string;
}

// Runs one test session: spawns the built binary (via nsenter into the host,
// same namespaces as every other host-side action in this codebase — no -n
// needed since this backend container already runs with network_mode: host)
// scoped to radioIp/qci, streams parsed JSON-line events to onEvent as they
// arrive, and resolves once a definitive result is seen or timeoutMs elapses
// (SIGTERM first, giving the tool's own signal handler a chance to tear down
// its nftables table cleanly, matching every other risky-action pattern in
// this codebase — never SIGKILL as the first resort).
export function runQciHwTest(
  radioIp: string,
  qci: number,
  onEvent: (e: QciHwTestEvent) => void,
  timeoutMs: number,
): Promise<QciHwTestOutcome> {
  return new Promise((resolve) => {
    const proc = spawn('nsenter', [
      '-t', '1', '-m', '-u', '-i', '-p', '--',
      QCI_HW_TEST_BIN, '-radio-ip', radioIp, '-qci', String(qci),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let buffer = '';
    let settled = false;
    let sawTerminalEvent = false;

    const settle = (outcome: QciHwTestOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: QciHwTestEvent;
      try { parsed = JSON.parse(trimmed); } catch { return; }
      onEvent(parsed);
      if (parsed.type === 'result') {
        sawTerminalEvent = true;
        settle({ status: parsed.success ? 'success' : 'rejected', causeGroup: parsed.causeGroup, causeValue: parsed.causeValue });
        try { proc.kill('SIGTERM'); } catch { /* already exiting */ }
      } else if (parsed.type === 'error') {
        sawTerminalEvent = true;
        settle({ status: 'error', errorMessage: parsed.message });
        try { proc.kill('SIGTERM'); } catch { /* already exiting */ }
      }
    };

    proc.stdout.on('data', (d: Buffer) => {
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });
    proc.stderr.on('data', () => { /* human-readable log only, JSON events are on stdout */ });

    proc.on('exit', () => {
      if (!sawTerminalEvent) settle({ status: 'timeout' });
    });
    proc.on('error', (err) => settle({ status: 'error', errorMessage: String(err) }));

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      // exit handler will settle() with 'timeout' once the process actually exits
      // (giving nftTeardown() time to run) — but cap the wait so a hung process
      // can't block the request forever.
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } settle({ status: 'timeout' }); }, 5000);
    }, timeoutMs);
  });
}

// The one leak this on-demand tool can suffer from: the test binary is spawned via
// `nsenter -p` into the HOST's own pid namespace (matching every other host-side
// spawn in this codebase), so if the backend CONTAINER restarts while a test is in
// flight (a redeploy, a crash), the spawned process is reparented under the host's
// real init and keeps running — the Node-side setTimeout that would have SIGTERM'd
// it dies with the old process. A leftover instance permanently holds its NFQUEUE
// bindings, so every subsequent run fails at bind time with a misleading "operation
// not permitted" (confirmed live 2026-08-30, from two container rebuilds mid-session
// during this feature's own bring-up). There's no dedicated "End Test" button for
// this tool — it's reached via the Validation page's existing Force Cleanup button.
export async function killStrayQciHwTestProcesses(): Promise<string[]> {
  const results: string[] = [];
  const nsenterArgs = ['-t', '1', '-m', '-u', '-i', '-p', '--'];

  try {
    await execFileAsync('nsenter', [...nsenterArgs, 'pkill', '-TERM', '-f', QCI_HW_TEST_BIN]);
    results.push('Sent SIGTERM to running qci-hw-test process(es)');
  } catch (err: any) {
    if (err?.code === 1) {
      results.push('No running qci-hw-test process found');
      return results;
    }
    results.push(`pkill -TERM failed: ${String(err)}`);
  }

  await new Promise(r => setTimeout(r, 3000));

  try {
    const { stdout } = await execFileAsync('nsenter', [...nsenterArgs, 'pgrep', '-f', QCI_HW_TEST_BIN]);
    if (stdout.trim()) {
      await execFileAsync('nsenter', [...nsenterArgs, 'pkill', '-KILL', '-f', QCI_HW_TEST_BIN]);
      results.push('Process did not exit on SIGTERM — sent SIGKILL');
    } else {
      results.push('Confirmed no qci-hw-test process remains');
    }
  } catch (err: any) {
    results.push(err?.code === 1 ? 'Confirmed no qci-hw-test process remains' : `Post-kill check failed: ${String(err)}`);
  }

  return results;
}
