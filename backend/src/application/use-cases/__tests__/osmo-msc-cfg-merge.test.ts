import { upsertVtyDirectives, OwnedDirective } from '../../../domain/services/vty-config-ownership';

/**
 * configureSms()'s write of osmo-msc.cfg must PRESERVE what it does not model.
 *
 * This is the counterpart to osmo-hlr-cfg-merge.test.ts, for the higher-stakes
 * of the two files. sms-controller.ts carries a warning, dated 2026-09-09, that
 * osmo-msc.cfg is a hand/VTY-maintained file holding real config the
 * osmomscCfg() template "does not model at all" -- SMPP/esme blocks (VectorCore
 * MMSC), mncc-int codec defaults, full encryption/authentication settings, smsc
 * retention policy, and extended per-category logging levels -- and that a
 * blind regeneration "silently destroys all of it".
 *
 * That regeneration was replaced by an ownership merge on 2026-09-12, and the
 * five categories above are exactly what the merge has to leave alone. Nothing
 * tested it. So the fix was load-bearing, undocumented by any test, and sitting
 * under a comment still describing the behaviour it replaced.
 *
 * Each test below names one of those five categories.
 *
 * DELIBERATE DEVIATION from the hlr test next door, which embeds this host's
 * real file verbatim: this one does NOT. The live osmo-msc.cfg carries two real
 * SMPP passwords, one of which appears nowhere in this repo, so the fixture is
 * a faithful RECONSTRUCTION of the real file's structure -- every node and
 * directive family it actually has, confirmed against the live file 2026-11-28
 * -- with synthetic credentials. A guard test keeps it that way.
 */

/**
 * The real file's structure with invented values. Node list confirmed live:
 * log stderr, stats interval, line vty, cs7 instance 0, network, msc,
 * mncc-int, smpp, hlr, sgs, smsc.
 */
const REAL_SHAPE = `!
! OsmoMSC (1.9.0) configuration saved from vty
!!
!
log stderr
 logging filter all 1
 logging color 1
 logging print category 1
 logging level mm notice
 logging level rr notice
 logging level cc notice
 logging level sms notice
 logging level vlr notice
 logging level ref notice
!
stats interval 5
!
line vty
 bind 127.0.0.2
!
cs7 instance 0
 point-code 0.23.1
 asp asp-clnt-OsmoMSC 2905 0 m3ua
  remote-ip 127.0.0.1
 as as-clnt-OsmoMSC m3ua
  asp asp-clnt-OsmoMSC
  routing-key 2 0.23.1
network
 network country code 1
 mobile network code 1
 short name TestNet
 long name TestNet
 encryption a5 0 1 3
 encryption uea 1 2
 authentication optional
 rrlp mode none
 mm info 1
msc
 mncc external /tmp/mncc.sock
 mncc guard-timeout 180
 ncss guard-timeout 30
 assign-tmsi
 cs7-instance-a 0
 cs7-instance-iu 0
 mgw local-port 2727
 mgw remote-ip 127.0.1.5
 mgw remote-port 2427
 mgw endpoint-domain mgw
mncc-int
 default-codec tch-f fr
 default-codec tch-h hr
smpp
 local-tcp-port 2775
 policy closed
 no smpp-first
 esme vectorcore-mmsc
  password 0a0a0a0a
  dcs-transparent
 esme vcsmsc
  password 0b0b0b0b
  default-route
  dcs-transparent
hlr
 remote-ip 127.0.0.1
 remote-port 4222
sgs
 local-port 29118
 local-ip 127.0.0.2
 vlr-name vlr.epc.mnc001.mcc001.3gppnetwork.org
smsc
 queue max-pending 20
 queue max-failure 1
 database delete-delivered 1
 database delete-expired 1
`;

/** Mirrors configureSms()'s own mscOwned construction, in full. */
function mscOwned(
  mcc: string, mnc: string, mscBindIp: string, hlrBindIp: string, mgwBindIp: string | null,
): OwnedDirective[] {
  return [
    { node: 'network', prefix: /^\s*network country code\s+/, line: ` network country code ${mcc}` },
    { node: 'network', prefix: /^\s*mobile network code\s+/, line: ` mobile network code ${mnc}` },
    { node: 'network', prefix: /^\s*mm info\s+/, line: ' mm info 1' },
    { node: 'msc', prefix: /^\s*assign-tmsi\s*$/, line: ' assign-tmsi' },
    { node: 'msc', prefix: /^\s*mgw remote-ip\s+/, line: mgwBindIp ? ` mgw remote-ip ${mgwBindIp}` : null },
    { node: 'msc', prefix: /^\s*mgw remote-port\s+/, line: mgwBindIp ? ' mgw remote-port 2427' : null },
    { node: 'msc', prefix: /^\s*mgw local-port\s+/, line: mgwBindIp ? ' mgw local-port 2727' : null },
    { node: 'msc', prefix: /^\s*mgw endpoint-domain\s+/, line: mgwBindIp ? ' mgw endpoint-domain mgw' : null },
    { node: 'hlr', prefix: /^\s*remote-ip\s+/, line: ` remote-ip ${hlrBindIp}` },
    { node: 'hlr', prefix: /^\s*remote-port\s+/, line: ' remote-port 4222' },
    { node: 'sgs', prefix: /^\s*local-ip\s+/, line: ` local-ip ${mscBindIp}` },
    { node: 'sgs', prefix: /^\s*local-port\s+/, line: ' local-port 29118' },
    {
      node: 'sgs', prefix: /^\s*vlr-name\s+/,
      line: ` vlr-name vlr.epc.mnc${mnc.padStart(3, '0')}.mcc${mcc}.3gppnetwork.org`,
    },
    { node: 'line vty', prefix: /^\s*bind\s+/, line: ` bind ${hlrBindIp}` },
    { node: 'line vty', prefix: /^\s*no login\s*$/, line: ' no login' },
  ];
}

const merge = (
  cur: string, mcc = '001', mnc = '01', hlrIp = '127.0.0.9', mgwIp: string | null = '127.0.1.5',
  mscIp = '127.0.0.2', fallback = 'FALLBACK-TEMPLATE',
): string => upsertVtyDirectives(cur, mscOwned(mcc, mnc, mscIp, hlrIp, mgwIp), fallback);

describe('osmo-msc.cfg ownership merge preserves what the template never modelled', () => {
  it('keeps both SMPP esme blocks, with their credentials and sub-directives', () => {
    // Category 1 of the five. VectorCore MMSC authenticates over SMPP with
    // these, and they can only ever be set over the VTY -- osmo-msc's own
    // `write` strips a password line from a static config, so there is no
    // regenerating them. Losing them takes MMS off the air with nothing in
    // this repo to restore from.
    const out = merge(REAL_SHAPE);
    expect(out).toContain('esme vectorcore-mmsc');
    expect(out).toContain('esme vcsmsc');
    expect(out).toContain('  password 0a0a0a0a');
    expect(out).toContain('  password 0b0b0b0b');
    expect(out).toContain('  default-route');
    expect(out).toContain(' local-tcp-port 2775');
    expect(out).toContain(' policy closed');
    expect(out).toContain(' no smpp-first');
  });

  it('keeps the encryption and authentication settings', () => {
    // Category 2. `encryption a5 0 1 3` is which ciphers this network will
    // accept; silently narrowing it either drops calls or, worse, downgrades
    // them without anyone noticing.
    const out = merge(REAL_SHAPE);
    expect(out).toContain(' encryption a5 0 1 3');
    expect(out).toContain(' encryption uea 1 2');
    expect(out).toContain(' authentication optional');
    expect(out).toContain(' rrlp mode none');
  });

  it('keeps the mncc-int codec defaults', () => {
    // Category 3. The AMR/FR codec negotiation this project has already been
    // bitten by once on the BSC side.
    const out = merge(REAL_SHAPE);
    expect(out).toContain(' default-codec tch-f fr');
    expect(out).toContain(' default-codec tch-h hr');
  });

  it('keeps the smsc retention policy', () => {
    // Category 4. Store-and-forward queue limits and delivered/expired
    // retention -- operator policy, not something a template can guess.
    const out = merge(REAL_SHAPE);
    for (const line of [
      ' queue max-pending 20', ' queue max-failure 1',
      ' database delete-delivered 1', ' database delete-expired 1',
    ]) {
      expect(out).toContain(line);
    }
  });

  it('keeps every per-category logging level', () => {
    // Category 5. The live file has ~54 of these; the fixture has six. They
    // are what makes a 2G fault diagnosable at all.
    const out = merge(REAL_SHAPE);
    for (const cat of ['mm', 'rr', 'cc', 'sms', 'vlr', 'ref']) {
      expect(out).toContain(` logging level ${cat} notice`);
    }
    expect(out).toContain(' logging filter all 1');
  });

  it('keeps the SS7 stack, including its nested asp and as blocks', () => {
    // Not in the warning's list but the same class, and the deepest nesting in
    // the file -- a merge that flattens or reorders chunks would show up here
    // first.
    const out = merge(REAL_SHAPE);
    expect(out).toContain('cs7 instance 0');
    expect(out).toContain(' point-code 0.23.1');
    expect(out).toContain(' asp asp-clnt-OsmoMSC 2905 0 m3ua');
    expect(out).toContain('  routing-key 2 0.23.1');
    expect(out).toContain(' mncc external /tmp/mncc.sock');
    expect(out).toContain(' cs7-instance-iu 0');
  });

});

describe('...while still writing the directives it does own', () => {
  it('rewrites the PLMN in place, at its real width', () => {
    const out = merge(REAL_SHAPE, '310', '260');
    expect(out).toContain(' network country code 310');
    expect(out).toContain(' mobile network code 260');
    expect(out).not.toContain(' network country code 1\n');
    // One copy, not an appended second.
    expect(out.split('\n').filter((l) => /network country code/.test(l))).toHaveLength(1);
  });

  it('writes the vlr-name FQDN with MNC padded to 3, while the PLMN stays 2', () => {
    // Two different widths of the same MNC in one generated file, and both are
    // correct: `mobile network code` is the real network identity (01 is not
    // 001), while a 3GPP FQDN label always pads to three digits. This repo has
    // already shipped the confusion once -- three test-IMSI builders conflated
    // them and put subscribers in PLMN 001-001 on a 001-01 host -- so having
    // both forms asserted side by side is the point.
    const out = merge(REAL_SHAPE, '001', '01');
    expect(out).toContain(' mobile network code 01');
    expect(out).toContain(' vlr-name vlr.epc.mnc001.mcc001.3gppnetwork.org');
    // A genuinely 3-digit MNC is not padded further.
    const wide = merge(REAL_SHAPE, '310', '260');
    expect(wide).toContain(' mobile network code 260');
    expect(wide).toContain(' vlr-name vlr.epc.mnc260.mcc310.3gppnetwork.org');
  });

  it('repoints the SGs bind and the VTY bind, which it also owns', () => {
    const out = merge(REAL_SHAPE, '001', '01', '127.0.0.9', '127.0.1.5', '10.0.1.7');
    expect(out).toContain(' local-ip 10.0.1.7');
    expect(out).toContain(' local-port 29118');
    expect(out).toContain(' bind 127.0.0.9');
    expect(out).toContain(' no login');
  });

  it('repoints the HLR and MGW addresses', () => {
    const out = merge(REAL_SHAPE, '001', '01', '10.0.0.9', '10.0.0.5');
    expect(out).toContain(' remote-ip 10.0.0.9');
    expect(out).toContain(' mgw remote-ip 10.0.0.5');
  });

  it('drops the mgw lines entirely when there is no MGW peer', () => {
    // A null `line` means the directive is removed rather than written, so an
    // MSC with no MGW configured does not keep pointing at a stale one.
    const out = merge(REAL_SHAPE, '001', '01', '127.0.0.9', null);
    expect(out).not.toContain('mgw remote-ip');
    expect(out).not.toContain('mgw endpoint-domain');
    // ...and the rest of the msc node survives that removal.
    expect(out).toContain(' assign-tmsi');
    expect(out).toContain(' mncc external /tmp/mncc.sock');
  });

  it('replaces an owned directive IN PLACE, not at the end of its node', () => {
    // The hlr test next door has the same assertion because the bug is real
    // there: its `bind ip` has to stay inside the nested `gsup` block rather
    // than landing after the ussd routes. Nothing in osmo-msc's owned set
    // currently sits in a node with nested children, so a move would be
    // harmless TODAY -- but `cs7 instance 0` in this very file holds nested
    // `asp` and `as` blocks, and upsertVtyDirectives is only one level deep,
    // so the first owned directive added inside such a node would be appended
    // after the child block and silently reparented.
    const body = (out: string, node: string): string[] => {
      const lines = out.split('\n');
      const at = lines.indexOf(node);
      expect(at).toBeGreaterThanOrEqual(0);
      const end = lines.findIndex((l, i) => i > at && !l.startsWith(' '));
      return lines.slice(at + 1, end === -1 ? undefined : end);
    };
    const before = body(REAL_SHAPE, 'network');
    const after = body(merge(REAL_SHAPE, '310', '260'), 'network');
    // Same directives, same order -- only the two values changed.
    expect(after.map((l) => l.trim().split(/\s+/).slice(0, 3).join(' ')))
      .toEqual(before.map((l) => l.trim().split(/\s+/).slice(0, 3).join(' ')));
    expect(after[0]).toBe(' network country code 310');
    expect(after[after.length - 1]).toBe(' mm info 1');

    // And the mgw lines stay in their original run inside `msc`.
    const msc = body(merge(REAL_SHAPE), 'msc');
    const mgw = msc.filter((l) => l.includes('mgw ')).map((l) => l.trim().split(/\s+/)[1]);
    expect(mgw).toEqual(['local-port', 'remote-ip', 'remote-port', 'endpoint-domain']);
  });

  it('uses the full template ONLY when there is no file yet', () => {
    expect(merge('')).toBe('FALLBACK-TEMPLATE');
    expect(merge('   \n')).toBe('FALLBACK-TEMPLATE');
    expect(merge(REAL_SHAPE)).not.toBe('FALLBACK-TEMPLATE');
  });

  it('is idempotent — a second merge with the same values changes nothing', () => {
    const once = merge(REAL_SHAPE);
    expect(merge(once)).toBe(once);
  });

  it('writes an owned directive into a node the file is missing', () => {
    // configureSms() must still be able to configure a hand-written file that
    // never had an `hlr` node.
    const noHlr = REAL_SHAPE.replace(/hlr\n remote-ip[^\n]*\n remote-port[^\n]*\n/, '');
    expect(noHlr).not.toContain('\nhlr\n');
    const out = merge(noHlr, '001', '01', '10.0.0.9', '127.0.1.5');
    expect(out).toContain(' remote-ip 10.0.0.9');
    expect(out).toContain('esme vectorcore-mmsc');
  });
});

describe('the fixture itself', () => {
  it('carries no real credential from the live host', () => {
    // The live file's SMPP credentials must never reach this repo, so this is
    // an ALLOW-LIST: the fixture's two credential values have to be exactly
    // the synthetic pair below. Anything else -- most obviously someone
    // pasting the real file in to make a test more "faithful" -- fails here.
    //
    // Deliberately not a deny-list. Asserting the real values are ABSENT
    // would require writing those values into this file, committing the
    // secrets in order to check for them, which defeats the whole guard. An
    // allow-list needs no knowledge of the real values at all and is the
    // stronger check besides, since it also catches a credential nobody
    // thought to add to a deny-list.
    const pw = [...REAL_SHAPE.matchAll(/^\s*password\s+(\S+)$/gm)].map((m) => m[1]);
    expect(pw).toEqual(['0a0a0a0a', '0b0b0b0b']);
    // And the fixture must not grow a third one unnoticed.
    expect(REAL_SHAPE.match(/^\s*password\s/gm)).toHaveLength(2);
  });

  it('actually exercises every node the live file has', () => {
    // A fixture missing a node proves nothing about that node surviving.
    for (const node of [
      'log stderr', 'stats interval', 'line vty', 'cs7 instance 0', 'network',
      'msc', 'mncc-int', 'smpp', 'hlr', 'sgs', 'smsc',
    ]) {
      expect(REAL_SHAPE).toContain(node);
    }
  });
});
