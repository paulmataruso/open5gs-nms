import * as fs from 'fs';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { HOST_ROOT } from '../twamp/twamp-runner';
import { OPEN5GS_SRC_DIR } from './qci-hw-test-runner';

const execFileAsync = promisify(execFile);

// ── Real UE detach via Diameter S6a Cancel-Location-Request ─────────────────
//
// Sends a genuine 3GPP Cancel-Location-Request to open5gs-mmed for a given
// IMSI — the real, standards-compliant mechanism a network uses to forcibly
// pull a subscriber off, not a workaround: confirmed live 2026-08-31 by
// reading src/mme/mme-s6a-handler.c's own CLR handling, which (for
// Cancellation-Type=SUBSCRIPTION_WITHDRAWAL) sends a real NAS Detach Request
// to the UE (or pages it first if idle) and tears down its S1/GTP context.
// Built the same way as qci-hw-test: a small Go+cgo tool linking directly
// against Open5GS's own compiled Diameter libraries (libogsdiameter-s6a,
// libogsdiameter-common — the exact libraries open5gs-mmed itself links
// against, on the same freeDiameter libfdcore/libfdproto), so the message
// this tool builds is guaranteed wire-compatible rather than trusting a
// separate Diameter stack implementation.
//
// Full mechanism, the three real init-order bugs hit and fixed to get a
// working peer connection, and the complete required LoadExtension chain
// are documented in cshim/shim.c's own header comment and inline comments —
// all confirmed against the real, running MME on this host (2026-08-31).

export const UE_DETACH_DIR = '/opt/open5gs-nms/ue-detach';
export const UE_DETACH_SRC = `${UE_DETACH_DIR}/main.go`;
export const UE_DETACH_BIN = `${UE_DETACH_DIR}/ue-detach-tool`;
export const UE_DETACH_CSHIM_DIR = `${UE_DETACH_DIR}/cshim`;
export const UE_DETACH_CONFIG = `${UE_DETACH_DIR}/ue-detach.yaml`;

export const UE_DETACH_LOCAL_ADDR = '127.0.0.20';
export const UE_DETACH_LOCAL_IDENTITY_PREFIX = 'ue-detach';

export function isUeDetachToolBuilt(): boolean {
  return fs.existsSync(`${HOST_ROOT}${UE_DETACH_BIN}`);
}

// Same source-tree dependency as qci-hw-test, checked against the
// diameter/s6a library specifically rather than s1ap's.
export function isOpen5gsSrcTreeAvailable(): boolean {
  const marker = `${HOST_ROOT}${OPEN5GS_SRC_DIR}/build/lib/diameter/s6a/libogsdiameter-s6a.so`;
  return fs.existsSync(marker);
}

function deriveEpcDomain(mcc: string, mnc: string): string {
  return `epc.mnc${mnc.padStart(3, '0')}.mcc${mcc}.3gppnetwork.org`;
}

// Reads mcc/mnc straight from the live mme.yaml — same source of truth
// ims-controller.ts's own readMccMnc() uses, kept as its own tiny copy here
// rather than importing across module boundaries for one two-line lookup.
function readMccMnc(): { mcc: string; mnc: string } {
  let mcc = '001'; let mnc = '01';
  try {
    const raw = fs.readFileSync(`${HOST_ROOT}/etc/open5gs/mme.yaml`, 'utf-8');
    const mccM = raw.match(/mcc:\s*['"]?(\d+)['"]?/);
    const mncM = raw.match(/mnc:\s*['"]?(\d+)['"]?/);
    if (mccM) mcc = mccM[1];
    if (mncM) mnc = mncM[1];
  } catch { /* defaults */ }
  return { mcc, mnc };
}

export interface UeDetachIdentity {
  localIdentity: string;
  realm: string;
  mmeIdentity: string;
}

export function resolveUeDetachIdentity(): UeDetachIdentity {
  const { mcc, mnc } = readMccMnc();
  const realm = deriveEpcDomain(mcc, mnc);
  return {
    localIdentity: `${UE_DETACH_LOCAL_IDENTITY_PREFIX}.${realm}`,
    realm,
    mmeIdentity: `mme.${realm}`,
  };
}

// Idempotently ensures MME's own freeDiameter config whitelists this tool as
// a peer — freeDiameter rejects unknown peers by default (confirmed live
// 2026-08-31, see mme.conf's own comment: "all unknown connecting peers are
// rejected"). Returns true if the entry was newly added (caller should
// restart open5gs-mmed to pick it up), false if it already existed. mme.conf
// itself is Open5GS's own packaged default, not something this NMS
// templates/manages elsewhere — this is a targeted, minimal upsert (one
// line appended after the existing peer entries), not a rewrite of the file.
export function ensureMmeAcceptsUeDetachPeer(localIdentity: string): boolean {
  const path = `${HOST_ROOT}/etc/freeDiameter/mme.conf`;
  let content: string;
  try {
    content = fs.readFileSync(path, 'utf-8');
  } catch {
    return false; // no mme.conf at all — MME/Diameter not set up on this host
  }
  const line = `ConnectPeer = "${localIdentity}" { No_TLS; };`;
  if (content.includes(line)) return false;

  const marker = /^ConnectPeer = "hss\.[^\n]*$/m;
  if (marker.test(content)) {
    content = content.replace(marker, (m) => `${m}\n${line}`);
  } else {
    content += `\n${line}\n`;
  }
  fs.writeFileSync(path, content, 'utf-8');
  return true;
}

const MAIN_GO_TEMPLATE = `${__dirname}/../../../config/ue-detach-templates/main.go`;
const CSHIM_TEMPLATE_DIR = `${__dirname}/../../../config/ue-detach-templates/cshim`;

function spawnStream(bashScript: string, write: (s: string) => void): Promise<number> {
  return new Promise(resolve => {
    const child = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', '--', 'bash', '-c', bashScript], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d: Buffer) => write(d.toString()));
    child.stderr.on('data', (d: Buffer) => write(d.toString()));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export async function installUeDetachTool(write: (s: string) => void): Promise<{ success: boolean; error?: string }> {
  if (!isOpen5gsSrcTreeAvailable()) {
    const msg = `Open5GS's own compiled Diameter S6a library was not found under ${OPEN5GS_SRC_DIR} — this feature needs Open5GS built from source with its dev artifacts (headers + .so files) still present, not a packaged/stripped install.`;
    write(`\n❌ ${msg}`);
    return { success: false, error: msg };
  }

  try {
    write('=== Writing main.go + cshim (Open5GS Diameter S6a codec bridge) ===');
    fs.mkdirSync(`${HOST_ROOT}${UE_DETACH_CSHIM_DIR}`, { recursive: true });
    fs.writeFileSync(`${HOST_ROOT}${UE_DETACH_SRC}`, fs.readFileSync(MAIN_GO_TEMPLATE, 'utf-8'), 'utf-8');
    for (const f of ['cgo.go', 'shim.c', 'shim.h']) {
      let content = fs.readFileSync(`${CSHIM_TEMPLATE_DIR}/${f}`, 'utf-8');
      content = content.split('__OPEN5GS_SRC_DIR__').join(OPEN5GS_SRC_DIR);
      fs.writeFileSync(`${HOST_ROOT}${UE_DETACH_CSHIM_DIR}/${f}`, content, 'utf-8');
    }

    // Trivial placeholder — ogs_app_initialize() asserts a config file was
    // successfully opened, but nothing in this tool's own init path reads
    // values back out of it (see shim.c's own comment on this).
    fs.writeFileSync(`${HOST_ROOT}${UE_DETACH_CONFIG}`, 'logger:\n', 'utf-8');

    const { localIdentity } = resolveUeDetachIdentity();
    write(`\n=== Ensuring MME accepts this tool as a Diameter peer (${localIdentity}) ===`);
    const peerAdded = ensureMmeAcceptsUeDetachPeer(localIdentity);
    if (peerAdded) {
      write('\nAdded new ConnectPeer entry to mme.conf — restarting open5gs-mmed to pick it up...');
      const restartExit = await spawnStream('systemctl restart open5gs-mmed && sleep 2 && systemctl is-active open5gs-mmed', write);
      if (restartExit !== 0) {
        write('\n❌ open5gs-mmed restart failed.');
        return { success: false, error: `mme restart exit ${restartExit}` };
      }
    } else {
      write('\nPeer already whitelisted, no MME restart needed.');
    }

    write('\n=== Building (go build, cgo enabled — no external Go modules needed) ===');
    const buildExit = await spawnStream(
      `set -e\n` +
      `export PATH=/usr/local/go/bin:$PATH\n` +
      `export GOCACHE=${UE_DETACH_DIR}/.gocache\n` +
      `export GOMODCACHE=${UE_DETACH_DIR}/.gomodcache\n` +
      `export CGO_ENABLED=1\n` +
      `cd ${UE_DETACH_DIR}\n` +
      `[ -f go.mod ] || go mod init ue-detach-tool\n` +
      `go build -o ${UE_DETACH_BIN} ${UE_DETACH_SRC}`,
      write,
    );
    if (buildExit !== 0) {
      write(`\n❌ Build failed (exit ${buildExit}).`);
      return { success: false, error: `build exit ${buildExit}` };
    }

    write('\n✅ UE detach tool built. Select a UE on the RAN or Subscriber page to block it.');
    return { success: true };
  } catch (err) {
    write(`\n❌ Install error: ${String(err)}`);
    return { success: false, error: String(err) };
  }
}

export interface UeDetachOutcome {
  status: 'success' | 'rejected' | 'timeout' | 'error';
  resultCode?: number;
  experimentalResultCode?: number;
  message?: string;
}

// Spawns one CLR send, parses the tool's single JSON "result" line, and
// resolves once it exits or timeoutMs elapses. Same SIGTERM-then-SIGKILL
// pattern as qci-hw-test-runner.ts's runQciHwTest.
export function runUeDetach(imsi: string, timeoutMs: number): Promise<UeDetachOutcome> {
  return new Promise((resolve) => {
    const { localIdentity, realm, mmeIdentity } = resolveUeDetachIdentity();
    const proc = spawn('nsenter', [
      '-t', '1', '-m', '-u', '-i', '-p', '--',
      UE_DETACH_BIN,
      '-imsi', imsi,
      '-local-identity', localIdentity,
      '-realm', realm,
      '-local-addr', UE_DETACH_LOCAL_ADDR,
      '-mme-identity', mmeIdentity,
      '-timeout', String(Math.max(1, Math.floor(timeoutMs / 1000) - 2)),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let buffer = '';
    let settled = false;

    const settle = (outcome: UeDetachOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: any;
      try { parsed = JSON.parse(trimmed); } catch { return; }
      if (parsed.type === 'result') {
        settle({
          status: parsed.success ? 'success' : 'rejected',
          resultCode: parsed.resultCode,
          experimentalResultCode: parsed.experimentalResultCode,
          message: parsed.message,
        });
      } else if (parsed.type === 'error') {
        settle({ status: 'error', message: parsed.message });
      }
    };

    proc.stdout.on('data', (d: Buffer) => {
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });
    proc.stderr.on('data', () => { /* human-readable log only */ });

    proc.on('exit', () => settle({ status: 'timeout', message: 'process exited without a result' }));
    proc.on('error', (err) => settle({ status: 'error', message: String(err) }));

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } settle({ status: 'timeout' }); }, 5000);
    }, timeoutMs);
  });
}
