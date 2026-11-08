/**
 * Finding the resolvers this host was using before BIND took over.
 *
 * Needed because the module bootstrap points `/etc/resolv.conf` at BIND
 * (`fixResolver()`), and Ubuntu's stock `named.conf.options` ships its
 * `forwarders` block commented out. BIND then recurses from the root hints for
 * every external name. That works, but on a cold cache under a burst of
 * parallel lookups it returns SERVFAIL — which Go reports as
 * `server misbehaving` — and a Docker build or `apt-get` dies on it.
 *
 * Observed exactly that on a freshly auto-configured host: `docker compose
 * build` failed on `lookup registry-1.docker.io on 127.0.0.1:53: server
 * misbehaving`, and the same build succeeded minutes later once the cache was
 * warm. Pointing BIND at the resolvers the host already had makes external
 * resolution somebody else's problem again, which is what it was before.
 */

import * as fs from 'fs';

const HOST_ROOT = '/proc/1/root';

/**
 * Files that still name the real upstream resolvers after `/etc/resolv.conf`
 * has been replaced.
 *
 * `/run/systemd/resolve/resolv.conf` is systemd-resolved's own view and keeps
 * the DHCP-learned servers; the netif lease files carry them as `DNS=`.
 */
const RESOLVER_SOURCES = [
  '/run/systemd/resolve/resolv.conf',
  '/run/systemd/network/resolv.conf',
];
const LEASE_DIR = '/run/systemd/netif/leases';

const IPV4 = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g;

/** True for any address in 127/8 — loopback, i.e. BIND itself. */
export function isLoopbackv4(ip: string): boolean {
  return /^127\./.test(ip);
}

/**
 * Pulls usable upstream resolvers out of whatever the host files say.
 *
 * Two exclusions are not optional, because either one makes BIND forward to
 * itself and resolution stops entirely:
 *
 *   - **loopback**, which is where `fixResolver()` has just pointed the host;
 *   - **our own addresses**, which includes the DNS service address this
 *     feature allocated.
 *
 * IPv4 only, deliberately. `bind-controller.ts`'s `readForwarders()` filters
 * what it reads back through an IPv4 pattern, so a v6 forwarder would be
 * invisible to it — the forwarders list would read as empty on every
 * subsequent check and get rewritten forever.
 */
export function parseUpstreamResolvers(texts: string[], exclude: string[] = []): string[] {
  const skip = new Set(exclude);
  const out: string[] = [];
  for (const text of texts) {
    for (const m of text.matchAll(IPV4)) {
      const ip = m[1];
      if (isLoopbackv4(ip)) continue;
      if (skip.has(ip)) continue;
      if (!ip.split('.').every(o => Number(o) <= 255)) continue;
      if (!out.includes(ip)) out.push(ip);
    }
  }
  return out;
}

/** Public resolvers, used only when the host's own cannot be determined. */
export const FALLBACK_RESOLVERS = ['8.8.8.8', '1.1.1.1'] as const;

/**
 * The host's upstream resolvers, or the public fallback.
 *
 * Returns which it used, so the operator-facing report can say whether this
 * deployment forwards to their DNS or to a public one — a real difference on a
 * network with internal zones.
 */
export function discoverUpstreamResolvers(
  exclude: string[] = [],
): { resolvers: string[]; source: 'host' | 'fallback' } {
  const texts: string[] = [];
  for (const p of RESOLVER_SOURCES) {
    try {
      if (fs.existsSync(`${HOST_ROOT}${p}`)) texts.push(fs.readFileSync(`${HOST_ROOT}${p}`, 'utf-8'));
    } catch { /* unreadable is the same as absent here */ }
  }
  try {
    const dir = `${HOST_ROOT}${LEASE_DIR}`;
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        try {
          const raw = fs.readFileSync(`${dir}/${f}`, 'utf-8');
          // Only the DNS= lines: a lease also carries the host's OWN address,
          // the gateway and the subnet, none of which are resolvers.
          for (const line of raw.split('\n')) {
            if (/^\s*DNS=/.test(line)) texts.push(line);
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  const found = parseUpstreamResolvers(texts, exclude);
  return found.length > 0
    ? { resolvers: found, source: 'host' }
    : { resolvers: [...FALLBACK_RESOLVERS], source: 'fallback' };
}
