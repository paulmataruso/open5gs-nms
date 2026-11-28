import { upsertPcrfPcscfPeer } from '../ims-controller';
import { upsertHssAaaPeer, removeHssAaaPeer } from '../vowifi-controller';

/**
 * The remaining two freeDiameter peer files, completing the slot family.
 *
 * smf-peer-slot.test.ts covers smf.conf (Gx, S6b, Gy). These are the other
 * two files, and between them they finish the set:
 *
 *   pcrf.conf  Gx   smf.epc...     core -- never written by a module
 *              Rx   pcscf.ims...   IMS,     upsertPcrfPcscfPeer
 *   hss.conf   S6a  mme.epc...     core -- never written by a module
 *              Swx  aaa.epc...     VoWiFi,  upsertHssAaaPeer / removeHssAaaPeer
 *
 * Every one of the five slots sits beside a peer belonging to an Open5GS NF
 * that no module here owns, so each strip has to be narrow enough to leave it.
 *
 * /etc/freeDiameter/pcrf.conf is the same shape with two slots:
 *
 *   Gx   smf.epc...     Open5GS core -- owned by NOBODY here, never written
 *   Rx   pcscf.ims...   IMS, via upsertPcrfPcscfPeer
 *
 * WHY IT MATTERS, from this function's own recorded incident. It used to upsert
 * only the CURRENT fqdn's line, so re-running Configure under a different PLMN
 * left the old entries piling up -- and four stale entries from earlier PLMNs
 * "actively interfered with the real Rx connection (PCRF's own freeDiameter
 * stack misrouted the real P-CSCF's CEA to a stale peer's state machine,
 * causing a genuine connect/disconnect flap that starved real call/INVITE
 * processing entirely)". So the strip-every-stale-line behaviour is load
 * bearing for whether calls work at all, and it had no test.
 *
 * Dropping the Gx line is the other direction of damage: PCRF would stop
 * answering SMF, taking policy control out for every 4G session.
 *
 * The fixture mirrors this host's real pcrf.conf structure, confirmed
 * 2026-11-28 -- two active peers after four of freeDiameter's own commented
 * examples -- with placeholder addresses, since the live file carries real
 * peer addresses.
 */

const PCRF_CONF = `# Diameter configuration for PCRF
Identity = "pcrf.epc.mnc001.mcc001.3gppnetwork.org";
Realm = "epc.mnc001.mcc001.3gppnetwork.org";
Port = 3868;
No_SCTP;

#  This is achieved with the ConnectPeer directive described below.
#ConnectPeer = "diameterid" [ { parameter1; parameter2; ...} ] ;
#ConnectPeer = "aaa.wide.ad.jp";
#ConnectPeer = "old.diameter.serv" { TcTimer = 60; TLS_old_method; No_SCTP; Port=3868; } ;
ConnectPeer = "smf.epc.mnc001.mcc001.3gppnetwork.org" { No_TLS; };
ConnectPeer = "pcscf.ims.mnc001.mcc001.3gppnetwork.org" { ConnectTo = "127.0.1.3"; Port = 3871; No_TLS; };
`;

const GX = 'ConnectPeer = "smf.epc.mnc001.mcc001.3gppnetwork.org" { No_TLS; };';
const PCSCF = 'pcscf.ims.mnc001.mcc001.3gppnetwork.org';

function peers(raw: string): string[] {
  return raw.split('\n')
    .filter((l) => /^[ \t]*ConnectPeer/.test(l))
    .map((l) => /"([^"]*)"/.exec(l)?.[1] ?? '');
}

describe('upsertPcrfPcscfPeer writes only the Rx slot', () => {
  it("leaves PCRF's Gx peer to SMF untouched", () => {
    // Not a nicety: without it PCRF stops answering SMF and policy control
    // goes for every 4G session on the deployment.
    const out = upsertPcrfPcscfPeer(PCRF_CONF, PCSCF, '127.0.1.3', 3871);
    expect(out).toContain(GX);
    expect(peers(out)).toEqual(['smf.epc.mnc001.mcc001.3gppnetwork.org', PCSCF]);
  });

  it('writes the address and port it was given', () => {
    const out = upsertPcrfPcscfPeer(PCRF_CONF, PCSCF, '127.0.1.9', 3871);
    expect(out).toContain(`ConnectPeer = "${PCSCF}" { ConnectTo = "127.0.1.9"; Port = 3871; No_TLS; };`);
  });

  it('leaves the identity, realm and transport settings alone', () => {
    const out = upsertPcrfPcscfPeer(PCRF_CONF, PCSCF, '127.0.1.3', 3871);
    expect(out).toContain('Identity = "pcrf.epc.mnc001.mcc001.3gppnetwork.org";');
    expect(out).toContain('Realm = "epc.mnc001.mcc001.3gppnetwork.org";');
    expect(out).toContain('No_SCTP;');
  });

  it("does not disturb freeDiameter's own commented examples", () => {
    const out = upsertPcrfPcscfPeer(PCRF_CONF, PCSCF, '127.0.1.3', 3871);
    for (const line of [
      '#ConnectPeer = "diameterid" [ { parameter1; parameter2; ...} ] ;',
      '#ConnectPeer = "aaa.wide.ad.jp";',
      '#ConnectPeer = "old.diameter.serv" { TcTimer = 60; TLS_old_method; No_SCTP; Port=3868; } ;',
    ]) {
      expect(out).toContain(line);
    }
  });

  it('is idempotent', () => {
    const once = upsertPcrfPcscfPeer(PCRF_CONF, PCSCF, '127.0.1.3', 3871);
    expect(upsertPcrfPcscfPeer(once, PCSCF, '127.0.1.3', 3871)).toBe(once);
  });

  it('adds the line to a file that has no Rx peer yet', () => {
    const bare = `Identity = "pcrf.epc.mnc001.mcc001.3gppnetwork.org";\n${GX}\n`;
    const out = upsertPcrfPcscfPeer(bare, PCSCF, '127.0.1.3', 3871);
    expect(peers(out)).toEqual(['smf.epc.mnc001.mcc001.3gppnetwork.org', PCSCF]);
  });
});

describe('the recorded incident: stale peers from an earlier PLMN', () => {
  it('replaces a peer from the old PLMN rather than adding beside it', () => {
    const old = 'pcscf.ims.mnc070.mcc999.3gppnetwork.org';
    const before = PCRF_CONF.replace(PCSCF, old);
    const out = upsertPcrfPcscfPeer(before, PCSCF, '127.0.1.3', 3871);
    expect(peers(out).filter((p) => p.startsWith('pcscf.'))).toEqual([PCSCF]);
    expect(out).not.toContain(old);
  });

  it('clears FOUR stale entries at once, which is the case that was seen live', () => {
    // The real file had four. One-at-a-time removal would leave three, and
    // three is enough for PCRF to misroute the CEA.
    const stale = ['mnc070.mcc999', 'mnc01.mcc310', 'mnc02.mcc310', 'mnc99.mcc999']
      .map((p) => `ConnectPeer = "pcscf.ims.${p}.3gppnetwork.org" { ConnectTo = "127.0.1.3"; Port = 3871; No_TLS; };`)
      .join('\n');
    const before = PCRF_CONF.trimEnd() + '\n' + stale + '\n';
    expect(peers(before).filter((p) => p.startsWith('pcscf.'))).toHaveLength(5);

    const out = upsertPcrfPcscfPeer(before, PCSCF, '127.0.1.3', 3871);
    expect(peers(out).filter((p) => p.startsWith('pcscf.'))).toEqual([PCSCF]);
    expect(out).toContain(GX);
  });

  it('clears a stale entry that an operator has INDENTED', () => {
    // pcrf.conf is an editable file in the IMS config manifest
    // (ims-controller.ts:2309, group Open5GS, label pcrf.conf), so a hand
    // edit can indent this line. The strip must still see it: leaving it and
    // appending a replacement is precisely the duplicate-peer state the
    // incident above describes.
    //
    // This is also what makes the three slot-strip regexes one idiom rather
    // than three -- vowifi-controller.ts and ocs-controller.ts both anchor
    // `^[ \t]*ConnectPeer`, and this one did not until it was aligned with
    // them.
    const before = PCRF_CONF.replace(
      `ConnectPeer = "${PCSCF}"`,
      `  ConnectPeer = "${PCSCF}"`,
    );
    const out = upsertPcrfPcscfPeer(before, PCSCF, '127.0.1.3', 3871);
    expect(peers(out).filter((p) => p.startsWith('pcscf.'))).toEqual([PCSCF]);
    // Exactly one line, not an indented leftover plus a fresh one.
    expect(out.split('\n').filter((l) => l.includes(PCSCF))).toHaveLength(1);
  });

  it('a commented-out stale entry is still left alone, indented or not', () => {
    // The `#` is neither a space nor a tab, so widening the anchor to allow
    // indentation must not start matching comments.
    const before = PCRF_CONF
      + '#ConnectPeer = "pcscf.ims.mnc070.mcc999.3gppnetwork.org" { No_TLS; };\n'
      + '  #ConnectPeer = "pcscf.ims.mnc02.mcc310.3gppnetwork.org" { No_TLS; };\n';
    const out = upsertPcrfPcscfPeer(before, PCSCF, '127.0.1.3', 3871);
    expect(out).toContain('#ConnectPeer = "pcscf.ims.mnc070.mcc999.3gppnetwork.org" { No_TLS; };');
    expect(out).toContain('  #ConnectPeer = "pcscf.ims.mnc02.mcc310.3gppnetwork.org" { No_TLS; };');
  });
});

describe('upsertHssAaaPeer writes only the Swx slot in hss.conf', () => {
  /**
   * hss.conf's own layout on this host, confirmed 2026-11-28: the S6a peer to
   * MME, which open5gs-hssd needs for every 4G attach and which no module here
   * owns, and VoWiFi's Swx peer beside it.
   */
  const HSS_CONF = `# Diameter configuration for HSS
Identity = "hss.epc.mnc001.mcc001.3gppnetwork.org";
Realm = "epc.mnc001.mcc001.3gppnetwork.org";
No_SCTP;

#ConnectPeer = "aaa.wide.ad.jp";
ConnectPeer = "mme.epc.mnc001.mcc001.3gppnetwork.org" { No_TLS; };
ConnectPeer = "aaa.epc.mnc001.mcc001.3gppnetwork.org" { ConnectTo = "127.0.1.20"; No_TLS; };
`;
  const S6A = 'ConnectPeer = "mme.epc.mnc001.mcc001.3gppnetwork.org" { No_TLS; };';
  const AAA = 'aaa.epc.mnc001.mcc001.3gppnetwork.org';

  it("leaves HSS's S6a peer to MME untouched", () => {
    // Taking this out would stop every 4G attach on the deployment, which is a
    // larger blast radius than the VoWiFi feature doing the writing.
    const out = upsertHssAaaPeer(HSS_CONF, AAA, '127.0.1.21');
    expect(out).toContain(S6A);
    expect(peers(out)).toEqual(['mme.epc.mnc001.mcc001.3gppnetwork.org', AAA]);
    expect(out).toContain(`ConnectPeer = "${AAA}" { ConnectTo = "127.0.1.21"; No_TLS; };`);
  });

  it('replaces a peer from an earlier PLMN rather than adding beside it', () => {
    const old = 'aaa.epc.mnc070.mcc999.3gppnetwork.org';
    const out = upsertHssAaaPeer(HSS_CONF.replace(AAA, old), AAA, '127.0.1.21');
    expect(peers(out).filter((p) => p.startsWith('aaa.'))).toEqual([AAA]);
  });

  it('drops the stale epdg.localdomain entry that was found live', () => {
    // A leftover from an unrelated experiment, predating this backend and never
    // a reachable Swx peer -- harmless until the VoWiFi migration made Swx load
    // bearing. It is removed by a SECOND, separate strip, so the aaa. strip
    // passing says nothing about this one.
    const before = HSS_CONF.trimEnd()
      + '\nConnectPeer = "epdg.localdomain" { ConnectTo = "127.0.0.1"; No_TLS; };\n';
    const out = upsertHssAaaPeer(before, AAA, '127.0.1.21');
    expect(out).not.toContain('epdg.localdomain');
    expect(out).toContain(S6A);
  });

  it('leaves a commented example and the transport settings alone', () => {
    const out = upsertHssAaaPeer(HSS_CONF, AAA, '127.0.1.21');
    expect(out).toContain('#ConnectPeer = "aaa.wide.ad.jp";');
    expect(out).toContain('Identity = "hss.epc.mnc001.mcc001.3gppnetwork.org";');
    expect(out).toContain('No_SCTP;');
  });

  it('is idempotent', () => {
    const once = upsertHssAaaPeer(HSS_CONF, AAA, '127.0.1.21');
    expect(upsertHssAaaPeer(once, AAA, '127.0.1.21')).toBe(once);
  });

  it('uninstall removes the Swx peer and leaves S6a', () => {
    const out = removeHssAaaPeer(HSS_CONF, AAA);
    expect(peers(out)).toEqual(['mme.epc.mnc001.mcc001.3gppnetwork.org']);
    expect(out).toContain(S6A);
  });

  it('uninstall is a no-op when the peer is already gone', () => {
    const once = removeHssAaaPeer(HSS_CONF, AAA);
    expect(removeHssAaaPeer(once, AAA)).toBe(once);
  });

  it('uninstall matches the EXACT identity, not the aaa. slot — same asymmetry', () => {
    // Deliberately the opposite rule from the upsert directly above, for the
    // reason smf-peer-slot.test.ts spells out: remove is called with the
    // identity this module itself stored, so a line left by some earlier realm
    // is not its business to delete -- the next upsert's prefix strip collects
    // those. Narrowing remove is the safe direction, since it can never take
    // out a peer the caller did not name.
    //
    // Without this, a remove widened to sweep the whole `aaa.` slot passes
    // every other test in this suite: the current peer still goes and the S6a
    // peer still stays.
    // The stale line goes BEFORE the current one, and that ordering is the
    // whole test. This regex is built with 'm' and not 'g', so it removes the
    // first match only -- put the stale line last and a slot-wide sweep
    // removes the current peer anyway, behaving identically to an exact match
    // and proving nothing. Ahead of it, a sweep takes the stale line and
    // leaves the real one, which is the bug.
    const stale = HSS_CONF.replace(
      `ConnectPeer = "${AAA}"`,
      `ConnectPeer = "aaa.old.example" { No_TLS; };\nConnectPeer = "${AAA}"`,
    );
    expect(peers(stale)).toEqual([
      'mme.epc.mnc001.mcc001.3gppnetwork.org', 'aaa.old.example', AAA,
    ]);
    const out = removeHssAaaPeer(stale, AAA);
    expect(peers(out)).toContain('aaa.old.example');
    expect(peers(out)).not.toContain(AAA);
    // ...and the next upsert is what clears it.
    expect(peers(upsertHssAaaPeer(out, AAA, '127.0.1.21')).filter((x) => x.startsWith('aaa.')))
      .toEqual([AAA]);
  });

  it('uninstall escapes the dots, so a dot is not a wildcard', () => {
    const odd = HSS_CONF.replace(`"${AAA}"`, '"aaaXepcXmnc001Xmcc001X3gppnetworkXorg"');
    expect(removeHssAaaPeer(odd, AAA)).toBe(odd);
  });
});
