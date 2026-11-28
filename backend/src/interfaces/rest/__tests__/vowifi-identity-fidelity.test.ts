import * as fs from 'fs';
import * as path from 'path';
import {
  realmFromIdentity, epdgYamlConf, aaaConfigFile,
  upsertSmfAaaPeer, upsertHssAaaPeer,
} from '../vowifi-controller';

/**
 * VoWiFi writes FOUR files that have to agree about two Diameter identities.
 *
 * configureVowifi() derives ONE realm from SMF's own freeDiameter Identity and
 * builds every FQDN from it. Those FQDNs then land in four different places,
 * in three different syntaxes:
 *
 *   epdg.yaml      swm.origin_host: epdg.<realm>      (ePDG announces itself)
 *   aaa.config     {peers,[{epdg,[{host,"epdg.<realm>"}]}]}   (AAA expects it)
 *   aaa.config     {origin_host, "aaa.<realm>"}       (AAA announces itself)
 *   smf.conf       ConnectPeer = "aaa.<realm>"        (SMF expects it, S6b)
 *   hss.conf       ConnectPeer = "aaa.<realm>"        (HSS expects it, Swx)
 *
 * If any pair disagrees the peer never comes up, and it fails in the way this
 * project has already debugged twice: freeDiameter rejects the CEA outright on
 * an Origin-Host it was not told to expect, and OCS answered an unregistered
 * peer with 3010/DIAMETER_UNKNOWN_PEER. Both were a mismatch between what one
 * daemon announced and what another was configured to accept -- found live,
 * from the peer's own logs, not from reading the configs.
 *
 * Nothing tested any of it. These are the agreements, asserted as agreements:
 * the test derives the identity ONCE and requires every file to carry that same
 * value, so it fails whichever side drifts rather than pinning one file's text.
 *
 * The peer-slot mechanics themselves (stale stripping, commented examples,
 * exclusive prefixes) are already covered by diameter-peer-slots.test.ts and
 * are deliberately not retested here.
 */

/** This host's real SMF identity, as freeDiameter holds it. */
const SMF_IDENTITY = 'smf.epc.mnc001.mcc001.3gppnetwork.org';
const REALM = 'epc.mnc001.mcc001.3gppnetwork.org';

const AAA_IP = '10.0.1.181';
const EPDG_IP = '10.0.1.180';

const epdgYaml = (over: Partial<Parameters<typeof epdgYamlConf>[0]> = {}): string => epdgYamlConf({
  epdgIp: EPDG_IP, mcc: '001', mnc: '01', realm: REALM,
  aaaListenIp: AAA_IP, smfGtpcIp: '10.0.1.156', swmLocalIp: '127.0.0.20', ...over,
});

const aaaConf = (over: Partial<Parameters<typeof aaaConfigFile>[0]> = {}): string => aaaConfigFile({
  aaaListenIp: AAA_IP, realm: REALM, epdgFqdn: `epdg.${REALM}`,
  smfIdentity: SMF_IDENTITY, hssSwxIp: '127.0.0.8', ...over,
});

/** Pull a `key: value` out of the generated YAML. */
const yamlVal = (src: string, key: string): string | undefined =>
  new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'm').exec(src)?.[1];

describe('the realm is derived by dropping exactly one label', () => {
  it('turns SMF own identity into the realm every FQDN is built on', () => {
    expect(realmFromIdentity(SMF_IDENTITY)).toBe(REALM);
  });

  it('leaves the realm already starting with epc., so nothing may re-prepend it', () => {
    // A confirmed-live bug this code carries a comment about: the realm is
    // sliced straight off SMF's identity and ALREADY begins with "epc.", so
    // building `epc.${realm}` anywhere produces "epc.epc.mnc001...". Asserted
    // here so the shape of the realm is explicit, and below for every FQDN.
    const realm = realmFromIdentity(SMF_IDENTITY);
    expect(realm.startsWith('epc.')).toBe(true);
    expect(realm).not.toMatch(/epc\.epc\./);
  });

  it('is never re-prepended with epc. anywhere in this file', () => {
    // The realm ALREADY begins with "epc." -- it is sliced straight off SMF's
    // own freeDiameter Identity -- so composing `epc.${realm}` yields
    // "epc.epc.mnc001...", a real confirmed-live double-domain bug this file
    // carries a warning comment about.
    //
    // Asserted at the SOURCE level on purpose: the FQDNs are composed inside
    // configureVowifi(), which writes host config files and so cannot be
    // called from a unit test. A generated-output assertion cannot see this
    // at all -- verified by mutating `epdg.${realm}` to `epdg.epc.${realm}`,
    // which every output-level test in this file passed happily.
    const src = fs.readFileSync(path.join(__dirname, '..', 'vowifi-controller.ts'), 'utf-8');
    const offenders = src.split('\n')
      .map((line, i) => ({ line: i + 1, text: line.trim() }))
      .filter(({ text }) => !text.startsWith('//'))
      .filter(({ text }) => /`[^`]*\bepc\.\$\{(?:opts\.)?realm\}/.test(text));
    expect(offenders).toEqual([]);
  });

  it('falls back to localdomain for an identity with no domain part', () => {
    // readFreeDiameterIdentity() defaults to 'smf.localdomain', but a file
    // holding a bare hostname would otherwise yield an empty realm and build
    // FQDNs ending in a dot.
    expect(realmFromIdentity('smf')).toBe('localdomain');
  });
});

describe('ePDG and AAA agree on ePDG own identity', () => {
  it('what ePDG announces on SWm is exactly what AAA expects from it', () => {
    // epdg.yaml's swm.origin_host vs aaa.config's {epdg,[{host,...}]}. These
    // are produced by two different functions from two different arguments
    // (realm vs epdgFqdn), which is exactly how they can drift.
    const announced = yamlVal(epdgYaml(), 'origin_host');
    expect(announced).toBe(`epdg.${REALM}`);
    expect(aaaConf()).toContain(`{epdg, [{host, "${announced ?? ''}"}`);
  });

  it('both sides use the same realm, with no doubled epc.', () => {
    const yaml = epdgYaml();
    expect(yamlVal(yaml, 'origin_realm')).toBe(REALM);
    expect(yamlVal(yaml, 'destination_realm')).toBe(REALM);
    expect(aaaConf()).toContain(`{origin_realm, "${REALM}"}`);
    for (const out of [yaml, aaaConf()]) expect(out).not.toMatch(/epc\.epc\./);
  });

  it('ePDG dials the address and port AAA actually listens on', () => {
    // An identity match is not enough -- the transport has to agree too, and
    // both sides draw the port from the same constant.
    const yaml = epdgYaml();
    expect(yamlVal(yaml, 'peer_addr')).toBe(AAA_IP);
    expect(aaaConf()).toContain(`{listen_ip, "${AAA_IP}"}`);
    const port = yamlVal(yaml, 'peer_port');
    expect(port).toBeTruthy();
    expect(aaaConf()).toContain(`{listen_port, ${port ?? ''}}`);
    // Both are SCTP, not TCP.
    expect(yamlVal(yaml, 'proto')).toBe('sctp');
    expect(aaaConf()).toContain('{proto, sctp}');
  });
});

describe('AAA, SMF and HSS agree on AAA own identity', () => {
  const AAA_FQDN = `aaa.${REALM}`;
  const SMF_CONF = 'Identity = "smf.epc.mnc001.mcc001.3gppnetwork.org";\nConnectPeer = "pcrf.epc.mnc001.mcc001.3gppnetwork.org" { ConnectTo = "127.0.0.9"; No_TLS; };\n';
  const HSS_CONF = 'Identity = "hss.epc.mnc001.mcc001.3gppnetwork.org";\nConnectPeer = "mme.epc.mnc001.mcc001.3gppnetwork.org" { ConnectTo = "127.0.0.2"; No_TLS; };\n';

  it('the identity AAA announces is the one SMF is told to connect to', () => {
    // aaa.config's origin_host vs smf.conf's S6b ConnectPeer. A mismatch here
    // is the exact shape of the recorded failure: the CEA is rejected and S6b
    // never opens, so a VoWiFi session can never be authorised.
    expect(aaaConf()).toContain(`{origin_host, "${AAA_FQDN}"}`);
    expect(upsertSmfAaaPeer(SMF_CONF, AAA_FQDN, AAA_IP)).toContain(`ConnectPeer = "${AAA_FQDN}"`);
  });

  it('and the one HSS is told to connect to, for Swx', () => {
    expect(upsertHssAaaPeer(HSS_CONF, AAA_FQDN, AAA_IP)).toContain(`ConnectPeer = "${AAA_FQDN}"`);
  });

  it('all three carry the identical string, derived once', () => {
    // The property that actually matters: one derivation, three files. Built
    // from SMF's own identity here rather than from the constant, so this
    // fails if the derivation changes and only some call sites follow.
    const realm = realmFromIdentity(SMF_IDENTITY);
    const fqdn = `aaa.${realm}`;
    const inAaa = /\{origin_host, "([^"]+)"\}/.exec(aaaConf({ realm }))?.[1];
    const inSmf = /ConnectPeer = "(aaa\.[^"]+)"/.exec(upsertSmfAaaPeer(SMF_CONF, fqdn, AAA_IP))?.[1];
    const inHss = /ConnectPeer = "(aaa\.[^"]+)"/.exec(upsertHssAaaPeer(HSS_CONF, fqdn, AAA_IP))?.[1];
    expect([inAaa, inSmf, inHss]).toEqual([fqdn, fqdn, fqdn]);
  });

  it('AAA knows SMF by SMF own real identity, not a guessed one', () => {
    // The S6b peer is keyed on what SMF actually announces, read live from
    // smf.conf -- never reconstructed from the PLMN, which would silently
    // differ on any deployment whose Identity was hand-edited.
    expect(aaaConf()).toContain(`{smf, [{host, "${SMF_IDENTITY}"}`);
  });
});

describe('the PLMN reaches epdg.yaml without losing its leading zeros', () => {
  it('quotes mcc and mnc, so YAML cannot read 001 as the number 1', () => {
    // Unquoted, `mnc: 01` parses as 1 and `mcc: 001` as 1 -- a different
    // network. Same class as the repeated-map MNC bug in mme.yaml and the
    // three test-IMSI builders that put subscribers in PLMN 001-001.
    const yaml = epdgYaml();
    expect(yaml).toContain('mcc: "001"');
    expect(yaml).toContain('mnc: "01"');
  });

  it('derives mnc_length from the REAL width, which is what parses an IMSI', () => {
    // ePDG splits the IMSI into MCC/MNC/MSIN using this length. A 2-digit
    // network declared as 3 consumes the first MSIN digit, so every
    // subscriber resolves to a different, non-existent identity.
    expect(yamlVal(epdgYaml({ mnc: '01' }), 'mnc_length')).toBe('2');
    expect(yamlVal(epdgYaml({ mnc: '001' }), 'mnc_length')).toBe('3');
    expect(yamlVal(epdgYaml({ mnc: '070' }), 'mnc_length')).toBe('3');
  });

  it('names the ePDG after the realm', () => {
    expect(yamlVal(epdgYaml(), 'name')).toBe(`epdg.${REALM}`);
    expect(yamlVal(epdgYaml(), 'realm')).toBe(REALM);
  });
});

describe('two deliberate, documented choices in epdg.yaml', () => {
  it('binds the vendor admin API to loopback only', () => {
    // The vendor's own docs state this API has no authentication of its own,
    // so it must not be reachable off-host; the NMS proxies it behind an
    // authenticated route. Widening this exposes an unauthenticated control
    // surface, which is why it is asserted rather than left to review.
    expect(yamlVal(epdgYaml(), 'listen_address')).toBe('127.0.0.1');
  });

  it('keeps S-NAPTR PGW discovery off, because Open5GS publishes no such records', () => {
    const yaml = epdgYaml();
    expect(yamlVal(yaml, 'dns_enabled')).toBe('false');
    expect(yamlVal(yaml, 'allow_s5s8_fallback')).toBe('false');
    // GTP-C goes straight to SMF's real address instead.
    expect(yamlVal(yaml, 'pgw_gtpc')).toBe('10.0.1.156');
  });
});

describe('aaa.config declares the three applications it brokers', () => {
  it('lists swm, s6b and swx, each on the right peer', () => {
    // ePDG speaks SWm, SMF speaks S6b, HSS speaks Swx. Wiring an app to the
    // wrong peer makes the CER negotiate an application that peer does not
    // support, which freeDiameter refuses.
    const out = aaaConf();
    expect(out).toContain('{apps, [swm, s6b, swx]}');
    expect(out).toContain('{epdg, [{host, "epdg.' + REALM + '"}, {apps, [swm]}]}');
    expect(out).toContain('{smf, [{host, "' + SMF_IDENTITY + '"}, {apps, [s6b]}]}');
    expect(out).toMatch(/\{hss, \[\{host, "hss\.epc[^"]*"\}.*\{apps, \[swx\]\}\]\}/);
  });

  it('derives the EAP-AKA-prime network name from the same realm', () => {
    // Not a Diameter identity, but built on the same realm and load-bearing in
    // a different way: the network name is an input to EAP-AKA-prime's own key
    // derivation (AT_KDF_INPUT), so a value the UE does not agree with fails
    // authentication outright rather than degrading. Prefixed `wlan.`, and
    // like every other FQDN here it must not double the epc. label.
    const out = aaaConf();
    expect(out).toContain(`{eap_aka_prime_network_name, "wlan.${REALM}"}`);
    expect(out).not.toMatch(/epc\.epc\./);
  });

  it('builds all five FQDNs on one realm, so one change moves them together', () => {
    // aaa., epdg., hss., wlan. and SMF's own identity. The point is that a
    // realm change cannot leave a subset behind: each is asserted against the
    // SAME derived realm rather than a literal.
    const realm = realmFromIdentity(SMF_IDENTITY);
    const out = aaaConf({ realm, epdgFqdn: `epdg.${realm}` });
    for (const fqdn of [`aaa.${realm}`, `epdg.${realm}`, `hss.${realm}`, `wlan.${realm}`]) {
      expect(out).toContain(`"${fqdn}"`);
    }
    expect(out).toContain(`"${SMF_IDENTITY}"`);
  });

  it('is the side that DIALS the HSS, and is dialled by the other two', () => {
    // Only the hss peer carries {connect, true}: AAA initiates Swx to HSS,
    // while ePDG and SMF initiate to AAA. Both sides of a pair trying to
    // connect at once is a real, confirmed connect/disconnect flap on this
    // deployment -- the same reason P-CSCF and PCRF were separated.
    const hss = /\{hss, \[[^\]]*\]\}/.exec(aaaConf())?.[0] ?? '';
    expect(hss).toContain('{connect, true}');
    expect(hss).toContain('{ip, "127.0.0.8"}');
    const epdgPeer = /\{epdg, \[[^\]]*\]\}/.exec(aaaConf())?.[0] ?? '';
    expect(epdgPeer).not.toContain('connect');
  });
});
