import * as fs from 'fs';
import * as path from 'path';
import { osmostpCfg, osmohlrCfg, osmomscCfg } from '../sms-controller';
import { osmobscCfg } from '../gsm-controller';
import { osmoHnbgwCfgForTest, HNBGW_STATE_DEFAULTS_FOR_TEST } from '../hnbgw-controller';
import { upsertVtyDirectives } from '../../../domain/services/vty-config-ownership';
import type { OwnedDirective } from '../../../domain/services/vty-config-ownership';

/**
 * Four Osmocom daemons share one SS7 address space and one MGCP port range
 * across three controllers, and every collision in that space has already
 * happened here at least once. They share a failure signature too: both sides
 * come up, both report a healthy link, and traffic disappears.
 *
 *   point codes   osmo-stp 0.24.1 | osmo-msc 0.23.1 | osmo-hnbgw 0.23.5
 *                 osmo-sgsn IuPS 0.23.4
 *   MGCP client   osmo-msc 2727   | osmo-bsc 2728   | osmo-hnbgw 2729
 *
 * The STP was originally given 0.23.1, copied from the point-code Osmocom's
 * own documentation uses for "the MSC" -- which is exactly where this
 * deployment's real osmo-msc already sat. An STP that shares the MSC's
 * address cannot route BSSAP *to* the MSC, because every such message is
 * addressed to itself. No BSSMAP RESET ever completed between osmo-bsc and
 * osmo-msc while both ends showed AS_ACTIVE, and moving only the STP to
 * 0.24.1 produced a real RESET ACK immediately.
 *
 * The MGCP side is pinned by hnbgw-mgcp-port.test.ts, which this deliberately
 * does not repeat -- except for one gap: that test compares HNBGW's port
 * against the literals 2727 and 2728, so changing osmo-bsc's real port to
 * 2729 would leave it green while the collision was live. Here the peers'
 * ports are read out of their own generators.
 *
 * osmo-bsc has no generated point code: its `cs7 instance 0` is
 * hand-maintained on the host and deliberately excluded from what the 2G
 * module owns, so there is nothing to assert about it here.
 */

const SMS_SRC = fs.readFileSync(path.resolve(__dirname, '../sms-controller.ts'), 'utf-8');

const STP = osmostpCfg();
const HNBGW = osmoHnbgwCfgForTest(HNBGW_STATE_DEFAULTS_FOR_TEST());

/** Every `point-code X.Y.Z` in a generated config, in order. */
const pointCodes = (cfg: string): string[] =>
  [...cfg.matchAll(/^\s*point-code\s+(\S+)\s*$/gm)].map(m => m[1]);

const mgcpLocalPort = (cfg: string): number =>
  Number(/^\s*mgw local-port\s+(\d+)\s*$/m.exec(cfg)?.[1]);

describe('the SS7 point-code allocation', () => {
  it('gives osmo-stp its own address, not the one the MSC already uses', () => {
    // 0.23.1 is the documentation's "MSC" point code and this host's real
    // one. An STP sharing it swallows every BSSAP message silently.
    expect(pointCodes(STP)).toEqual(['0.24.1']);
    const { mscPointCode } = HNBGW_STATE_DEFAULTS_FOR_TEST();
    expect(mscPointCode).toBe('0.23.1');
    expect(pointCodes(STP)).not.toContain(mscPointCode);
  });

  it('keeps all four generated point codes distinct', () => {
    const s = HNBGW_STATE_DEFAULTS_FOR_TEST();
    const all = [
      ...pointCodes(STP),
      s.hnbgwPointCode, s.mscPointCode, s.sgsnIuPsPointCode,
    ];
    expect(all).toHaveLength(4);
    // Any pair colliding is a routing fault that presents as healthy links.
    expect(new Set(all).size).toBe(all.length);
  });

  it('declares every point code HNBGW routes through, and its own', () => {
    const s = HNBGW_STATE_DEFAULTS_FOR_TEST();
    // Own first, then the two sccp-address peers, in that order: HNBGW's own
    // instance point code has to be the cs7 instance's, not a peer's.
    expect(pointCodes(HNBGW)).toEqual([s.hnbgwPointCode, s.mscPointCode, s.sgsnIuPsPointCode]);
  });

  it('puts the IuPS peer on its own address, separate from the MSC', () => {
    const s = HNBGW_STATE_DEFAULTS_FOR_TEST();
    // IuCS and IuPS are two SCCP destinations; one address for both would
    // route every IuPS message at the MSC.
    expect(s.sgsnIuPsPointCode).not.toBe(s.mscPointCode);
    expect(HNBGW).toMatch(/sccp-address msc\n\s+routing-indicator PC\n\s+point-code /);
    expect(HNBGW).toMatch(/sccp-address sgsn\n\s+routing-indicator PC\n\s+point-code /);
  });
});

describe('osmo-stp accepts a dynamically-registering ASP', () => {
  it('permits dynamic routing-key allocation, not just dynamic connections', () => {
    // Two separate policies, and the names look interchangeable. Without the
    // RKM line, an ASP with no pre-defined routing key -- osmo-bsc's
    // A-interface, which auto-generates routing context 1 -- is rejected with
    // "RCTX 1 not found in configuration, and dynamic RKM allocation not
    // permitted", retried forever, while the connection itself succeeds.
    expect(STP).toMatch(/^\s*xua rkm routing-key-allocation dynamic-permitted\s*$/m);
    expect(STP).toMatch(/^\s*accept-asp-connections dynamic-permitted\s*$/m);
  });

  it('listens for both M3UA and SUA, each accepting dynamic ASPs', () => {
    const m3ua = STP.indexOf('listen m3ua 2905');
    const sua = STP.indexOf('listen sua 14001');
    expect(m3ua).toBeGreaterThan(-1);
    expect(sua).toBeGreaterThan(-1);
    // Each listener carries its own accept line, nested under it.
    expect(STP.match(/^\s*accept-asp-connections dynamic-permitted\s*$/gm)).toHaveLength(2);
  });

  it('is written once and never regenerated, because nothing in it is dynamic', () => {
    // It takes no parameters, so a rewrite can only ever discard whatever an
    // operator added by hand. The guard is the write site, not the template.
    expect(SMS_SRC).toMatch(/if \(!fs\.existsSync\(stpPath\)\) fs\.writeFileSync\(stpPath, osmostpCfg\(\)/);
  });

  it('takes no arguments, so it cannot carry deployment state', () => {
    expect(osmostpCfg.length).toBe(0);
    expect(osmostpCfg()).toBe(STP);
  });
});

describe('the MGCP client ports, read from each daemon\'s own generator', () => {
  const msc = mgcpLocalPort(osmomscCfg('001', '01', '127.0.0.1', '127.0.0.1', '127.0.0.1'));
  const bsc = mgcpLocalPort(osmobscCfg('001', '01', [], '127.0.0.1'));
  const hnbgw = mgcpLocalPort(HNBGW);

  it('are the three distinct ports this host allocates', () => {
    expect({ msc, bsc, hnbgw }).toEqual({ msc: 2727, bsc: 2728, hnbgw: 2729 });
  });

  it('collide with nothing, derived rather than assumed', () => {
    // The point of deriving: moving osmo-bsc to 2729 is a live collision that
    // a test comparing HNBGW against the literal 2728 would never see.
    const ports = [msc, bsc, hnbgw];
    expect(new Set(ports).size).toBe(ports.length);
    // A collision is invisible to `ss -lnup`: the MGCP client CONNECTs its
    // UDP socket, so it reads as ESTAB and a listening-only scan omits it.
    for (const p of ports) expect(Number.isInteger(p)).toBe(true);
  });

  it('osmo-msc gets the same port whether written fresh or merged in', () => {
    // sms-controller.ts names `mgw local-port 2727` twice -- once in
    // osmomscCfg()'s fresh-install template and once in configureSms()'s
    // owned-directive list, which is what rewrites the line on a real host
    // whose osmo-msc.cfg already exists. If those two drift, a fresh install
    // and a reconfigure produce different ports.
    const owned = /\{ node: 'msc', prefix: \/\^\\s\*mgw local-port\\s\+\/, line: mgwBindIp \? ' mgw local-port (\d+)' : null \}/
      .exec(SMS_SRC);
    expect(owned).not.toBeNull();
    expect(Number(owned![1])).toBe(msc);
  });
});

describe('osmo-hlr.cfg keeps its GSUP bind inside the gsup block', () => {
  const HLR_IP = '127.0.0.9';
  const fresh = osmohlrCfg(HLR_IP);

  it('nests bind ip under gsup, where osmo-hlr 1.5.0 requires it', () => {
    // `bind ip` at hlr level is rejected outright; the port is fixed at 4222
    // and is not configurable, so this one line is the whole GSUP binding.
    expect(fresh).toMatch(new RegExp(`^hlr\\n(?: .*\\n)* gsup\\n  bind ip ${HLR_IP.replace(/\./g, '\\.')}\\n`, 'm'));
  });

  it('carries the ctrl and vty binds, and the ussd routes the stock file has', () => {
    // This template used to have no callers at all, so it was free to be a
    // sketch. It is now the fresh-install fallback, and both the ctrl bind
    // and the ussd routes were missing from it while present on the real host.
    expect(fresh).toContain(` bind ${HLR_IP}`);
    expect(fresh).toMatch(/^ ussd route prefix \*#100# internal own-msisdn$/m);
    expect(fresh).toMatch(/^ ussd route prefix \*#101# internal own-imsi$/m);
    expect(fresh).toMatch(/^ database \/var\/lib\/osmocom\/hlr\.db$/m);
  });

  it('replaces bind ip IN PLACE when a gsup block is already there', () => {
    // upsertVtyDirectives is one level deep: it keeps hlr's body as raw
    // lines, so a nested directive is matched and replaced where it sits.
    const owned: OwnedDirective[] = [
      { node: 'hlr', prefix: /^\s*bind ip\s+/, line: '  bind ip 10.0.0.1' },
    ];
    const out = upsertVtyDirectives(fresh, owned, fresh);
    expect(out).toContain(' gsup\n  bind ip 10.0.0.1\n');
    expect(out).not.toContain(HLR_IP + '\n  ussd');
    // Everything it does not own survives, including the ussd routes.
    expect(out).toMatch(/^ ussd route prefix \*#100# internal own-msisdn$/m);
  });

  it('would APPEND bind ip outside gsup if no gsup block existed -- which is why the caller gates it', () => {
    // The reason configureSms() only merges this directive when a gsup block
    // is present (or the file is empty). Appending lands it at the end of
    // hlr's body, outside gsup, where osmo-hlr rejects the file and refuses
    // to start -- so the caller leaves it alone and warns instead.
    const noGsup = 'hlr\n database /var/lib/osmocom/hlr.db\n ussd route prefix *#100# internal own-msisdn\nline vty\n no login\n';
    const owned: OwnedDirective[] = [
      { node: 'hlr', prefix: /^\s*bind ip\s+/, line: '  bind ip 10.0.0.1' },
    ];
    const out = upsertVtyDirectives(noGsup, owned, noGsup);
    expect(out).toContain('bind ip 10.0.0.1');
    expect(out).not.toContain('gsup');
    // Confirms the hazard is real: the line is now a direct child of hlr.
    expect(out).toMatch(/^hlr\n(?: .*\n)* {2}bind ip 10\.0\.0\.1\n/m);
  });

  it('and the caller does gate it on a real gsup block', () => {
    // Source-level, because the gate lives inside configureSms(), which
    // writes host files and cannot be called from a unit test.
    expect(SMS_SRC).toMatch(/const hlrHasGsup = \/\^\\s\*gsup\\s\*\$\/m\.test\(currentHlr\);/);
    expect(SMS_SRC).toMatch(/\.\.\.\(hlrHasGsup \|\| !currentHlr\.trim\(\)\n\s*\? \[\{ node: 'hlr', prefix: \/\^\\s\*bind ip\\s\+\/,/);
  });
});
