// Shared IPv4 CIDR/address math — used for UE IP pool scanning (validation-controller,
// swu-emulator-controller) and framed-route overlap checking (subscriber-management).

// Real, confirmed-live 2026-09-30 finding (a full-session live-API verification pass):
// this never validated its input — a malformed string like "not-a-cidr" silently produced
// 0.0.0.0 instead of throwing (`.split('.').map(Number)` on a dot-less string yields
// `[NaN]`, and JS's bitwise operators coerce NaN/undefined to 0 via ToInt32 rather than
// erroring). cidrRange()/cidrNetworkRange() below both already assume this throws on bad
// input (callers like apn-profile-usecase.ts's validateInput() wrap them in try/catch
// specifically to convert a malformed CIDR into a real validation error) — this silent
// fallthrough meant that guard never actually fired, and a real live test wrote a garbage
// "not-a-cidr" subnet straight into smf.yaml/upf.yaml's session arrays via the real API.
const OCTET_RE = /^(25[0-5]|2[0-4]\d|[01]?\d?\d)$/;
export function ipToNum(ip: string): number {
  const p = ip.split('.');
  if (p.length !== 4 || !p.every(o => OCTET_RE.test(o))) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  const n = p.map(Number);
  return (((n[0] << 24) | (n[1] << 16) | (n[2] << 8) | n[3]) >>> 0);
}

export function numToIp(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

// Same class of fix as ipToNum() above, same live incident: `Number(bits ?? 32)` on a
// malformed prefix (e.g. "not-a-cidr" itself has no "/" at all, or a real IP with a
// garbage prefix like "10.0.0.0/abc") silently produced NaN, and `~0 << (32 - NaN)`
// coerces to `~0 << 0` = an all-ones /32 mask instead of throwing — a second, independent
// silent-corruption path alongside ipToNum()'s own, in the exact functions whose callers
// already assume a throw on bad input.
function parseCidr(cidr: string): { net: number; mask: number } {
  const [addr, bits] = cidr.split('/');
  const prefix = bits === undefined ? 32 : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid CIDR prefix: ${cidr}`);
  }
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const net = (ipToNum(addr) & mask) >>> 0;
  return { net, mask };
}

// Host-assignable range for a CIDR (excludes network + broadcast addresses).
export function cidrRange(cidr: string): { first: number; last: number } {
  const { net, mask } = parseCidr(cidr);
  const bcast = (net | (~mask >>> 0)) >>> 0;
  return { first: net + 1, last: bcast - 1 };
}

// Full network range for a CIDR (includes network + broadcast) — the right range to use
// for overlap comparisons, unlike cidrRange() above which is host-assignment-specific.
export function cidrNetworkRange(cidr: string): { first: number; last: number } {
  const { net, mask } = parseCidr(cidr);
  const bcast = (net | (~mask >>> 0)) >>> 0;
  return { first: net, last: bcast };
}

export function ipv4CidrOverlaps(a: string, b: string): boolean {
  const ra = cidrNetworkRange(a);
  const rb = cidrNetworkRange(b);
  return ra.first <= rb.last && rb.first <= ra.last;
}
