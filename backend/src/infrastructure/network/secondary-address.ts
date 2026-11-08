/**
 * Live host operations for Auto-Configuration: probing an address, and binding
 * it as a SECONDARY address on the one real L2 interface.
 *
 * Deliberately not dummy interfaces. The dummy/L3 model (`dummy-interface.ts`)
 * gives each service its own /32 netdev and expects a routing protocol to
 * advertise it; Auto-Configuration targets the opposite case — a single
 * interface on a flat L2 segment, where every service address is simply
 * another address on that NIC and the upstream gateway already reaches it.
 */

import { nsenter } from './dummy-interface';
import * as fs from 'fs';
import * as path from 'path';
import type { LivenessRunner } from '../../domain/services/address-liveness';
import { netplanDropIn, AUTOCONFIG_NETPLAN_FILE } from '../../domain/services/autoconfig-apply';

const HOST_NETPLAN_DIR = '/proc/1/root/etc/netplan';
const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const IFACE_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,14}$/;

function assertIp(ip: string): void {
  if (!IP_RE.test(ip)) throw new Error(`Invalid IP address: ${ip}`);
}
function assertIface(iface: string): void {
  if (!IFACE_RE.test(iface)) throw new Error(`Invalid interface name: ${iface}`);
}

/**
 * `ip neigh` states that mean something answered for this address.
 *
 * `FAILED` and `INCOMPLETE` are the opposite — the kernel asked and got
 * nothing, which is real evidence the address is free. An entry carrying an
 * `lladdr` in any other state means a host replied.
 */
const NEIGH_DEAD = /\b(FAILED|INCOMPLETE)\b/;

/** True when `ip neigh show` output shows a resolved neighbour. */
export function neighbourAnswered(neighOutput: string): boolean {
  const line = neighOutput.trim();
  if (!line) return false;
  if (!/\blladdr\s+([0-9a-f]{2}:){5}[0-9a-f]{2}\b/i.test(line)) return false;
  return !NEIGH_DEAD.test(line);
}

/** True when `arping -D` output indicates a reply (i.e. the address is in use). */
export function arpingSawReply(stdout: string): boolean {
  // `arping -D -c N` prints "Received 0 reply" when nothing answered, and
  // "Received 1 reply" / "Unicast reply from ..." when something did.
  if (/Received\s+0\s+(reply|replies|response)/i.test(stdout)) return false;
  return /Unicast reply from|Received\s+[1-9]\d*\s+(reply|replies|response)/i.test(stdout);
}

/**
 * The real probe pair, run in the HOST network namespace.
 *
 * Neither method throws for a missing tool. That matters: `probeAddress()`
 * treats a thrown probe as TAKEN, so an absent `arping` binary would make
 * every candidate look occupied and halt the whole run. A tool we cannot run
 * contributes no signal instead — the remaining probe still decides, and the
 * orchestrator reports which methods were actually available.
 */
export class HostLivenessRunner implements LivenessRunner {
  readonly unavailable = new Set<string>();

  constructor(private readonly iface: string) { assertIface(iface); }

  async ping(ip: string): Promise<boolean> {
    assertIp(ip);
    try {
      // -c1 one probe, -W1 one second, -n no reverse DNS (a slow resolver
      // would otherwise dominate the timeout budget).
      await nsenter('ping', ['-c', '1', '-W', '1', '-n', '-I', this.iface, ip], 4000);
      return true;
    } catch (err: any) {
      // A non-zero exit is the normal "no answer" case, not a failure to look.
      if (err?.code === 'ENOENT') { this.unavailable.add('ping'); return false; }
      return false;
    }
  }

  async arping(ip: string): Promise<boolean> {
    assertIp(ip);
    // Preferred: real duplicate-address detection. -D sends from 0.0.0.0 so a
    // reply means another host claims the address.
    try {
      const { stdout } = await nsenter('arping', ['-D', '-c', '2', '-w', '2', '-I', this.iface, ip], 5000);
      return arpingSawReply(stdout);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        // arping exits non-zero when the address IS a duplicate, and also on
        // some permission errors. Its stdout still carries the verdict.
        const out = String(err?.stdout ?? '');
        if (out) return arpingSawReply(out);
      } else {
        this.unavailable.add('arping');
      }
    }
    // Fallback with no extra package (`arping` is not installed by default on
    // Ubuntu): the ping above already made the kernel resolve this address,
    // so the neighbour table now holds the answer.
    //
    // Read it twice when the first read is still INCOMPLETE. `ping -W1`
    // returns after one second whether or not ARP has settled, so a reply
    // arriving just after that would otherwise be read as "no entry" — a
    // false FREE, which is the one answer this must never give. On-link ARP
    // resolves in well under the extra wait, so one retry closes it.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { stdout } = await nsenter('ip', ['neigh', 'show', ip, 'dev', this.iface], 4000);
        if (neighbourAnswered(stdout)) return true;
        if (!/\bINCOMPLETE\b/.test(stdout)) return false;   // settled, and nothing is there
      } catch {
        return false;
      }
      if (attempt === 0) await new Promise(r => setTimeout(r, 400));
    }
    return false;
  }
}

/** IPv4 addresses currently bound to an interface, without prefixes. */
export async function listBoundAddresses(iface: string): Promise<string[]> {
  assertIface(iface);
  const { stdout } = await nsenter('ip', ['-j', '-4', 'addr', 'show', 'dev', iface]);
  const parsed: any[] = JSON.parse(stdout || '[]');
  return (parsed[0]?.addr_info ?? [])
    .filter((a: any) => a.family === 'inet')
    .map((a: any) => a.local as string);
}

/**
 * Adds one secondary address to the interface, live.
 *
 * `noprefixroute` is deliberate: without it the kernel installs a duplicate
 * subnet route per added address, and on a single L2 interface every service
 * address shares one subnet — so N addresses would mean N identical routes
 * competing with the one the management address already installed.
 */
export async function bindSecondaryAddress(iface: string, ip: string, prefix: number): Promise<void> {
  assertIface(iface);
  assertIp(ip);
  if (!Number.isInteger(prefix) || prefix < 1 || prefix > 32) throw new Error(`Invalid prefix: ${prefix}`);
  await nsenter('ip', ['addr', 'add', `${ip}/${prefix}`, 'dev', iface, 'noprefixroute']);
}

/** Removes one address from the interface. Used only to roll back a failed run. */
export async function unbindAddress(iface: string, ip: string, prefix: number): Promise<void> {
  assertIface(iface);
  assertIp(ip);
  await nsenter('ip', ['addr', 'del', `${ip}/${prefix}`, 'dev', iface]).catch(() => {});
}

export interface NetplanPersistResult {
  path: string;
  validated: boolean;
  warning?: string;
}

/**
 * Persists the addresses so they survive a reboot — WITHOUT applying.
 *
 * `netplan apply` is never called here, on purpose. The addresses were already
 * added live above, so there is nothing to apply; and `netplan apply` bounces
 * the interface, which on a single-NIC host drops the management address the
 * NMS itself is reached on. At boot that would take the NMS offline in the
 * middle of its own first run. `netplan generate` validates the file without
 * touching the running configuration, so a syntax error is still caught now
 * rather than at the operator's next reboot.
 */
export async function persistNetplan(
  iface: string,
  addresses: string[],
  prefix: number,
): Promise<NetplanPersistResult> {
  assertIface(iface);
  for (const ip of addresses) assertIp(ip);

  const target = path.join(HOST_NETPLAN_DIR, AUTOCONFIG_NETPLAN_FILE);
  fs.mkdirSync(HOST_NETPLAN_DIR, { recursive: true });
  fs.writeFileSync(target, netplanDropIn(iface, addresses, prefix), { encoding: 'utf-8', mode: 0o600 });

  try {
    await nsenter('netplan', ['generate'], 30000);
    return { path: target, validated: true };
  } catch (err: any) {
    const detail = String(err?.stderr || err?.stdout || err?.message || err).trim();
    return {
      path: target,
      validated: false,
      warning: `netplan generate rejected the drop-in: ${detail}. The addresses are live now but may not survive a reboot.`,
    };
  }
}

/** Removes the drop-in. Live addresses are untouched. */
export function removeNetplanDropIn(): boolean {
  const target = path.join(HOST_NETPLAN_DIR, AUTOCONFIG_NETPLAN_FILE);
  if (!fs.existsSync(target)) return false;
  fs.unlinkSync(target);
  return true;
}

/**
 * The addresses our own netplan drop-in claims.
 *
 * This is the second half of knowing which addresses are OURS rather than
 * somebody else's. It matters because our own addresses answer both probes —
 * we are the host answering — so without this they look permanently occupied
 * and a re-run allocates a fresh set beside them.
 *
 * Read from the drop-in rather than only the manifest because the drop-in is
 * written at the moment the addresses are bound, so it survives a run
 * interrupted before the manifest is recorded.
 */
export function readNetplanDropInAddresses(): string[] {
  const target = path.join(HOST_NETPLAN_DIR, AUTOCONFIG_NETPLAN_FILE);
  try {
    if (!fs.existsSync(target)) return [];
    return parseNetplanAddresses(fs.readFileSync(target, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * Pulls the addresses out of a netplan drop-in's text.
 *
 * Deliberately a line scan rather than a YAML parse: this file is written by
 * `netplanDropIn()` in one known shape, and taking a YAML dependency to read
 * back our own output would be the larger risk.
 */
export function parseNetplanAddresses(raw: string): string[] {
  return [...raw.matchAll(/^\s*-\s*"?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/\d{1,2}"?\s*$/gm)]
    .map(m => m[1]);
}
