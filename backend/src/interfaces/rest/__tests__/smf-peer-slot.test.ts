import { upsertSmfAaaPeer, removeSmfAaaPeer } from '../vowifi-controller';
import { upsertSmfGyPeer, removeSmfGyPeer } from '../ocs-controller';

/**
 * The exclusive ConnectPeer naming slots inside the one shared smf.conf.
 *
 * WHY THIS IS THE COUPLING WORTH TESTING. /etc/freeDiameter/smf.conf has
 * THREE independently-owned ConnectPeer lines and two separate modules that
 * write it:
 *
 *   Gx   pcrf.epc...   Open5GS core -- owned by NOBODY here, never written
 *   S6b  aaa.epc...    VoWiFi,  via upsertSmfAaaPeer / removeSmfAaaPeer
 *   Gy   ocs.epc...    SigScale OCS, via upsertSmfGyPeer / removeSmfGyPeer
 *
 * Each upsert strips every line matching only ITS OWN identity prefix and
 * appends one clean replacement. If either regex ever widened to the whole
 * ConnectPeer family, configuring one module would delete the other's
 * Diameter peer -- and the consequences are known rather than theoretical:
 * losing the Gy line while OCS is live tore down every 4G PDU session about
 * 100ms after attach, and freeDiameter reacts to a DUPLICATE ConnectPeer with
 * ELECTION_LOST loops or a hard SMF crash-loop. Dropping the Gx line takes
 * policy control out for every session on the deployment.
 *
 * All four functions are pure string transforms and none had a test.
 *
 * The fixture mirrors this host's real smf.conf structure, confirmed
 * 2026-11-28: three active peers at the end, preceded by four of
 * freeDiameter's own COMMENTED documentation examples -- one of which,
 * `#ConnectPeer = "aaa.wide.ad.jp";`, matches VoWiFi's own `aaa.` prefix. The
 * live values are not reproduced; the file carries real peer addresses.
 */

/** Structure of the real file, with placeholder addresses. */
const SMF_CONF = `# Diameter configuration for SMF
Identity = "smf.epc.mnc001.mcc001.3gppnetwork.org";
Realm = "epc.mnc001.mcc001.3gppnetwork.org";
Port = 3868;
No_SCTP;

#  This is achieved with the ConnectPeer directive described below.
#ConnectPeer = "diameterid" [ { parameter1; parameter2; ...} ] ;
#ConnectPeer = "aaa.wide.ad.jp";
#ConnectPeer = "old.diameter.serv" { TcTimer = 60; TLS_old_method; No_SCTP; Port=3868; } ;
ConnectPeer = "pcrf.epc.mnc001.mcc001.3gppnetwork.org" { No_TLS; };
ConnectPeer = "aaa.epc.mnc001.mcc001.3gppnetwork.org" { ConnectTo = "127.0.1.20"; No_TLS; };
ConnectPeer = "ocs.epc.mnc001.mcc001.3gppnetwork.org" { ConnectTo = "127.0.1.10"; Port = 3868; No_TLS; };
`;

const GX = 'ConnectPeer = "pcrf.epc.mnc001.mcc001.3gppnetwork.org" { No_TLS; };';
const AAA = 'aaa.epc.mnc001.mcc001.3gppnetwork.org';
const OCS = 'ocs.epc.mnc001.mcc001.3gppnetwork.org';

/** Active (non-comment) ConnectPeer identities, in file order. */
function peers(raw: string): string[] {
  return raw.split('\n')
    .filter((l) => /^[ \t]*ConnectPeer/.test(l))
    .map((l) => /"([^"]*)"/.exec(l)?.[1] ?? '');
}

describe('each module writes only its own slot', () => {
  it('VoWiFi leaves the Gx and Gy peers untouched', () => {
    const out = upsertSmfAaaPeer(SMF_CONF, AAA, '127.0.1.21');
    expect(peers(out)).toEqual([GX.replace(/.*"(.*?)".*/, '$1'), OCS, AAA]);
    expect(out).toContain(GX);
    expect(out).toContain(`ConnectPeer = "${OCS}" { ConnectTo = "127.0.1.10"; Port = 3868; No_TLS; };`);
    expect(out).toContain(`ConnectPeer = "${AAA}" { ConnectTo = "127.0.1.21"; No_TLS; };`);
  });

  it('OCS leaves the Gx and S6b peers untouched', () => {
    const out = upsertSmfGyPeer(SMF_CONF, OCS, '127.0.1.11', 3868);
    expect(out).toContain(GX);
    expect(out).toContain(`ConnectPeer = "${AAA}" { ConnectTo = "127.0.1.20"; No_TLS; };`);
    expect(out).toContain(`ConnectPeer = "${OCS}" { ConnectTo = "127.0.1.11"; Port = 3868; No_TLS; };`);
  });

  it('the Gx line survives both modules writing, in either order', () => {
    // Gx belongs to Open5GS itself and no module here owns it. Losing it takes
    // policy control out for every session on the deployment, so it is
    // asserted against both orderings rather than one.
    const a = upsertSmfGyPeer(upsertSmfAaaPeer(SMF_CONF, AAA, '127.0.1.21'), OCS, '127.0.1.11', 3868);
    const b = upsertSmfAaaPeer(upsertSmfGyPeer(SMF_CONF, OCS, '127.0.1.11', 3868), AAA, '127.0.1.21');
    for (const out of [a, b]) {
      expect(out).toContain(GX);
      expect(peers(out).filter((p) => p.startsWith('pcrf.'))).toHaveLength(1);
    }
  });

  it('both orderings converge on the same set of peers', () => {
    // Order independence is the property that makes two modules safe to
    // configure in any sequence. The FILE differs between the two orderings
    // (each upsert appends its own line last), so the claim is about the set.
    const a = upsertSmfGyPeer(upsertSmfAaaPeer(SMF_CONF, AAA, '127.0.1.21'), OCS, '127.0.1.11', 3868);
    const b = upsertSmfAaaPeer(upsertSmfGyPeer(SMF_CONF, OCS, '127.0.1.11', 3868), AAA, '127.0.1.21');
    expect(new Set(peers(a))).toEqual(new Set(peers(b)));
    expect(peers(a)).toHaveLength(3);
  });
});

describe("freeDiameter's own commented examples are not collateral damage", () => {
  it("VoWiFi does not delete the commented aaa.wide.ad.jp example", () => {
    // The live file really does carry this line, and it matches the `aaa.`
    // prefix. What saves it is the `^[ \t]*` anchor: a `#` is neither a space
    // nor a tab, so a commented line cannot match. Drop that anchor and this
    // module starts eating freeDiameter's shipped documentation.
    const out = upsertSmfAaaPeer(SMF_CONF, AAA, '127.0.1.21');
    expect(out).toContain('#ConnectPeer = "aaa.wide.ad.jp";');
  });

  it('neither module disturbs any commented line', () => {
    const out = upsertSmfGyPeer(upsertSmfAaaPeer(SMF_CONF, AAA, '127.0.1.21'), OCS, '127.0.1.11', 3868);
    for (const line of [
      '#  This is achieved with the ConnectPeer directive described below.',
      '#ConnectPeer = "diameterid" [ { parameter1; parameter2; ...} ] ;',
      '#ConnectPeer = "aaa.wide.ad.jp";',
      '#ConnectPeer = "old.diameter.serv" { TcTimer = 60; TLS_old_method; No_SCTP; Port=3868; } ;',
    ]) {
      expect(out).toContain(line);
    }
  });

  it('leaves the identity, realm and transport settings alone', () => {
    const out = upsertSmfAaaPeer(SMF_CONF, AAA, '127.0.1.21');
    expect(out).toContain('Identity = "smf.epc.mnc001.mcc001.3gppnetwork.org";');
    expect(out).toContain('Realm = "epc.mnc001.mcc001.3gppnetwork.org";');
    expect(out).toContain('No_SCTP;');
  });
});

describe('a realm change leaves exactly one line, never a duplicate', () => {
  it('replaces a peer from the old PLMN rather than adding beside it', () => {
    // The reason each upsert strips by PREFIX and not by exact identity. After
    // a PLMN migration the stored identity changes, and a duplicate
    // ConnectPeer is what freeDiameter answers with ELECTION_LOST loops or a
    // hard SMF crash-loop.
    const old = 'aaa.epc.mnc070.mcc999.3gppnetwork.org';
    const before = SMF_CONF.replace(AAA, old);
    const out = upsertSmfAaaPeer(before, AAA, '127.0.1.21');
    expect(peers(out).filter((p) => p.startsWith('aaa.'))).toEqual([AAA]);
    expect(out).not.toContain(old);
  });

  it('does the same for the Gy slot', () => {
    const old = 'ocs.epc.mnc070.mcc999.3gppnetwork.org';
    const before = SMF_CONF.replace(OCS, old);
    const out = upsertSmfGyPeer(before, OCS, '127.0.1.11', 3868);
    expect(peers(out).filter((p) => p.startsWith('ocs.'))).toEqual([OCS]);
    expect(out).not.toContain(old);
  });

  it('collapses several stale lines in one slot down to one', () => {
    // A slot can hold more than one leftover after repeated realm or backend
    // changes, so the strip is global within the slot rather than first-match.
    const messy = SMF_CONF.trimEnd()
      + '\nConnectPeer = "aaa.old1.example" { No_TLS; };'
      + '\nConnectPeer = "aaa.old2.example" { No_TLS; };\n';
    const out = upsertSmfAaaPeer(messy, AAA, '127.0.1.21');
    expect(peers(out).filter((p) => p.startsWith('aaa.'))).toEqual([AAA]);
  });

  it('is idempotent: upserting twice is the same as once', () => {
    const once = upsertSmfAaaPeer(SMF_CONF, AAA, '127.0.1.21');
    expect(upsertSmfAaaPeer(once, AAA, '127.0.1.21')).toBe(once);
    const gy = upsertSmfGyPeer(SMF_CONF, OCS, '127.0.1.11', 3868);
    expect(upsertSmfGyPeer(gy, OCS, '127.0.1.11', 3868)).toBe(gy);
  });

  it('adds its line to a file that has no such slot yet', () => {
    const bare = `Identity = "smf.epc.mnc001.mcc001.3gppnetwork.org";\n${GX}\n`;
    expect(peers(upsertSmfAaaPeer(bare, AAA, '127.0.1.21'))).toEqual(['pcrf.epc.mnc001.mcc001.3gppnetwork.org', AAA]);
    expect(peers(upsertSmfGyPeer(bare, OCS, '127.0.1.11', 3868))).toEqual(['pcrf.epc.mnc001.mcc001.3gppnetwork.org', OCS]);
  });
});

describe('uninstall removes one peer and only one', () => {
  it('removing the S6b peer leaves Gx and Gy in place', () => {
    const out = removeSmfAaaPeer(SMF_CONF, AAA);
    expect(peers(out)).toEqual(['pcrf.epc.mnc001.mcc001.3gppnetwork.org', OCS]);
    expect(out).toContain(GX);
  });

  it('removing the Gy peer leaves Gx and S6b in place', () => {
    const out = removeSmfGyPeer(SMF_CONF, OCS);
    expect(peers(out)).toEqual(['pcrf.epc.mnc001.mcc001.3gppnetwork.org', AAA]);
  });

  it('matches the exact identity, so a dot is not a wildcard', () => {
    // The identity is interpolated into a RegExp, and every `.` is escaped
    // before it is. Without that, `aaa.epc.mnc001...` would also match a
    // hypothetical `aaaXepcXmnc001...` -- harmless here, but the same
    // unescaped-input habit is what makes a `removeSmfGyPeer('ocs.')` style
    // call delete more than it was asked to.
    const odd = SMF_CONF.replace(`"${AAA}"`, '"aaaXepcXmnc001Xmcc001X3gppnetworkXorg"');
    expect(removeSmfAaaPeer(odd, AAA)).toBe(odd);
  });

  it('removes by exact identity, NOT by slot prefix — deliberately asymmetric', () => {
    // Worth stating because it is the opposite of the upsert's rule, and the
    // asymmetry is easy to read as a bug. Remove is called on uninstall with
    // the identity the module itself stored, so a line left by some EARLIER
    // realm is not its business to delete; the next upsert's prefix strip is
    // what collects those. Narrowing remove is the safe direction: it can
    // never take out a peer the caller did not name.
    const stale = SMF_CONF.trimEnd() + '\nConnectPeer = "aaa.old.example" { No_TLS; };\n';
    const out = removeSmfAaaPeer(stale, AAA);
    expect(peers(out)).toContain('aaa.old.example');
    expect(peers(out)).not.toContain(AAA);
    // ...and the next upsert is what cleans it up.
    expect(peers(upsertSmfAaaPeer(out, AAA, '127.0.1.21')).filter((p) => p.startsWith('aaa.'))).toEqual([AAA]);
  });

  it('is a no-op when the peer is already gone', () => {
    const once = removeSmfAaaPeer(SMF_CONF, AAA);
    expect(removeSmfAaaPeer(once, AAA)).toBe(once);
  });
});
