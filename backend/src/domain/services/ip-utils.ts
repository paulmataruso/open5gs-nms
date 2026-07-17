// Shared IPv4 CIDR/address math — used for UE IP pool scanning (validation-controller,
// swu-emulator-controller) and framed-route overlap checking (subscriber-management).

export function ipToNum(ip: string): number {
  const p = ip.split('.').map(Number);
  return (((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0);
}

export function numToIp(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

// Host-assignable range for a CIDR (excludes network + broadcast addresses).
export function cidrRange(cidr: string): { first: number; last: number } {
  const [addr, bits] = cidr.split('/');
  const prefix = Number(bits ?? 32);
  const mask   = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const net    = (ipToNum(addr) & mask) >>> 0;
  const bcast  = (net | (~mask >>> 0)) >>> 0;
  return { first: net + 1, last: bcast - 1 };
}

// Full network range for a CIDR (includes network + broadcast) — the right range to use
// for overlap comparisons, unlike cidrRange() above which is host-assignment-specific.
export function cidrNetworkRange(cidr: string): { first: number; last: number } {
  const [addr, bits] = cidr.split('/');
  const prefix = Number(bits ?? 32);
  const mask   = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const net    = (ipToNum(addr) & mask) >>> 0;
  const bcast  = (net | (~mask >>> 0)) >>> 0;
  return { first: net, last: bcast };
}

export function ipv4CidrOverlaps(a: string, b: string): boolean {
  const ra = cidrNetworkRange(a);
  const rb = cidrNetworkRange(b);
  return ra.first <= rb.last && rb.first <= ra.last;
}
