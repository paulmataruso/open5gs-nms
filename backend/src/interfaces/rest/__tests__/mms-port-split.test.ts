import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { XMLValidator } from 'fast-xml-parser';
import { mmscYamlCfg, mmsMobileConfigPlist } from '../mms-controller';

/**
 * MMS here is a chain of three parts that have to agree on one port split,
 * and none of them reports a mismatch -- each just fails to deliver:
 *
 *   UE --(MMSCURL from the iOS profile)--> mm1-msisdn-proxy  :MM1_PORT (public)
 *      --(injects X-MSISDN from the UE's IP)--> VectorCore MM1 :MM1_INTERNAL_PORT
 *                                                             (loopback only)
 *
 * The proxy exists because real phones send MMS PDUs with no usable From
 * field, and VectorCore expects a GGSN/PGW-style X-MSISDN header to supply
 * the sender. So:
 *
 *   1. VectorCore's own MM1 listener must be on the INTERNAL loopback port.
 *      If the generated mmsc.yaml ever listens on the public port again, the
 *      proxy and VectorCore race for one socket and whichever loses logs the
 *      bind failure only in its own file -- and if VectorCore wins, real
 *      phones reach it directly, never get X-MSISDN, and every message is
 *      rejected for having no sender. That reads exactly like a radio fault.
 *   2. retrieve_base_url is what VectorCore puts in the M-Notification the
 *      phone later fetches from, so it must carry the PUBLIC port: the
 *      internal one is bound to 127.0.0.1 and no handset can reach it.
 *      Notifications would arrive and every download would time out.
 *   3. The profile's MMSCURL has to be that same public address.
 *   4. The profile is XML that iOS consumes. One unescaped & or < makes the
 *      whole plist invalid and iOS refuses it with no useful message.
 *   5. log.level is debug on purpose: VectorCore logs its entire MM1 request
 *      path at Debug, so the shipped 'info' left an actively-rejected
 *      request with zero trace (confirmed live 2026-07-30).
 */

const SRC = fs.readFileSync(path.resolve(__dirname, '../mms-controller.ts'), 'utf-8');

/**
 * The real port constants, read from source rather than copied here: a
 * deliberate port move updates this test by itself, while a COLLISION
 * between two of them still fails.
 */
function numConst(name: string): number {
  const m = new RegExp(`const ${name}\\s*=\\s*(\\d+);`).exec(SRC);
  if (!m) throw new Error(`constant ${name} not found in mms-controller.ts`);
  return Number(m[1]);
}
const MM1_PORT = numConst('MM1_PORT');
const MM1_INTERNAL_PORT = numConst('MM1_INTERNAL_PORT');

/** Only the parts of VectorCore's config this project generates and relies on. */
interface MmscCfg {
  database: { dsn: string };
  mm1: { listen: string; retrieve_base_url: string };
  mm3: { inbound_listen: string };
  mm4: { inbound_listen: string; hostname: string };
  mm7: { listen: string };
  api: { listen: string };
  store: { filesystem: { root: string } };
  log: { level: string; file: string };
}

const TEST_IP = '192.0.2.10'; // TEST-NET-1, documentation range
const TEST_MM4_HOST = `mmsc.${TEST_IP}`;

const parseCfg = (ip = TEST_IP, host = TEST_MM4_HOST): MmscCfg =>
  yaml.load(mmscYamlCfg(ip, host)) as MmscCfg;

function plistString(plist: string, key: string): string {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist);
  if (!m) throw new Error(`plist key ${key} not found`);
  return m[1];
}

/** `&amp;` LAST, or an escaped entity would be decoded twice. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

describe('mmscYamlCfg -- the port split the MSISDN proxy depends on', () => {
  it('produces YAML that parses to an object', () => {
    // A stray quote or colon from an interpolated value throws here rather
    // than at service start, where it is a bind failure in VectorCore's log.
    expect(typeof parseCfg()).toBe('object');
  });

  it('binds MM1 to loopback on the INTERNAL port, never the public one', () => {
    const { listen } = parseCfg().mm1;
    expect(listen).toBe(`127.0.0.1:${MM1_INTERNAL_PORT}`);
    expect(listen).not.toContain(`:${MM1_PORT}`);
  });

  it('keeps the public and internal MM1 ports distinct', () => {
    expect(MM1_PORT).not.toBe(MM1_INTERNAL_PORT);
  });

  it('builds retrieve_base_url from the supplied IP and the PUBLIC port', () => {
    const url = parseCfg().mm1.retrieve_base_url;
    expect(url).toBe(`http://${TEST_IP}:${MM1_PORT}/mms/retrieve`);
    // The internal port is loopback-only; a handset could never fetch from it.
    expect(url).not.toContain(`:${MM1_INTERNAL_PORT}`);
  });

  it('follows the supplied mm1PublicIp rather than a baked-in address', () => {
    const other = parseCfg('198.51.100.7', 'mmsc.198.51.100.7');
    expect(other.mm1.retrieve_base_url).toContain('198.51.100.7');
    expect(other.mm1.retrieve_base_url).not.toContain(TEST_IP);
  });

  it('passes the MM4 hostname through unchanged', () => {
    expect(parseCfg().mm4.hostname).toBe(TEST_MM4_HOST);
  });

  it('gives every MMSC listener its own port, and none of them the proxy\'s', () => {
    const cfg = parseCfg();
    const port = (s: string): number => Number(s.split(':').pop());
    const ports = [
      cfg.mm1.listen, cfg.mm3.inbound_listen, cfg.mm4.inbound_listen,
      cfg.mm7.listen, cfg.api.listen,
    ].map(port);
    // Two listeners on one port: the later one fails to bind, and says so
    // only in its own log file.
    expect(new Set(ports).size).toBe(ports.length);
    expect(ports).not.toContain(MM1_PORT);
  });

  it('logs at debug, because VectorCore logs its MM1 path at Debug', () => {
    expect(parseCfg().log.level).toBe('debug');
  });

  it('uses absolute paths for state, because the unit sets no WorkingDirectory', () => {
    const cfg = parseCfg();
    // A relative path would resolve against systemd's default cwd ("/") and
    // scatter the database, the message store and the log across the root.
    expect(cfg.database.dsn.startsWith('/')).toBe(true);
    expect(cfg.store.filesystem.root.startsWith('/')).toBe(true);
    expect(cfg.log.file.startsWith('/')).toBe(true);
  });
});

describe('mmsMobileConfigPlist -- XML iOS will accept', () => {
  const APN = 'internet';
  const URL_ = `http://${TEST_IP}:${MM1_PORT}/mms/retrieve`;

  it('is well-formed XML for ordinary values', () => {
    // XMLValidator returns true, or an object describing the first problem.
    expect(XMLValidator.validate(mmsMobileConfigPlist(APN, URL_))).toBe(true);
  });

  it('stays well-formed when the APN and URL carry XML metacharacters', () => {
    // One unescaped & or < invalidates the plist and iOS refuses the profile.
    const plist = mmsMobileConfigPlist('a&b<c>"d"\'e', 'http://192.0.2.10:8002/x?a=1&b=2<3');
    expect(XMLValidator.validate(plist)).toBe(true);
  });

  it('round-trips operator values exactly after unescaping', () => {
    // Escaping has to be lossless: iOS decodes it back to what was typed, and
    // a URL that comes back altered points the phone somewhere else.
    const apn = 'a&b<c>"d"\'e';
    const url = 'http://192.0.2.10:8002/x?a=1&b=2';
    const plist = mmsMobileConfigPlist(apn, url);
    expect(unescapeXml(plistString(plist, 'MMSCURL'))).toBe(url);
    expect(unescapeXml(plistString(plist, 'Name'))).toBe(apn);
  });

  it('never emits a bare & outside an entity', () => {
    const plist = mmsMobileConfigPlist('x&y', 'http://192.0.2.10/?a=1&b=2');
    expect(/&(?!(amp|lt|gt|quot|apos);)/.test(plist)).toBe(false);
  });

  it('uses the same APN name in AttachAPN and in the APNs entry', () => {
    const plist = mmsMobileConfigPlist('lab-apn', URL_);
    const names = [...plist.matchAll(/<key>Name<\/key>\s*<string>([^<]*)<\/string>/g)].map(m => m[1]);
    // AttachAPN selects the APN; the APNs entry carries the MMS settings. A
    // mismatch attaches those settings to an APN the phone is not using, and
    // the profile installs cleanly either way.
    expect(names).toEqual(['lab-apn', 'lab-apn']);
  });

  it('declares the cellular payload type iOS expects', () => {
    const plist = mmsMobileConfigPlist(APN, URL_);
    expect(plist).toContain('<string>com.apple.cellular</string>');
    expect(plist).toContain('<string>Configuration</string>');
  });

  it('keeps the two payload UUIDs distinct and well-formed', () => {
    const uuids = [...mmsMobileConfigPlist(APN, URL_)
      .matchAll(/<key>PayloadUUID<\/key>\s*<string>([^<]*)<\/string>/g)].map(m => m[1]);
    expect(uuids).toHaveLength(2);
    // Duplicate UUIDs make iOS treat the inner payload as the profile itself.
    expect(new Set(uuids).size).toBe(2);
    for (const u of uuids) {
      expect(u).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
    }
  });
});

describe('the config, the profile and the proxy agree on one public port', () => {
  it('the profile MMSC URL and the config retrieve URL are the same address', () => {
    const cfgUrl = parseCfg().mm1.retrieve_base_url;
    const plistUrl = unescapeXml(plistString(mmsMobileConfigPlist('internet', cfgUrl), 'MMSCURL'));
    expect(plistUrl).toBe(cfgUrl);
    expect(new URL(plistUrl).port).toBe(String(MM1_PORT));
  });

  it('the route default MMSC URL is built from the same public port', () => {
    // Source-level: GET /mobileconfig's default must use MM1_PORT. The
    // internal port would hand every operator a profile pointing at a
    // loopback socket, and the profile would install without complaint.
    expect(SRC).toMatch(
      /const mmscUrlDefault = state \? `http:\/\/\$\{state\.mm1PublicIp\}:\$\{MM1_PORT\}\/mms\/retrieve`/,
    );
  });

  it('the generated proxy listens publicly and forwards to the config\'s loopback port', () => {
    // mm1MsisdnProxyGo() is a Go source template, compiled during Configure,
    // so its wiring is only checkable at the source level. The forward target
    // must be exactly the port the YAML makes VectorCore listen on.
    expect(SRC).toMatch(/listenAddr\s*=\s*"0\.0\.0\.0:\$\{MM1_PORT\}"/);
    expect(SRC).toMatch(/upstreamAddr\s*=\s*"127\.0\.0\.1:\$\{MM1_INTERNAL_PORT\}"/);
    expect(parseCfg().mm1.listen).toBe(`127.0.0.1:${MM1_INTERNAL_PORT}`);
  });

  it('the proxy still injects the header it exists to inject', () => {
    // Without X-MSISDN, VectorCore has no sender and rejects every message.
    expect(SRC).toContain('r.Header.Set("X-MSISDN", msisdn)');
  });
});

describe('the proxy strips a forged MSISDN even when it has none to substitute', () => {
  // The whole point of the proxy is that VectorCore trusts X-MSISDN. A UE can
  // set that header itself, so the strip has to be UNCONDITIONAL while the
  // injection is conditional -- otherwise a UE whose source IP is not in the
  // map (an unknown or newly-attached subscriber) keeps its own forged value
  // and VectorCore believes it. Moving the Del loop inside the `if` is a
  // one-line edit that reads like tidying.
  const GO = ((): string => {
    const start = SRC.indexOf('var spoofableHeaders');
    expect(start).toBeGreaterThan(-1);
    const end = SRC.indexOf('upstreamReq.Header = r.Header', start);
    expect(end).toBeGreaterThan(start);
    return SRC.slice(start, end);
  })();

  it('names X-MSISDN itself among the headers it deletes', () => {
    const list = /var spoofableHeaders = \[\]string\{([^}]*)\}/.exec(GO)?.[1] ?? '';
    const names = [...list.matchAll(/"([^"]+)"/g)].map(m => m[1].toLowerCase());
    expect(names).toContain('x-msisdn');
    // Go canonicalises a header name on both Del and Set, so the casing here
    // is cosmetic -- the membership is not.
    expect(names).toContain('x-wap-network-client-msisdn');
    expect(names).toContain('x-nokia-msisdn');
  });

  it('deletes unconditionally, and only then sets when a MSISDN is known', () => {
    const del = GO.indexOf('r.Header.Del(h)');
    const guard = GO.indexOf('if msisdn != ""');
    const set = GO.indexOf('r.Header.Set("X-MSISDN", msisdn)');
    expect(del).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(del);
    expect(set).toBeGreaterThan(guard);
  });

  it('runs the delete loop outside any conditional', () => {
    // Textual, because the generator emits Go as a string: the `for` has to
    // come before the `if`, with no `if` between the lookup and the loop.
    const between = GO.slice(GO.indexOf('msisdn := cache.load()'), GO.indexOf('r.Header.Del(h)'));
    expect(between).toContain('for _, h := range spoofableHeaders');
    expect(between).not.toContain('if ');
  });
});
