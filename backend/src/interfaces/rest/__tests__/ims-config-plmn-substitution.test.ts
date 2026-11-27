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
      scscfIp: '127.0.1.2', scscfPort: 6060, imsDomain: ims, additionalDomains: [],
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
   * KNOWN DEFECT, pinned deliberately rather than hidden.
   *
   * `scscfIncludeCfg()` is NOT a pure function of its parameters. It takes
   * `imsDomain` from the caller -- which the UI derives from the PLMN the
   * operator set -- but derives `RO_MNC`/`RO_MCC` from `readMccMnc()`, which
   * reads the PLMN out of the HOST's `mme.yaml` and silently falls back to a
   * hardcoded 001/01 if that file cannot be read.
   *
   * Two consequences, both matching the symptom this suite exists for:
   *
   *  1. Change the PLMN in the UI and the Ro charging fields keep the old one,
   *     producing ONE FILE CONTAINING TWO DIFFERENT PLMNs. It is syntactically
   *     valid and points partly at a network that does not exist.
   *  2. On a deployment whose PLMN is not 001-01, an unreadable `mme.yaml`
   *     yields `RO_MNC "01"`/`RO_MCC "001"` with no error at all.
   *
   * This test asserts the CURRENT behaviour so the defect is recorded and so
   * the fix -- passing mcc/mnc in as parameters, making the generator pure --
   * shows up here as a deliberate change rather than a surprise. When that
   * lands, this test should assert the parameter is honoured.
   *
   * It also explains why the golden master passes in CI, where `mme.yaml` does
   * not exist: the fallback happens to equal this deployment's real PLMN. That
   * is a coincidence, not a design.
   */
  test('DEFECT: the Ro MNC/MCC ignore the caller and read the host mme.yaml', () => {
    const cfg = scscfIncludeCfg({
      scscfIp: '127.0.1.2', scscfPort: 6060,
      imsDomain: imsDomainOf({ label: '', mcc: '310', mnc: '410' }),
      voiceCharging: { ocsOriginHost: `ocs.${epcDomainOf({ label: '', mcc: '310', mnc: '410' })}` },
    });
    // The domain follows the caller's PLMN...
    expect(cfg).toContain('mnc410.mcc310');
    // ...while the Ro fields do not, which is the defect. They carry whatever
    // the host mme.yaml says, or the 001/01 fallback when it is absent.
    const roMnc = /#!define RO_MNC "(\d+)"/.exec(cfg)?.[1];
    const roMcc = /#!define RO_MCC "(\d+)"/.exec(cfg)?.[1];
    expect(roMnc).toBeDefined();
    expect(roMcc).toBeDefined();
    // Not the caller's values -- that is the whole point.
    expect(roMnc).not.toBe('410');
    expect(roMcc).not.toBe('310');
  });

});

describe('changing an address changes every place that depends on it', () => {
  // Same property for the other class of UI input. A hardcoded address is the
  // same bug as a hardcoded PLMN and just as invisible in a passing build.
  const render = (ip: string): Record<string, string> => {
    const ims = imsDomainOf(SCENARIOS[0]);
    const epc = epcDomainOf(SCENARIOS[0]);
    return {
      'scscf.cfg': scscfIncludeCfg({ scscfIp: ip, scscfPort: 6060, imsDomain: ims }),
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
