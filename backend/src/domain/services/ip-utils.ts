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

/**
 * Whether a string is a well-formed dotted-quad IPv4 address.
 *
 * The same test `ipToNum` throws on, exposed for callers that need to DROP a
 * bad value rather than fail on it — reading a host tool's output, say, where
 * one unusable entry should not take the whole reading down. Having one
 * definition matters: several places in this codebase grew their own
 * `/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/`, which accepts 999.1.1.1, and
 * `infrastructure/network/main-interface.ts` carried a copy of the ARITHMETIC
 * with no validation at all until Phase 6.
 */
export function isIpv4(ip: string): boolean {
  const p = ip.split('.');
  return p.length === 4 && p.every(o => OCTET_RE.test(o));
}

export function ipToNum(ip: string): number {
  if (!isIpv4(ip)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  const n = ip.split('.').map(Number);
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
// A prefix is one or two plain digits. Matching the TEXT, not just the value
// Number() produces from it, is what closes the third defect of this same
// family, found 2026-11-27 (see parseCidr below).
const PREFIX_RE = /^\d{1,2}$/;

function parseCidr(cidr: string): { net: number; mask: number } {
  // Third instance of this file's own documented defect class, and the worst
  // consequence of the three. `Number('')` is 0, so a TRAILING-SLASH CIDR --
  // `"10.45.0.0/"`, which is what a truncated field or a half-finished hand
  // edit of smf.yaml produces -- passed every check below as prefix 0 and
  // came back out as the ENTIRE IPv4 space. That is not merely a wrong value:
  // validation-controller.ts's free-IP-block scan runs
  // `for (let ip = first; ip <= last; ip++)` over whatever cidrRange() hands
  // it, so one trailing slash turned that into 4,294,967,294 synchronous
  // iterations and wedged the event loop for the whole backend.
  // `ipv4CidrOverlaps()` meanwhile reported a conflict against every address
  // on the internet, which would reject every legitimate framed route.
  // The same hole swallowed `"10.0.0.0/ "` and `"10.0.0.0/\n"`.
  //
  // Splitting on more than one '/' is rejected for the same reason: the
  // destructure below silently ignored everything after the second field, so
  // `"10.0.0.0/24/junk"` read as a clean /24.
  const parts = cidr.split('/');
  if (parts.length > 2) {
    throw new Error(`Invalid CIDR: ${cidr}`);
  }
  const [addr, bits] = parts;
  if (bits !== undefined && !PREFIX_RE.test(bits)) {
    throw new Error(`Invalid CIDR prefix: ${cidr}`);
  }
  const prefix = bits === undefined ? 32 : Number(bits);
  // Kept as well as the pattern above: the pattern accepts "99", the range
  // check is what refuses it.
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
