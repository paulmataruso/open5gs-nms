import { AutoConfigUseCase } from '../auto-config';

// Regression guard for a real clobber bug found in the 2026-10-10 readiness
// audit. Both the preview and apply paths of the Auto-Configuration Wizard
// used to rewrite amf.plmn_support as:
//
//   raw.amf.plmn_support = input.plmn5g.map(plmn => ({
//     plmn_id: { mcc, mnc }, s_nssai: [{ sst: 1 }],
//   }));
//
// which DESTROYS every operator-configured Slice Differentiator. On the live
// deployment that meant silently deleting {sst:1, sd:'19cde1'} -- the slice the
// 5G radios actually use, and the one nssf.yaml and smf.yaml both declare -- so
// a single Auto-Config run would have broken 5G service outright, and a fresh
// install would never have produced that slice at all.
//
// buildPlmnSupport() is a pure function, so it is tested directly rather than
// through the whole use case; reaching it needs no repositories or logger.
const buildPlmnSupport = (
  existing: unknown,
  plmns: Array<{ mcc: string; mnc: string }>,
) =>
  (AutoConfigUseCase.prototype as unknown as {
    buildPlmnSupport: (e: unknown, p: Array<{ mcc: string; mnc: string }>) => Array<{
      plmn_id: { mcc: string; mnc: string };
      s_nssai: unknown;
    }>;
  }).buildPlmnSupport(existing, plmns);

describe('AutoConfigUseCase.buildPlmnSupport', () => {
  it('preserves a configured Slice Differentiator instead of hardcoding sst:1', () => {
    const existing = [
      { plmn_id: { mcc: '001', mnc: '01' }, s_nssai: [{ sst: 1, sd: '19cde1' }, { sst: 1 }] },
    ];
    const out = buildPlmnSupport(existing, [{ mcc: '001', mnc: '01' }]);

    expect(out).toHaveLength(1);
    expect(out[0].s_nssai).toEqual([{ sst: 1, sd: '19cde1' }, { sst: 1 }]);
  });

  it('matches mcc/mnc numerically, since Open5GS yields them as both numbers and zero-padded strings', () => {
    // amf.yaml parses `mcc: 001` as the number 1; the wizard passes '001'.
    const existing = [
      { plmn_id: { mcc: 1, mnc: 1 }, s_nssai: [{ sst: 1, sd: '19cde1' }] },
    ];
    const out = buildPlmnSupport(existing, [{ mcc: '001', mnc: '01' }]);

    expect(out[0].s_nssai).toEqual([{ sst: 1, sd: '19cde1' }]);
  });

  it('rewrites the plmn_id while keeping the slice list', () => {
    const existing = [
      { plmn_id: { mcc: 1, mnc: 1 }, s_nssai: [{ sst: 1, sd: '19cde1' }] },
    ];
    const out = buildPlmnSupport(existing, [{ mcc: '999', mnc: '70' }]);

    // No existing entry for 999/70, so it is a genuinely new PLMN -> default.
    expect(out[0].plmn_id).toEqual({ mcc: '999', mnc: '70' });
    expect(out[0].s_nssai).toEqual([{ sst: 1 }]);
  });

  it('defaults to sst:1 for a PLMN with no existing entry', () => {
    const out = buildPlmnSupport([], [{ mcc: '001', mnc: '01' }]);
    expect(out[0].s_nssai).toEqual([{ sst: 1 }]);
  });

  it('tolerates a missing/garbage existing value without throwing', () => {
    for (const bad of [undefined, null, {}, 'nonsense', 0]) {
      const out = buildPlmnSupport(bad, [{ mcc: '001', mnc: '01' }]);
      expect(out[0].s_nssai).toEqual([{ sst: 1 }]);
    }
  });

  it('ignores an existing entry whose s_nssai is empty, rather than emitting an empty slice list', () => {
    // An empty slice list would make AMF advertise a PLMN with no slices at
    // all, which is worse than the default.
    const existing = [{ plmn_id: { mcc: 1, mnc: 1 }, s_nssai: [] }];
    const out = buildPlmnSupport(existing, [{ mcc: '001', mnc: '01' }]);
    expect(out[0].s_nssai).toEqual([{ sst: 1 }]);
  });

  it('handles multiple PLMNs, preserving each ones own slices independently', () => {
    const existing = [
      { plmn_id: { mcc: 1, mnc: 1 }, s_nssai: [{ sst: 1, sd: '19cde1' }] },
      { plmn_id: { mcc: 999, mnc: 70 }, s_nssai: [{ sst: 2 }] },
    ];
    const out = buildPlmnSupport(existing, [
      { mcc: '001', mnc: '01' },
      { mcc: '999', mnc: '70' },
    ]);

    expect(out[0].s_nssai).toEqual([{ sst: 1, sd: '19cde1' }]);
    expect(out[1].s_nssai).toEqual([{ sst: 2 }]);
  });
});
