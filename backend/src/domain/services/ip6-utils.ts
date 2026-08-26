// IPv6 CIDR math — built for #30's follow-up feature request (automatic IPv6
// /64 allocation for APN profiles, 2026-08-25): a core-wide IPv6 "parent"
// prefix (e.g. a /48 or /56) that each APN profile gets handed the next
// unused /64 out of, the same shape AutoAssignIPsUseCase already gives IPv4
// pools. No IPv6 arithmetic existed anywhere in this codebase before this —
// ip-utils.ts's own header comment says so explicitly (IPv4-only, confirmed
// during #28) — so this is a new, from-scratch, BigInt-based implementation
// (128-bit addresses don't fit in a JS number the way ip-utils.ts's IPv4
// helpers rely on `>>> 0` treating the whole address as one Int32).

const GROUP_MASK = 0xffffn;

// "::" shorthand expands to as many all-zero groups as needed to reach 8
// total. Handles leading/trailing "::" (e.g. "::1", "2001:db8::") and a
// bare, no-"::" fully-written address.
function expandGroups(addr: string): string[] {
  const trimmed = addr.trim();
  if (trimmed.includes(':::')) throw new Error(`Invalid IPv6 address: ${addr}`);

  if (trimmed.includes('::')) {
    const parts = trimmed.split('::');
    if (parts.length !== 2) throw new Error(`Invalid IPv6 address: ${addr}`);
    const head = parts[0] ? parts[0].split(':') : [];
    const tail = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 1) throw new Error(`Invalid IPv6 address: ${addr}`);
    return [...head, ...Array(missing).fill('0'), ...tail];
  }

  const groups = trimmed.split(':');
  if (groups.length !== 8) throw new Error(`Invalid IPv6 address: ${addr}`);
  return groups;
}

export function ipv6ToBigInt(addr: string): bigint {
  const groups = expandGroups(addr);
  let result = 0n;
  for (const g of groups) {
    if (g === '' || !/^[0-9a-fA-F]{1,4}$/.test(g)) throw new Error(`Invalid IPv6 address: ${addr}`);
    result = (result << 16n) | (BigInt(parseInt(g, 16)) & GROUP_MASK);
  }
  return result;
}

// Not maximally RFC 5952-canonical in every edge case (e.g. doesn't prefer
// compressing the earliest of two equal-length zero-runs), but always
// produces a correct, valid, reasonably-compact address — sufficient for
// writing into smf.yaml/upf.yaml and for operator display.
export function bigIntToIPv6(n: bigint): string {
  if (n < 0n || n > (1n << 128n) - 1n) throw new Error('IPv6 value out of range');
  const groups: number[] = [];
  for (let i = 7; i >= 0; i--) {
    groups.push(Number((n >> BigInt(i * 16)) & GROUP_MASK));
  }

  // Find the longest run of zero groups (length >= 2) to collapse into "::".
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else {
      curStart = -1; curLen = 0;
    }
  }

  const hex = groups.map((g) => g.toString(16));
  if (bestLen >= 2) {
    const before = hex.slice(0, bestStart);
    const after = hex.slice(bestStart + bestLen);
    return `${before.join(':')}::${after.join(':')}`;
  }
  return hex.join(':');
}

export interface IPv6Cidr {
  network: bigint;
  prefix: number;
}

export function parseIPv6Cidr(cidr: string): IPv6Cidr {
  const [addr, bitsStr] = cidr.split('/');
  if (!addr || bitsStr === undefined) throw new Error(`Invalid IPv6 CIDR: ${cidr}`);
  const prefix = Number(bitsStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) {
    throw new Error(`Invalid IPv6 prefix length: ${cidr}`);
  }
  const full = ipv6ToBigInt(addr);
  const mask = prefix === 0 ? 0n : (((1n << 128n) - 1n) << BigInt(128 - prefix)) & ((1n << 128n) - 1n);
  return { network: full & mask, prefix };
}

// The Nth child subnet of `childPrefix` bits within `parentCidr` (0-indexed) —
// e.g. offset 3 of "2001:db8:cafe::/48" at childPrefix 64 is the 4th /64:
// "2001:db8:cafe:3::/64". Throws if childPrefix is less specific than the
// parent's own prefix (a "smaller" subnet can't be broader than its parent),
// or if offset overflows the number of children that actually fit.
export function ipv6SubnetAtOffset(parentCidr: string, offset: number, childPrefix = 64): string {
  const { network, prefix } = parseIPv6Cidr(parentCidr);
  if (childPrefix < prefix) {
    throw new Error(`Child prefix /${childPrefix} cannot be less specific than parent prefix /${prefix}`);
  }
  const availableBits = childPrefix - prefix;
  const maxOffset = availableBits >= 128 ? Infinity : 2 ** availableBits;
  if (offset < 0 || offset >= maxOffset) {
    throw new Error(`Offset ${offset} out of range for parent /${prefix} carving /${childPrefix} children (max ${maxOffset})`);
  }
  const shift = BigInt(128 - childPrefix);
  const child = network + (BigInt(offset) << shift);
  return `${bigIntToIPv6(child)}/${childPrefix}`;
}

// How many `childPrefix`-sized subnets fit inside `parentCidr`.
export function ipv6ChildCount(parentCidr: string, childPrefix = 64): number {
  const { prefix } = parseIPv6Cidr(parentCidr);
  const availableBits = childPrefix - prefix;
  if (availableBits < 0) return 0;
  if (availableBits >= 32) return Infinity; // effectively unbounded for our purposes
  return 2 ** availableBits;
}

// The offset of `childCidr` within `parentCidr`, or null if it doesn't
// actually fall within the parent block (e.g. a legacy hand-entered subnet
// that predates the parent-pool setting, or one from an unrelated parent) —
// used to figure out which /64 slots are already taken without needing a
// separate persisted allocation table (see apn-profile-usecase.ts).
export function ipv6OffsetWithinParent(parentCidr: string, childCidr: string, childPrefix = 64): number | null {
  let parent: IPv6Cidr;
  let child: IPv6Cidr;
  try {
    parent = parseIPv6Cidr(parentCidr);
    child = parseIPv6Cidr(childCidr);
  } catch {
    return null;
  }
  if (child.prefix !== childPrefix) return null;
  const shift = BigInt(128 - childPrefix);
  const parentBase = parent.network >> shift;
  const childBase = child.network >> shift;
  const offset = childBase - parentBase;
  if (offset < 0n) return null;
  // Confirm the child's network truly reconstructs under the parent (i.e. it's
  // actually contained, not just numerically past it) and fits in a JS number.
  if (offset > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const reconstructed = parent.network + (offset << shift);
  if (reconstructed !== child.network) return null;
  const count = ipv6ChildCount(parentCidr, childPrefix);
  if (count !== Infinity && offset >= BigInt(count)) return null;
  return Number(offset);
}

// First usable address in a subnet (network address + 1) — the convention
// this codebase already uses for IPv4 gateways (cidrRange()'s `first + 1`).
export function ipv6FirstUsableAddress(subnetCidr: string): string {
  const { network } = parseIPv6Cidr(subnetCidr);
  return bigIntToIPv6(network + 1n);
}

export function isValidIPv6Cidr(cidr: string): boolean {
  try { parseIPv6Cidr(cidr); return true; } catch { return false; }
}
