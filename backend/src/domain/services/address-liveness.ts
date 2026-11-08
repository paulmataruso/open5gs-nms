/**
 * Duplicate-address detection for the Auto-Configuration allocator.
 *
 * Every candidate address is confirmed free before anything binds it. Binding
 * an address another host already owns is one of the worst outcomes available
 * here: both machines answer ARP for it, traffic splits unpredictably between
 * them, and the symptom appears on the OTHER host — which nobody is looking at.
 *
 * Two probes, and an address is treated as TAKEN if EITHER answers:
 *
 *   - **ICMP echo (ping)**, as specified. Direct and cheap.
 *   - **ARP**, because ping alone is not sufficient evidence of absence. A host
 *     with a local firewall dropping ICMP is completely silent to ping while
 *     still owning the address, so ping-only would report it free and we would
 *     take it. On-link, a host MUST answer ARP to be reachable at all, which
 *     makes ARP the stronger signal of the two.
 *
 * The asymmetry is deliberate: a false "taken" costs one skipped address, a
 * false "free" costs an outage on someone else's host. So the probes are
 * combined with OR, never AND, and an inconclusive probe is treated as taken.
 */

export interface LivenessProbeResult {
  ip: string;
  taken: boolean;
  /** Which probe saw it, for the operator-facing report. */
  via: 'icmp' | 'arp' | 'both' | 'none' | 'error';
  detail?: string;
}

/** Everything this module needs from the host, injected so it is testable. */
export interface LivenessRunner {
  /** Resolves true when the address answers ICMP echo. */
  ping(ip: string): Promise<boolean>;
  /** Resolves true when the address answers ARP (or has a resolved neighbour entry). */
  arping(ip: string): Promise<boolean>;
}

/**
 * Classifies one address.
 *
 * A probe that THROWS is treated as taken, not free. We cannot distinguish
 * "nothing is there" from "we failed to look", and only one of those is safe
 * to act on.
 */
export async function probeAddress(runner: LivenessRunner, ip: string): Promise<LivenessProbeResult> {
  let icmp = false;
  let arp = false;
  let errored = false;
  let detail: string | undefined;

  try { icmp = await runner.ping(ip); }
  catch (err) { errored = true; detail = `ping failed: ${String(err)}`; }

  try { arp = await runner.arping(ip); }
  catch (err) { errored = true; detail = `${detail ? detail + '; ' : ''}arp failed: ${String(err)}`; }

  if (icmp && arp) return { ip, taken: true, via: 'both' };
  if (icmp) return { ip, taken: true, via: 'icmp' };
  if (arp) return { ip, taken: true, via: 'arp' };
  if (errored) {
    return {
      ip, taken: true, via: 'error',
      detail: `${detail} — treating as IN USE, because a failed probe is not evidence the address is free`,
    };
  }
  return { ip, taken: false, via: 'none' };
}

/**
 * Probes a list of addresses, newest result wins, with bounded concurrency.
 *
 * Concurrency is capped rather than unbounded: a wide subnet would otherwise
 * launch hundreds of simultaneous pings, which both floods the segment the
 * deployment is about to live on and makes timeouts unreliable enough to
 * produce false "free" answers — the one error this must not make.
 */
export async function probeAddresses(
  runner: LivenessRunner,
  ips: string[],
  concurrency = 8,
): Promise<Map<string, LivenessProbeResult>> {
  const out = new Map<string, LivenessProbeResult>();
  const queue = [...ips];
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length || 1)) }, async () => {
    for (;;) {
      const ip = queue.shift();
      if (ip === undefined) return;
      out.set(ip, await probeAddress(runner, ip));
    }
  });
  await Promise.all(workers);
  return out;
}

/** Numeric IPv4 ordering, so .9 sorts before .10 rather than after it. */
function cmpIpv4(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/**
 * Formats what the probe found, for the log and the status endpoint.
 */
export function describeProbe(results: Map<string, LivenessProbeResult>): string {
  // Sorted by address, not by the order probes happened to finish in. The
  // probes run concurrently, so completion order is effectively arbitrary and
  // an operator scanning this list for a specific address should not have to
  // hunt for it.
  const taken = [...results.values()].filter(r => r.taken).sort((a, b) => cmpIpv4(a.ip, b.ip));
  if (taken.length === 0) return `Probed ${results.size} address(es); all free.`;
  const lines = [`Probed ${results.size} address(es); ${taken.length} already in use:`];
  for (const r of taken) {
    lines.push(`  ${r.ip.padEnd(15)} answered ${r.via}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  return lines.join('\n');
}
