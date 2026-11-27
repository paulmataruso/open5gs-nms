import { nsenter } from './dummy-interface';
import {
  parseIpAddrShow, defaultRouteDevice, ipv4AssignmentsOf,
  ifaceName, ifaceMac, ifaceState,
} from './ip-json';
import { cidrNetworkRange, numToIp } from '../../domain/services/ip-utils';

// Extracted from frr-controller.ts's own GET /interfaces handler (the
// working "which interface owns the default route" trick already proven
// live there for the DNS/FQDN Migration Wizard's management-interface
// auto-select) — pulled out here so the new IP Plan feature can reuse it
// instead of reimplementing a 4th copy of "list real host interfaces."
// frr-controller.ts's own handler now calls this too.

export interface HostNetworkInterface {
  name: string;
  mac: string | null;
  state: string | null;
  addresses: string[]; // "ip/prefixlen" strings, IPv4 only
  isMgmt: boolean;
}

export async function listHostInterfaces(): Promise<{ interfaces: HostNetworkInterface[]; mgmtInterface: string | null }> {
  const { stdout } = await nsenter('ip', ['-j', 'addr', 'show']);
  const { stdout: routeOut } = await nsenter('ip', ['-j', 'route', 'show', 'default']).catch(() => ({ stdout: '[]' }));
  const mgmtIface = defaultRouteDevice(routeOut);
  const interfaces = parseIpAddrShow(stdout)
    .map(entry => ({
      name: ifaceName(entry),
      mac: ifaceMac(entry),
      state: ifaceState(entry),
      addresses: ipv4AssignmentsOf(entry).map(a => `${a.ip}/${a.prefix}`),
      isMgmt: ifaceName(entry) === mgmtIface,
    }))
    .filter(i => !i.name.startsWith('lo') && !i.name.startsWith('docker') && !i.name.startsWith('br-'));
  return { interfaces, mgmtInterface: mgmtIface };
}

export interface MainInterface {
  name: string;
  ip: string;
  prefix: number;
  cidr: string; // network CIDR, e.g. "172.16.0.0/24"
}

// "The main interface" = whichever one owns the host's default IPv4 route
// (same definition frr-controller.ts already uses for its own mgmtInterface
// concept) — its first IPv4 address is what the IP Plan feature suggests
// addresses alongside.
export async function detectMainInterface(): Promise<MainInterface | null> {
  const { interfaces, mgmtInterface } = await listHostInterfaces();
  const main = interfaces.find(i => i.name === mgmtInterface) ?? interfaces.find(i => i.addresses.length > 0);
  if (!main || main.addresses.length === 0) return null;
  const [ip, prefixStr] = main.addresses[0].split('/');
  const prefix = Number(prefixStr);
  // ip-utils' validated math, NOT a private copy. This file used to carry its
  // own `networkCidr()` — a fifth hand-rolled implementation of CIDR masking,
  // and the only one with no validation at all: `ip.split('.').map(Number)`
  // yields `[NaN]` for a malformed address and JS coerces NaN to 0 through
  // ToInt32, so it returned 0.0.0.0/24 for "not-an-ip", 172.16.0.93/NaN for a
  // missing prefixlen, and — worst of the three — a plausible-looking
  // 10.0.2.0/24 for the truncated "10.0.2". That value is what the IP Plan
  // page displays and pre-fills its subnet box with, so a wrong-but-credible
  // network is the one output an operator cannot spot. ip-utils throws
  // instead, and documents the 2026-09-30 live incident where the same
  // silent-fallthrough wrote "not-a-cidr" straight into smf.yaml/upf.yaml.
  //
  // It cannot actually throw from here: ipv4AssignmentsOf() already rejected
  // anything that is not a dotted quad with an integer prefix in 0-32, so the
  // address is well-formed before the arithmetic sees it. Both halves are
  // deliberate — narrow at the boundary where the kernel's output arrives,
  // and keep the math refusing garbage so a future caller cannot reintroduce
  // the silent form.
  const cidr = `${numToIp(cidrNetworkRange(`${ip}/${prefix}`).first)}/${prefix}`;
  return { name: main.name, ip, prefix, cidr };
}
