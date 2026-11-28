import * as fs from 'fs';
import * as path from 'path';
import { linphonerc, TestIdentity } from '../volte-validation-controller';

/**
 * linphonerc() is one generator shared by three validation modules -- VoLTE,
 * VoWiFi and QCI -- and each caller passes its own local SIP port as a bare
 * literal at the call site. Six numbers in three files, currently spaced ten
 * apart and all distinct, with nothing enforcing either property.
 *
 * A collision does not announce itself. Two linphone instances asked for the
 * same local port leave the second unable to bind, which surfaces as "the
 * second client never registered" -- indistinguishable at a glance from an
 * IMS, P-CSCF or subscriber-provisioning fault, and in a module whose whole
 * job is to tell you whether IMS works. So the ports are read back out of the
 * real call sites here rather than restated, the same way the Osmocom SS7
 * test derives each daemon's MGCP port from its own generator.
 */

const SRC_DIR = path.resolve(__dirname, '..');
const read = (f: string): string => fs.readFileSync(path.join(SRC_DIR, f), 'utf-8');

/** Every `linphonerc(..., <port>, ...)` call site in a controller. */
export function linphonercPorts(src: string): number[] {
  return Array.from(
    src.matchAll(/\blinphonerc\(\s*[^;]*?,\s*(\d{4,5})\s*,/g),
    (m) => Number(m[1]),
  );
}

const CALLERS = {
  volte: 'volte-validation-controller.ts',
  vowifi: 'vowifi-validation-controller.ts',
  qci: 'qci-validation-controller.ts',
} as const;

const PORTS: Record<keyof typeof CALLERS, number[]> = {
  volte: linphonercPorts(read(CALLERS.volte)),
  vowifi: linphonercPorts(read(CALLERS.vowifi)),
  qci: linphonercPorts(read(CALLERS.qci)),
};

describe('linphone local SIP port allocation across the validation modules', () => {
  it('finds a call site in each of the three modules', () => {
    // Guards the regex itself: if it silently matched nothing, every
    // distinctness assertion below would pass vacuously.
    for (const [name, ports] of Object.entries(PORTS)) {
      expect({ name, count: ports.length }).toEqual({ name, count: 2 });
    }
  });

  it('gives every instance across every module its own port', () => {
    const all = Object.values(PORTS).flat();
    expect(all.length).toBe(6);
    expect(new Set(all).size).toBe(all.length);
  });

  it('keeps each module in its own block of ten', () => {
    // Not cosmetic: the spacing is what leaves room for a third instance in
    // any one module without reaching the next module's range.
    expect(PORTS).toEqual({ volte: [15060, 15061], vowifi: [15080, 15081], qci: [15070, 15071] });
    for (const ports of Object.values(PORTS)) {
      expect(Math.floor(ports[0] / 10)).toBe(Math.floor(ports[1] / 10));
    }
  });

  it('stays clear of the SIP default, which real services on this host hold', () => {
    for (const p of Object.values(PORTS).flat()) expect(p).not.toBe(5060);
  });
});

const IDENTITY: TestIdentity = {
  // Synthetic throughout -- the validation modules mint test subscribers under
  // their own MSIN prefix, so no real SIM secret belongs in this file.
  imsi: '001019000000001',
  msisdn: '15550009001',
  ki: '00112233445566778899aabbccddeeff',
  opc: 'ffeeddccbbaa99887766554433221100',
};
const DOMAIN = 'ims.mnc001.mcc001.3gppnetwork.org';
const PCSCF_IP = '127.0.1.1';
const PCSCF_PORT = 4060;

const cfg = linphonerc(IDENTITY, DOMAIN, 15060, PCSCF_IP, PCSCF_PORT);

/** Minimal INI reader -- linphonerc is flat key=value under [section]. */
export function iniSections(src: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let current = '';
  for (const line of src.split('\n')) {
    const section = /^\[([^\]]+)\]$/.exec(line.trim());
    if (section) { current = section[1]; out[current] = {}; continue; }
    const kv = /^([^=]+)=(.*)$/.exec(line.trim());
    if (kv && current) out[current][kv[1].trim()] = kv[2].trim();
  }
  return out;
}

describe('linphonerc', () => {
  const ini = iniSections(cfg);

  it('parses as the three sections linphone expects', () => {
    expect(Object.keys(ini).sort()).toEqual(['auth_info_0', 'proxy_0', 'sip']);
  });

  it('enables TCP only, with UDP and TLS explicitly disabled', () => {
    // -1 is linphone's "disabled". Leaving sip_port unset or 0 lets it pick an
    // arbitrary UDP port and register over UDP instead, which quietly stops
    // exercising the TCP path -- the one whose idle contacts go stale, and the
    // reason P-CSCF runs a NATPING timer at all.
    expect(ini.sip.sip_port).toBe('-1');
    expect(ini.sip.sip_tls_port).toBe('-1');
    expect(ini.sip.sip_tcp_port).toBe('15060');
  });

  it('carries the caller\'s port through to the config', () => {
    expect(iniSections(linphonerc(IDENTITY, DOMAIN, 15081, PCSCF_IP, PCSCF_PORT)).sip.sip_tcp_port).toBe('15081');
  });

  it('sends both the proxy and the route at P-CSCF over TCP', () => {
    // reg_route is what forces the request through P-CSCF rather than
    // resolving the domain; a proxy without it can bypass the node under test.
    for (const key of ['reg_proxy', 'reg_route']) {
      expect(ini.proxy_0[key]).toBe(`sip:${PCSCF_IP}:${PCSCF_PORT};transport=tcp`);
    }
  });

  it('registers by the IMSI identity, which is the form REGISTER uses', () => {
    // Dialling uses the MSISDN and registration the IMSI; a client registered
    // under the wrong one looks provisioned and is unreachable.
    expect(ini.proxy_0.reg_identity).toBe(`sip:${IDENTITY.imsi}@${DOMAIN}`);
    expect(ini.proxy_0.reg_identity).not.toContain(IDENTITY.msisdn);
    expect(ini.auth_info_0.username).toBe(IDENTITY.imsi);
    expect(ini.auth_info_0.userid).toBe(IDENTITY.imsi);
  });

  it('uses one realm for the proxy and the credentials', () => {
    // Digest auth matches on realm; two spellings fail with a 401 loop that
    // reads as a wrong password.
    expect(ini.proxy_0.realm).toBe(DOMAIN);
    expect(ini.auth_info_0.realm).toBe(DOMAIN);
  });

  it('points default_proxy at a section that exists', () => {
    expect(ini).toHaveProperty(`proxy_${ini.sip.default_proxy}`);
  });

  it('registers and does not publish', () => {
    expect(ini.proxy_0.reg_sendregister).toBe('1');
    expect(ini.proxy_0.publish).toBe('0');
    expect(Number(ini.proxy_0.reg_expires)).toBeGreaterThan(0);
  });

  it('follows the domain and P-CSCF it is given', () => {
    const other = iniSections(linphonerc(IDENTITY, 'ims.example.test', 15070, '10.1.2.3', 5070));
    expect(other.proxy_0.realm).toBe('ims.example.test');
    expect(other.proxy_0.reg_proxy).toBe('sip:10.1.2.3:5070;transport=tcp');
    expect(other.auth_info_0.realm).toBe('ims.example.test');
  });
});
