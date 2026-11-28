import * as fs from 'fs';
import * as path from 'path';
import { pjsipPstnConf, extensionsPstnConf } from '../pstn-controller';
import { pjsip2gConf, rtp2gConf, extensions2gConf } from '../asterisk-2g-controller';

/**
 * Golden masters and incident guards for the two Asterisk instances.
 *
 * WHY THIS EXISTS. The PSTN Gateway and Asterisk-2G are separate B2BUA
 * instances that must never touch each other's config, and nearly every real
 * fault in them has been a config-level one that a passing function call
 * cannot see: `allow=amr` on the inter-Asterisk trunk letting raw AMR reach a
 * GSM-only leg (one-way audio, found by packet capture); a missing
 * `rtp_keepalive`; `asymmetric_rtp_codec=yes` letting Asterisk SEND a
 * different codec than it received; a 2G echo-test code with no route on the
 * PSTN side, which the outbound catch-all then dialled at the real provider
 * and the handset saw as a 603 Decline; and a subscriber-MSISDN exact match
 * shadowing the catch-all so cross-RAN dialling failed.
 *
 * WHAT WAS VERIFIED AGAINST THE LIVE HOST, 2026-11-28. Both Asterisk
 * instances were active. Rendered from this deployment's own state files
 * (`.pstn-config.json`, `.asterisk2g-config.json`, `.ims-config.json`,
 * `.nms-gsm-bts-state.json`), all three of these are BYTE-IDENTICAL to the
 * file live in /etc/asterisk and /etc/asterisk-2g:
 *
 *     pjsip_pstn.conf      pjsip.conf (2G)      rtp.conf (2G)
 *
 * THE DIALPLANS ARE DELIBERATELY NOT GOLDENED FROM LIVE DATA, and the reason
 * is not convenience. Both dialplan generators enumerate real subscribers —
 * the live extensions_pstn.conf carries 11 subscribers' MSISDNs next to their
 * IMSIs, one `exten` per identity — so a golden captured from this host would
 * commit subscriber PII to the repository, which is exactly what .gitignore
 * exists to prevent for hlr.db and radio-backups. The inputs here are
 * therefore SYNTHETIC (555-prefixed MSISDNs, 00101 test IMSIs), the goldens
 * record the generator rather than this deployment, and the incident guards
 * below are what carry the real weight for those two files.
 *
 * WHAT A FAILURE MEANS, and how to regenerate:
 *
 *     UPDATE_GOLDEN=1 npx jest voice-config-golden
 *
 * Read the diff. On this module a wrong byte is a call that does not connect
 * or has audio in one direction only, and neither shows up as an error.
 */

const GOLDEN_DIR = path.join(__dirname, 'golden', 'voice');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

// ── live wiring, from this deployment's own state files ────────────────────
const PSTN_IP = '127.0.1.4';
const A2G_IP = '127.0.1.7';
const SIPCONN_IP = '127.0.1.6';   // osmo-sip-connector
const CORE = { icscfIp: '127.0.1.1', icscfPort: 4060, scscfIp: '127.0.1.2', mediaIp: '10.0.1.178' };
const EXTERNAL = {
  enabled: true, bindIp: '10.0.1.200', bindPort: 5060, interfaceMode: 'dummy' as const,
  externalMediaAddress: '10.0.1.200', providerHost: '172.16.0.130', providerPort: 5060,
  providerCidr: '172.16.0.130/32',
};

// ── synthetic dialplan inputs, NOT this host's subscribers ─────────────────
const IMS_DOMAIN = 'ims.mnc001.mcc001.3gppnetwork.org';
const PSTN_ECHO = '500';
const A2G_ECHO = '600';
// `label` is omitted rather than set: the stored documents on this host carry
// `label: null`, while PstnExtension types it `string | undefined`. Every
// consumer reads it through truthiness or `?? '—'`, so nothing is broken by
// the mismatch and it is not this test's job to change the type — but a
// `label === undefined` check would be false for every real row, so do not
// write one.
const EXTENSIONS = [
  { extension: '1010', subscriberImsi: '001010000000001', createdAt: '2026-01-01T00:00:00.000Z' },
  { extension: '2020', subscriberImsi: '001010000000002', createdAt: '2026-01-01T00:00:00.000Z' },
];
const AUTO_DIAL = [
  { extension: '15550000001', subscriberImsi: '001010000000001', gsm: false },
  { extension: '15550000009', subscriberImsi: '001010000053550', gsm: true },
];
const DIDS = [
  { did: '15559990000', subscriberImsi: '001010000000001', gsm: false, subscriberMsisdn: '15550000001' },
  { did: '15559990001', subscriberImsi: '001010000053550', gsm: true, subscriberMsisdn: '15550000009' },
];
/** The 2G side's own codes, as PSTN receives them for forwarding. */
const A2G_CODES = [{ extension: '6060' }, { extension: '7070' }, { extension: A2G_ECHO }];
/** The PSTN side's own codes, as Asterisk-2G receives them. */
const PSTN_CODES = [{ extension: '1010' }, { extension: '2020' }, { extension: PSTN_ECHO }];
const GSM_SHORT_CODES = [
  { extension: '6060', subscriberMsisdn: '15550000009' },
  { extension: '7070', subscriberMsisdn: '15550000010' },
];
const GSM_MSISDNS = ['15550000009', '15550000010'];

const CASES: Array<{ file: string; live: boolean; render: () => string }> = [
  {
    file: 'pjsip_pstn.conf', live: true,
    render: () => pjsipPstnConf(PSTN_IP, CORE, { crossRan: { ip: A2G_IP, port: 5060 }, external: EXTERNAL }),
  },
  {
    file: 'pjsip_2g.conf', live: true,
    render: () => pjsip2gConf(A2G_IP, 5060, SIPCONN_IP, 5060, { ip: PSTN_IP, port: 5060 }),
  },
  { file: 'rtp_2g.conf', live: true, render: () => rtp2gConf() },
  {
    file: 'extensions_pstn.conf', live: false,
    render: () => extensionsPstnConf(IMS_DOMAIN, EXTENSIONS, AUTO_DIAL, PSTN_ECHO, A2G_CODES, true, DIDS),
  },
  {
    file: 'extensions_2g.conf', live: false,
    render: () => extensions2gConf('_X.', A2G_ECHO, GSM_SHORT_CODES, PSTN_CODES, GSM_MSISDNS),
  },
];

describe('generated Asterisk configs match their golden masters', () => {
  it.each(CASES.map((c) => [c.file, c] as const))('%s', (file, c) => {
    const golden = path.join(GOLDEN_DIR, file);
    const rendered = c.render();
    if (UPDATE) {
      fs.writeFileSync(golden, rendered, 'utf-8');
      return;
    }
    expect(fs.readFileSync(golden, 'utf-8')).toBe(rendered);
  });

  it('the golden directory holds exactly the files under test', () => {
    expect(fs.readdirSync(GOLDEN_DIR).sort()).toEqual(CASES.map((c) => c.file).sort());
  });

  it('no golden carries a subscriber identifier from this deployment', () => {
    // The committed goldens must stay synthetic. This is the mechanical guard
    // on that: a regenerate run on a live host with UPDATE_GOLDEN=1 against
    // the real dialplan inputs would otherwise quietly commit real MSISDNs
    // and IMSIs. Only the 555-prefixed test range and 00101000000000x test
    // IMSIs are allowed.
    for (const c of CASES) {
      const text = fs.readFileSync(path.join(GOLDEN_DIR, c.file), 'utf-8');
      const msisdns = Array.from(new Set(Array.from(text.matchAll(/\b1\d{10}\b/g), (m) => m[0])));
      for (const n of msisdns) expect(n.startsWith('1555')).toBe(true);
      const imsis = Array.from(new Set(Array.from(text.matchAll(/\b00101\d{10}\b/g), (m) => m[0])));
      for (const i of imsis) {
        expect(
          i.startsWith('00101000000000') || i === '001010000053550',
        ).toBe(true);
      }
    }
  });
});

describe('codec rules on the inter-Asterisk trunk', () => {
  const pstn = pjsipPstnConf(PSTN_IP, CORE, { crossRan: { ip: A2G_IP, port: 5060 }, external: EXTERNAL });
  const a2g = pjsip2gConf(A2G_IP, 5060, SIPCONN_IP, 5060, { ip: PSTN_IP, port: 5060 });

  /**
   * The body of one PJSIP section.
   *
   * A PJSIP trunk is THREE sections sharing one name -- type=identify,
   * type=aor and type=endpoint -- so selecting by name alone returns whichever
   * comes first, which is the identify block and carries none of the codec or
   * media settings. My first version of this helper did exactly that and
   * reported every endpoint as having no `allow=` line at all, which read as
   * four real config faults. Pass the `type` you mean.
   */
  function sectionBody(conf: string, name: string, type: string): string {
    const parts = conf.split(/^\[([^\]]+)\]$/m).slice(1);
    for (let i = 0; i < parts.length; i += 2) {
      if (parts[i] === name && parts[i + 1].includes(`type=${type}`)) return parts[i + 1];
    }
    throw new Error(`no [${name}] section of type=${type} in this config`);
  }

  /** Every codec allowed on one endpoint, in declared order. */
  function allowsOf(conf: string, section: string): string[] {
    return Array.from(sectionBody(conf, section, 'endpoint').matchAll(/^allow=(.*)$/gm), (m) => m[1].trim());
  }

  it('both ends of the inter-Asterisk trunk are restricted to gsm ONLY', () => {
    // Real bug, confirmed live by packet capture: with amrwb/amr also allowed,
    // raw AMR reached Asterisk-2G's GSM-only sipconn leg unconverted and the
    // call had audio in one direction. Listing the native codec FIRST as a
    // soft bias did NOT work -- each endpoint's effective
    // codec_prefs_outgoing_offer resolved the codec from the OTHER leg or from
    // its own configured order. A codec absent from allow= can never appear in
    // an offer or answer, which is what forecloses the whole bug class, so
    // this is an equality assertion and not a "does not contain amr" one.
    expect(allowsOf(pstn, 'asterisk2g_trunk')).toEqual(['gsm']);
    expect(allowsOf(a2g, 'pstn_trunk')).toEqual(['gsm']);
  });

  it('keeps Asterisk in the media path on both ends of that trunk', () => {
    // direct_media=no is a hard functional requirement, not inherited B2BUA
    // hardening: the AMR<->GSM transcode can only happen while Asterisk is in
    // the RTP path on both legs.
    for (const [conf, section] of [[pstn, 'asterisk2g_trunk'], [a2g, 'pstn_trunk']] as const) {
      const body = sectionBody(conf, section, 'endpoint');
      expect(body).toMatch(/^direct_media=no$/m);
      // rtp_keepalive is carried from day one rather than waiting to
      // rediscover the no-audio bug it fixed: the risk is generic to any
      // rtp_symmetric-dependent B2BUA leg.
      expect(body).toMatch(/^rtp_keepalive=5$/m);
    }
  });

  it('does not let the IMS trunk send a codec it did not receive', () => {
    // asymmetric_rtp_codec=yes on scscf_trunk meant the UE transmitted AMR-WB
    // (PT 116) while Asterisk transmitted AMR-NB (PT 118) on the same leg. A
    // real IMS handset configures ONE decoder per session, so it silently
    // discarded the second codec: one-way audio with a completely healthy
    // media path, errors 0 and packet counts matching hop for hop.
    expect(sectionBody(pstn, 'scscf_trunk', 'endpoint')).toMatch(/^asymmetric_rtp_codec=no$/m);
    // It must still offer the wideband codec a real handset actually uses --
    // the alternative fix considered was dropping allow=amr, which would have
    // left a narrowband-only device with no common codec and failed the call
    // outright instead of sounding wrong.
    expect(allowsOf(pstn, 'scscf_trunk')).toContain('amrwb');
  });

  it('leaves the narrowband-only external trunk asymmetric', () => {
    // The external trunk offers ulaw/alaw only, so there is nothing to
    // mismatch, and the setting is deliberately left as it is rather than
    // changed for uniformity.
    expect(allowsOf(pstn, 'external_trunk')).toEqual(['ulaw', 'alaw']);
    expect(sectionBody(pstn, 'external_trunk', 'endpoint')).toMatch(/^asymmetric_rtp_codec=yes$/m);
  });
});

describe('cross-RAN dialplan routing', () => {
  const pstn = extensionsPstnConf(IMS_DOMAIN, EXTENSIONS, AUTO_DIAL, PSTN_ECHO, A2G_CODES, true, DIDS);
  const a2g = extensions2gConf('_X.', A2G_ECHO, GSM_SHORT_CODES, PSTN_CODES, GSM_MSISDNS);

  /** Every exact-match `exten =>` digit string in a dialplan. */
  function exactExtens(conf: string): string[] {
    return Array.from(conf.matchAll(/^exten => ([0-9+]+),1,/gm), (m) => m[1]);
  }

  it('gives every forwarded code an exact match, so none can reach the catch-all', () => {
    // Real bug: the 2G echo test 600 had no exact match on the PSTN side, fell
    // through to the outbound catch-all, and was dialled at the real provider
    // as PJSIP/600@external_trunk. The provider declined a three-digit number
    // and the handset saw a 603 that looked like the echo test rejecting the
    // call. The asymmetry is why only one direction broke -- Asterisk-2G's
    // catch-all points at pstn_trunk, so 2G->500 worked by accident.
    //
    // What this proves is the generator half: a code in the forwarded list
    // gets an exact match and is therefore unreachable by the catch-all. That
    // the ECHO TEST is in that list at all is a separate step, asserted in the
    // call-site test below -- an earlier version of this test claimed both and
    // proved only the first, which a mutation emptying the echo number did not
    // fail.
    for (const c of A2G_CODES) expect(exactExtens(pstn)).toContain(c.extension);
    for (const c of PSTN_CODES) expect(exactExtens(a2g)).toContain(c.extension);
  });

  it('emits no duplicate exact match in either dialplan', () => {
    // Asterisk silently keeps the FIRST duplicate in a context and logs a
    // warning nobody reads, so a duplicate is a routing decision made by
    // declaration order.
    for (const conf of [pstn, a2g]) {
      const all = exactExtens(conf);
      expect(all).toEqual(Array.from(new Set(all)));
    }
  });

  it('the dialplan generator trusts its code list, so the CALL SITE must filter', () => {
    // Layering, established by measurement rather than assumed: handed a list
    // that collides with a local code, extensionsPstnConf emits the forwarded
    // copy too and produces a duplicate exten. That is not a defect in the
    // generator -- dropLocallyOwnedCodes() is applied by regenerateDialplan()
    // before the list ever reaches it, and that function plus
    // withGsm2gEchoTest() are covered on their own in
    // pstn-cross-ran-echo.test.ts.
    //
    // What nothing covered is that the call site still CALLS them. A pair of
    // pure, well-tested helpers that no longer run is a real failure mode in
    // this repository -- infrastructure/yaml/yaml-updater.ts is exactly that,
    // the right tool with no importers -- and here it would silently restore
    // the duplicate-exten bug, which Asterisk resolves by keeping whichever
    // copy was declared first and logging a warning nobody reads.
    const src = fs.readFileSync(path.join(__dirname, '..', 'pstn-controller.ts'), 'utf-8')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    const call = /crossRanPeerCodes\s*=\s*dropLocallyOwnedCodes\(([\s\S]{0,300}?)\);/.exec(src);
    expect(call).not.toBeNull();
    // Filtered against this side's own echo test AND its own extensions --
    // either one missing reopens half the bug.
    expect(call![1]).toContain('resolvedEchoTestNumber');
    expect(call![1]).toContain('extensions.map');
    // And the filtered list is what the generator is handed, not the raw one.
    const render = /extensionsPstnConf\(([^;]*?)\)/.exec(src);
    expect(render![1]).toContain('crossRanPeerCodes');

    // The other half of the echo-test fix: the 2G echo number has to be ADDED
    // to the forwarded list before any of the above runs. Pinned here because
    // the generator cannot tell a list that never contained it from one that
    // legitimately has no 2G side -- an earlier version of the echo test above
    // passed with this step emptied out.
    const fwd = /withGsm2gEchoTest\(([\s\S]{0,200}?)\);/.exec(src);
    expect(fwd).not.toBeNull();
    expect(fwd![1]).toContain('getAsterisk2gEchoTestNumber()');

    // The collision itself, recorded so the layering above stays a measured
    // claim: this is what the generator does with an unfiltered list.
    const unfiltered = extensionsPstnConf(IMS_DOMAIN, EXTENSIONS, AUTO_DIAL, PSTN_ECHO,
      [{ extension: '1010' }, { extension: PSTN_ECHO }], true, DIDS);
    const all = exactExtens(unfiltered);
    expect(all.length).toBeGreaterThan(new Set(all).size);
  });

  it('the 2G catch-all routes to the PSTN trunk, and is a pattern not a literal', () => {
    // Its `_X.` catch-all is how a 2G subscriber reaches an external number
    // at all: it used to loop every unmatched string back through sipconn,
    // which osmo-msc correctly rejected as an unknown subscriber, so the call
    // died instantly without ever reaching PSTN.
    expect(a2g).toMatch(/^exten => _X\.,1,/m);
    const tail = a2g.split('exten => _X.,1,')[1];
    expect(tail).toContain('pstn_trunk');
  });

  it('a 2G subscriber\'s own MSISDN routes over sipconn, and nobody else\'s does', () => {
    // Real bug: the per-subscriber MSISDN blocks were generated from EVERY
    // subscriber, so a 4G/5G-only subscriber's MSISDN got an exact match that
    // shadowed the catch-all, and dialling it from the 2G side was retried
    // through sipconn and rejected as an unknown subscriber. The generator's
    // contract is that it emits a block only for the MSISDNs it is GIVEN --
    // the caller filters to gsmEnabled.
    const sip = a2g.split('exten => 15550000009,1,')[1].split(/\nexten => /)[0];
    expect(sip).toContain('sipconn');
    expect(exactExtens(a2g)).not.toContain('15550000001');
  });

  it('the PSTN echo test is answered locally, before any Dial()', () => {
    // It must work with zero subscriber extensions assigned, so it cannot
    // route back out through S-CSCF.
    const block = pstn.split(`exten => ${PSTN_ECHO},1,`)[1].split(/\nexten => /)[0];
    expect(block).toContain('Echo()');
    expect(block).not.toContain('Dial(');
  });

  it('drops the outbound catch-all entirely when the external trunk is off', () => {
    // Otherwise it would reference a PJSIP endpoint that does not exist, and
    // every unmatched string would fail inside Asterisk rather than simply
    // not matching.
    const off = extensionsPstnConf(IMS_DOMAIN, EXTENSIONS, AUTO_DIAL, PSTN_ECHO, A2G_CODES, false, DIDS);
    expect(off).not.toContain('external_trunk');
    expect(pstn).toContain('external_trunk');
  });

  it('routes an inbound DID to the right leg for the target subscriber', () => {
    // A DID whose subscriber is on 2G must cross to Asterisk-2G and be dialled
    // by MSISDN, because that is the only identity the 2G side can resolve; a
    // 4G/5G one goes out through S-CSCF dialled by IMSI. Getting either
    // backwards rings nothing at all, and both are generated from the same
    // loop, so one `gsm` test covers the branch.
    const gsm = pstn.split('exten => 15559990001,1,')[1].split(/\nexten => /)[0];
    expect(gsm).toContain('@asterisk2g_trunk');
    expect(gsm).toContain('15550000009');     // the MSISDN, not the IMSI
    const ims = pstn.split('exten => 15559990000,1,')[1].split(/\nexten => /)[0];
    expect(ims).toContain('@scscf_trunk');
    expect(ims).toContain('001010000000001'); // the IMSI, not the MSISDN
  });

  it('sends early ringback on an inbound DID to a 2G subscriber', () => {
    // Real fix, found getting a real inbound external call to ring a 2G
    // handset: without Ringing() the caller hears nothing while the 2G leg
    // sets up, which on a real trunk is long enough to be read as a dead
    // call. The IMS leg does not need it -- S-CSCF relays the UE's own 180.
    const gsm = pstn.split('exten => 15559990001,1,')[1].split(/\nexten => /)[0];
    expect(gsm.indexOf('Ringing()')).toBeGreaterThan(-1);
    expect(gsm.indexOf('Ringing()')).toBeLessThan(gsm.indexOf('Dial('));
  });

  it('sends early ringback on a GSM auto-dial target, and not on an IMS one', () => {
    // Same reasoning as the DID leg: paging a real 2G radio takes seconds, and
    // this block reaches it over the same asterisk2g_trunk hop, so it carries
    // the same exposure to an impatient caller cancelling first. The IMS
    // target must NOT have it -- see the cross-RAN test below for what adding
    // it where it is not justified actually did.
    const gsm = pstn.split('exten => 15550000009,1,')[1].split(/\nexten => /)[0];
    expect(gsm).toContain('Ringing()');
    const ims = pstn.split('exten => 15550000001,1,')[1].split(/\nexten => /)[0];
    expect(ims).not.toContain('Ringing()');
  });

  it('never sends early ringback on a forwarded cross-RAN short code', () => {
    // Real bug, confirmed live by packet-level SIP trace: Ringing() had been
    // copied here from the DID block without its justification applying --
    // the caller on this path is always an internal IMS subscriber via
    // scscf_trunk, never an external trunk with its own CANCEL timer. The
    // Ringing()+Dial() pair made Asterisk's own B2BUA answer come back
    // `a=inactive` instead of `sendrecv`, so chan_pjsip substituted local
    // MusicOnHold onto the bridged 2G leg and the real 2G phone heard hold
    // music instead of the caller's voice.
    //
    // This is the opposite polarity to the two tests above, which is exactly
    // why it is worth pinning: 'add Ringing() for consistency' is a plausible
    // tidy-up that silently reintroduces it.
    const fwd = pstn.split('exten => 6060,1,')[1].split(/\nexten => /)[0];
    expect(fwd).toContain('asterisk2g_trunk');
    expect(fwd).not.toContain('Ringing()');
  });

  it('dials both the bare and the +-prefixed form of every DID', () => {
    // A real provider may present either, and an unmatched inbound DID is a
    // call that never reaches the subscriber.
    const all = exactExtens(pstn);
    for (const d of ['15559990000', '15559990001']) {
      expect(all).toContain(d);
      expect(all).toContain(`+${d}`);
    }
  });
});
