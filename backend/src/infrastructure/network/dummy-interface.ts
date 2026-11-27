import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';

const execFileAsync = promisify(execFile);

// Runs a command in the host's namespaces (mount/uts/ipc/net/pid) from
// inside the NMS backend container. Shared by frr-controller.ts (persistent,
// FRR-advertised dummy interfaces for real NFs) and validation-controller.ts
// (ephemeral, host-local-only dummy interfaces for simulated radios).
export const nsenter = async (
  cmd: string,
  args: string[] = [],
  timeoutMs = 20000,
): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync('nsenter', ['-t', '1', '-m', '-u', '-i', '-n', '-p', cmd, ...args], {
    timeout: timeoutMs,
    encoding: 'utf-8',
    env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/var/run/dbus/system_bus_socket' },
  });

/**
 * What a failed `nsenter()` actually carries.
 *
 * `promisify(execFile)` rejects with an Error that has `code` (the numeric
 * exit status, or a string like `'ENOENT'` when the binary is missing) plus
 * the captured `stdout`/`stderr` attached to it. Callers used to read those
 * through `catch (err: any)` and `err?.code`, which switched off type checking
 * for the whole handler — and the distinction matters here: several call sites
 * treat a MISSING tool completely differently from a tool that ran and exited
 * non-zero, and `arping -D` inverts its exit code so its verdict has to be
 * read out of the stdout attached to the rejection.
 *
 * Narrows rather than coerces: a field that is not there reads as absent, not
 * as the string "undefined".
 */
export interface NsenterFailure {
  /** Exit status, or `'ENOENT'`-style spawn error; undefined if neither. */
  code: string | number | undefined;
  stdout: string;
  stderr: string;
  /** The Error's own message, or `String(err)` for a non-Error throw. */
  message: string;
}

export function nsenterFailure(err: unknown): NsenterFailure {
  const e = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>;
  const code = e.code;
  return {
    code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
    stdout: capturedText(e.stdout),
    stderr: capturedText(e.stderr),
    message: err instanceof Error ? err.message : String(err),
  };
}

// nsenter() passes `encoding: 'utf-8'`, so a captured stream is a string. A
// Buffer is the one other thing it can be (no encoding, or a caller that
// changed it), and its text is the useful reading. Anything else is reported
// as absent rather than becoming "[object Object]" in an operator-facing
// warning.
function capturedText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return v.toString('utf-8');
  return '';
}

const DUMMY_NETWORKD_DIR    = '/proc/1/root/etc/systemd/network';
const DUMMY_NETWORKD_PREFIX = '20-nms-dummy-';

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,14}$/;
const IP_RE   = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function dummyNetdevContent(name: string): string {
  return `# Managed by open5gs-nms — do not edit manually
[NetDev]
Name=${name}
Kind=dummy
`;
}

function dummyNetworkContent(name: string, ip: string, prefix: number): string {
  return `# Managed by open5gs-nms — do not edit manually
[Match]
Name=${name}

[Network]
Address=${ip}/${prefix}
`;
}

export function dummyNetdevPath(name: string):  string { return `${DUMMY_NETWORKD_DIR}/${DUMMY_NETWORKD_PREFIX}${name}.netdev`; }
export function dummyNetworkPath(name: string): string { return `${DUMMY_NETWORKD_DIR}/${DUMMY_NETWORKD_PREFIX}${name}.network`; }

/**
 * Creates (or re-IPs) a dummy interface on the host's network namespace.
 * persist=true also writes systemd-networkd files so it survives a reboot
 * (used for long-lived NF service IPs). persist=false does only the live
 * `ip` commands — nothing on disk, nothing to resurrect on next boot (used
 * for short-lived validation-session radios).
 */
export async function createDummyInterface(
  name: string,
  ip: string,
  prefix: number,
  persist: boolean,
): Promise<void> {
  if (!NAME_RE.test(name)) throw new Error(`Invalid interface name: ${name}`);
  if (!IP_RE.test(ip)) throw new Error(`Invalid IP address: ${ip}`);
  if (!Number.isInteger(prefix) || prefix < 1 || prefix > 32) throw new Error(`Invalid prefix: ${prefix}`);

  // Create the interface immediately via ip commands — do NOT reload networkd
  // after creation, because networkd would reapply its own config files
  // (including netplan-generated ones) and override the IP we just set.
  await nsenter('ip', ['link', 'add', name, 'type', 'dummy']).catch(() => { /* already exists */ });
  await nsenter('ip', ['addr', 'flush', 'dev', name]).catch(() => {});
  await nsenter('ip', ['addr', 'add', `${ip}/${prefix}`, 'dev', name]);
  await nsenter('ip', ['link', 'set', name, 'up']);

  if (persist) {
    fs.mkdirSync(DUMMY_NETWORKD_DIR, { recursive: true });
    fs.writeFileSync(dummyNetdevPath(name),  dummyNetdevContent(name),             'utf-8');
    fs.writeFileSync(dummyNetworkPath(name), dummyNetworkContent(name, ip, prefix), 'utf-8');
  }
}

/** Tears down a dummy interface and, if present, its persisted config files. */
export async function deleteDummyInterface(name: string): Promise<void> {
  if (!NAME_RE.test(name)) throw new Error(`Invalid interface name: ${name}`);

  await nsenter('ip', ['link', 'set', name, 'down']).catch(() => {});
  await nsenter('ip', ['link', 'del', name]).catch(() => {});

  for (const p of [dummyNetdevPath(name), dummyNetworkPath(name)]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}
