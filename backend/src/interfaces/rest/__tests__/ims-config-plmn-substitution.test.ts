import {
  scscfIncludeCfg, icscfIncludeCfg, smscIncludeCfg, pcscfIncludeCfg,
  scscfDiameterXml, pcscfDiameterXml, icscfDiameterXml,
} from '../ims-controller';

/**
 * Parametric substitution tests: does changing a UI input actually change
 * EVERY place in the generated config that depends on it?
 *
 * WHY THIS IS A DIFFERENT TEST FROM THE GOLDEN MASTER. `ims-config-golden`
 * pins one parameter set -- this deployment's -- and proves a refactor does
 * not change the bytes. It says nothing about whether a DIFFERENT input
 * produces a correct file. Treat these configs as templates the UI fills in:
 * the failure that matters is a value that was hardcoded or missed, so after
 * changing the PLMN from 001-01 to 000-00 one line still reads
 * `hss.ims.mnc001.mcc001.3gppnetwork.org` while the rest moved on. That file
 * is syntactically perfect and points at a network that does not exist.
 *
 * THE PROPERTY. Render a generator with PLMN A, render it again with PLMN B,
 * and assert that NO trace of A survives in B's output. A hardcoded `mcc001`
 * anywhere fails immediately, because B's render would still contain it. This
 * is stronger than checking that B's values are present: present-and-correct
 * does not rule out a stale duplicate sitting next to it, and a stale
 * duplicate is the actual bug shape.
 *
 * MNC WIDTH IS DELIBERATELY EXERCISED AT BOTH WIDTHS. An FQDN always pads the
 * MNC to three digits (`mnc093`) while other contexts use its real width, and
 * conflating the two has already put subscribers in the wrong PLMN on this
 * project once. So the scenarios include a 2-digit and a 3-digit MNC, and the
 * padding is asserted rather than assumed.
 */

interface Plmn { readonly label: string; readonly mcc: string; readonly mnc: string }

const SCENARIOS: readonly Plmn[] = [
  { label: 'this deployment', mcc: '001', mnc: '01' },
  { label: 'all zeros', mcc: '000', mnc: '00' },
  { label: '2-digit MNC', mcc: '505', mnc: '93' },
  { label: '3-digit MNC', mcc: '310', mnc: '410' },
];

/** The FQDN rule: MNC padded to three, MCC as given. Mirrors deriveImsDomain. */
const imsDomainOf = (p: Plmn): string => `ims.mnc${p.mnc.padStart(3, '0')}.mcc${p.mcc}.3gppnetwork.org`;
const epcDomainOf = (p: Plmn): string => `epc.mnc${p.mnc.padStart(3, '0')}.mcc${p.mcc}.3gppnetwork.org`;

/** Every generated file, rendered for one PLMN. */
function renderAll(p: Plmn): Record<string, string> {
  const ims = imsDomainOf(p);
  const epc = epcDomainOf(p);
  return {
    'scscf.cfg': scscfIncludeCfg({
      scscfIp: '127.0.1.2', scscfPort: 6060, mcc: '001', mnc: '01', imsDomain: ims, additionalDomains: [],
      routeSmsToVectorcore: { ip: '127.0.1.5', port: 5060 },
      voiceCharging: { ocsOriginHost: `ocs.${epc}` },
      cdrAccounting: true, sipTracing: true,
    }),
    'icscf.cfg': icscfIncludeCfg({
      icscfIp: '127.0.1.1', icscfPort: 4060, imsDomain: ims,
      additionalDomains: [], sipTracing: true,
    }),
    'smsc.cfg': smscIncludeCfg({ smscIp: '10.0.1.178', imsDomain: ims }),
    'pcscf.cfg': pcscfIncludeCfg({
      pcscfIp: '10.0.1.178', pcscfPort: 5060, imsDomain: ims, epcDomain: epc,
      additionalDomains: [], http2N5Available: true, sipTracing: true,
    }),
    'icscf.xml': icscfDiameterXml({ icscfIp: '127.0.1.1', imsDomain: ims }),
    'scscf.xml': scscfDiameterXml({
      scscfIp: '127.0.1.2', imsDomain: ims, ocsPeer: { fqdn: `ocs.${epc}`, port: 3868 },
    }),
    'pcscf.xml': pcscfDiameterXml({
      pcscfIp: '10.0.1.178', imsDomain: ims, pcrfFqdn: `pcrf.${epc}`, pcrfPort: 3868,
    }),
  };
}

const FILES = Object.keys(renderAll(SCENARIOS[0]));

describe('changing the PLMN changes every place that depends on it', () => {
  // The core property. For each pair of distinct PLMNs, the render for B must
  // not contain A's mcc/mnc tokens anywhere. `mcc001` rather than `001` on
  // purpose: a bare `001` legitimately occurs inside addresses and ports.
  const pairs = SCENARIOS.flatMap((a) => SCENARIOS.filter((b) => b !== a).map((b) => [a, b] as const));

  test.each(pairs.map(([a, b]) => [`${a.mcc}-${a.mnc} -> ${b.mcc}-${b.mnc}`, a, b] as const))(
    'no trace of the old PLMN survives: %s',
    (_label, from, to) => {
      const rendered = renderAll(to);
      const staleMcc = `mcc${from.mcc}`;
      const staleMnc = `mnc${from.mnc.padStart(3, '0')}`;
      for (const [file, content] of Object.entries(rendered)) {
        // Skip the token that happens to be identical between the two PLMNs
        // (e.g. mcc001 -> mnc001 pads to the same string in some pairs).
        if (staleMcc !== `mcc${to.mcc}`) {
          expect(`${file}: ${content}`).not.toContain(staleMcc);
        }
        if (staleMnc !== `mnc${to.mnc.padStart(3, '0')}`) {
          expect(`${file}: ${content}`).not.toContain(staleMnc);
        }
      }
    },
  );

  test.each(SCENARIOS.map((p) => [p.label, p] as const))(
    'the new PLMN is actually present in every file that names a domain: %s',
    (_label, p) => {
      const rendered = renderAll(p);
      const ims = imsDomainOf(p);
      // Each of these files carries the IMS domain in at least one form.
      for (const file of FILES) {
        expect(rendered[file]).toContain(`mnc${p.mnc.padStart(3, '0')}.mcc${p.mcc}`);
      }
      // And the full FQDN, not just the fragment, somewhere in the CSCF cfgs.
      for (const file of ['scscf.cfg', 'icscf.cfg', 'pcscf.cfg']) {
        expect(rendered[file]).toContain(ims);
      }
    },
  );

  // MNC width. An FQDN pads to three digits; a 3-digit MNC is left alone. Both
  // are checked against the rendered output rather than the helper, so a
  // generator that re-implements the rule inline is still caught.
  test('the MNC is padded to three digits in an FQDN, at both widths', () => {
    const two = renderAll({ label: '2', mcc: '505', mnc: '93' });
    expect(two['scscf.cfg']).toContain('mnc093.mcc505');
    expect(two['scscf.cfg']).not.toContain('mnc93.mcc505');

    const three = renderAll({ label: '3', mcc: '310', mnc: '410' });
    expect(three['scscf.cfg']).toContain('mnc410.mcc310');
  });

  /**
   * This was a real defect, found by the leak property above and fixed in the
   * same series of changes.
   *
   * `scscfIncludeCfg()` used to derive `RO_MNC`/`RO_MCC` from `readMccMnc()`,
   * which read the PLMN out of the HOST's `mme.yaml` and fell back to a
   * hardcoded 001/01 when that file could not be read. So changing the PLMN in
   * the UI left the Ro charging fields on the old one -- ONE FILE NAMING TWO
   * DIFFERENT PLMNs -- and on any deployment that was not 001-01, an
   * unreadable `mme.yaml` produced the wrong charging PLMN with no error.
   *
   * mcc/mnc are now required parameters and the generator reads nothing from
   * disk, so the output is a function of its inputs alone. These assertions
   * are what the old pinned test said should become true.
   */
  test('the Ro MCC/MNC follow the caller, not the host mme.yaml', () => {
    const roOf = (mcc: string, mnc: string): { mnc?: string; mcc?: string } => {
      const cfg = scscfIncludeCfg({
        scscfIp: '127.0.1.2', scscfPort: 6060, mcc, mnc,
        imsDomain: imsDomainOf({ label: '', mcc, mnc }),
        voiceCharging: { ocsOriginHost: `ocs.${epcDomainOf({ label: '', mcc, mnc })}` },
      });
      return {
        mnc: /#!define RO_MNC "(\d+)"/.exec(cfg)?.[1],
        mcc: /#!define RO_MCC "(\d+)"/.exec(cfg)?.[1],
      };
    };
    // A PLMN that is NOT this host's: previously these came back 01/001.
    expect(roOf('310', '410')).toEqual({ mnc: '410', mcc: '310' });
    // This deployment's own, which is also the old hardcoded fallback -- so it
    // is the one case that cannot distinguish fixed from broken. Kept because
    // it is the value the golden master pins.
    expect(roOf('001', '01')).toEqual({ mnc: '01', mcc: '001' });
    // Width rules are independent: the FQDN pads the MNC to three, the Ro
    // field to two, and a 3-digit MNC is untouched by either.
    expect(roOf('001', '1')).toEqual({ mnc: '01', mcc: '001' });
  });

});

describe('changing an address changes every place that depends on it', () => {
  // Same property for the other class of UI input. A hardcoded address is the
  // same bug as a hardcoded PLMN and just as invisible in a passing build.
  const render = (ip: string): Record<string, string> => {
    const ims = imsDomainOf(SCENARIOS[0]);
    const epc = epcDomainOf(SCENARIOS[0]);
    return {
      'scscf.cfg': scscfIncludeCfg({ scscfIp: ip, scscfPort: 6060, imsDomain: ims, mcc: '001', mnc: '01' }),
      'icscf.cfg': icscfIncludeCfg({ icscfIp: ip, icscfPort: 4060, imsDomain: ims }),
      'smsc.cfg': smscIncludeCfg({ smscIp: ip, imsDomain: ims }),
      'pcscf.cfg': pcscfIncludeCfg({
        pcscfIp: ip, pcscfPort: 5060, imsDomain: ims, epcDomain: epc, http2N5Available: false,
      }),
      'icscf.xml': icscfDiameterXml({ icscfIp: ip, imsDomain: ims }),
      'scscf.xml': scscfDiameterXml({ scscfIp: ip, imsDomain: ims }),
      'pcscf.xml': pcscfDiameterXml({
        pcscfIp: ip, imsDomain: ims, pcrfFqdn: `pcrf.${epc}`, pcrfPort: 3868,
      }),
    };
  };

  test('the configured address appears, and the previous one does not', () => {
    const OLD = '127.0.1.2';
    const NEW = '198.51.100.7';
    const rendered = render(NEW);
    for (const [file, content] of Object.entries(rendered)) {
      expect(`${file}: ${content}`).toContain(NEW);
      expect(`${file}: ${content}`).not.toContain(OLD);
    }
  });
});
