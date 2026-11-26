import { AutoConfigUseCase } from '../auto-config';

/**
 * Auto-Config must never invent an identity field it was not given.
 *
 * The 2026-10-10 readiness audit found this exact clobber in `amf.plmn_support`
 * (a hardcoded `s_nssai: [{ sst: 1 }]` destroying every configured slice) and
 * fixed it with buildPlmnSupport(). The three identity lists sitting beside it
 * kept the same defect until 2026-11-26:
 *
 *   amf.guami   amf_id hardcoded `{ region: 2, set: 1 }` -> real region/set
 *               overwritten, `pointer` dropped. The GUAMI is part of the
 *               5G-S-TMSI, so this invalidates every UE's temporary identity.
 *   amf.tai     `tac: plmn.tac ?? 1` -> an existing TAC replaced by 1, and a
 *   mme.tai     list-valued `tac: [1, 2]` collapsed to one value.
 *   mme.gummei  mme_gid/mme_code `?? 2`/`?? 1` -> part of the GUTI, same class.
 *
 * It survived because THIS deployment happens to run region 2 / set 1 /
 * gid 2 / code 1 / tac 1 — precisely the hardcoded defaults.
 */
interface Internals {
  buildGuami(existing: unknown, plmns: Array<{ mcc: string; mnc: string }>): Array<Record<string, unknown>>;
  buildTaiList(
    existing: unknown,
    plmns: Array<{ mcc: string; mnc: string; tac?: number }>,
  ): Array<{ plmn_id: unknown; tac: number | number[] }>;
  buildGummei(
    existing: unknown,
    plmns: Array<{ mcc: string; mnc: string; mme_gid?: number; mme_code?: number }>,
  ): Array<{ plmn_id: unknown; mme_gid: number; mme_code: number }>;
  buildPlmnSupport(existing: unknown, plmns: Array<{ mcc: string; mnc: string }>): Array<Record<string, unknown>>;
}

const uc = new AutoConfigUseCase(
  {} as never, {} as never, {} as never,
  { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never,
  '/tmp',
);
const internals = uc as unknown as Internals;
const PLMN = [{ mcc: '001', mnc: '01' }];

describe('buildGuami preserves the operator amf_id', () => {
  it('keeps a non-default region and set', () => {
    const existing = [{ plmn_id: { mcc: '001', mnc: '01' }, amf_id: { region: 200, set: 42 } }];
    expect(internals.buildGuami(existing, PLMN)[0].amf_id).toEqual({ region: 200, set: 42 });
  });

  it('keeps `pointer`, which the old code dropped entirely', () => {
    const existing = [{ plmn_id: { mcc: '001', mnc: '01' }, amf_id: { region: 2, set: 1, pointer: 5 } }];
    expect(internals.buildGuami(existing, PLMN)[0].amf_id).toEqual({ region: 2, set: 1, pointer: 5 });
  });

  it('defaults only when the PLMN has no prior entry', () => {
    expect(internals.buildGuami([], PLMN)[0].amf_id).toEqual({ region: 2, set: 1 });
    expect(internals.buildGuami(undefined, PLMN)[0].amf_id).toEqual({ region: 2, set: 1 });
  });

  it('matches the right entry when several PLMNs are configured', () => {
    const existing = [
      { plmn_id: { mcc: '001', mnc: '01' }, amf_id: { region: 10, set: 11 } },
      { plmn_id: { mcc: '310', mnc: '260' }, amf_id: { region: 20, set: 21 } },
    ];
    const out = internals.buildGuami(existing, [{ mcc: '310', mnc: '260' }, { mcc: '001', mnc: '01' }]);
    expect(out[0].amf_id).toEqual({ region: 20, set: 21 });
    expect(out[1].amf_id).toEqual({ region: 10, set: 11 });
  });
});

describe('buildTaiList preserves the operator tac', () => {
  it('keeps an existing scalar tac when the input gives none', () => {
    const existing = [{ plmn_id: { mcc: '001', mnc: '01' }, tac: 7777 }];
    expect(internals.buildTaiList(existing, PLMN)[0].tac).toBe(7777);
  });

  it('keeps a LIST-valued tac instead of collapsing it', () => {
    const existing = [{ plmn_id: { mcc: '001', mnc: '01' }, tac: [1, 2, 3] }];
    expect(internals.buildTaiList(existing, PLMN)[0].tac).toEqual([1, 2, 3]);
  });

  it('lets an explicit input tac win over what is on disk', () => {
    const existing = [{ plmn_id: { mcc: '001', mnc: '01' }, tac: 7777 }];
    expect(internals.buildTaiList(existing, [{ mcc: '001', mnc: '01', tac: 42 }])[0].tac).toBe(42);
  });

  it('falls back to 1 only when neither side has a tac', () => {
    expect(internals.buildTaiList([], PLMN)[0].tac).toBe(1);
  });

  it('ignores a malformed prior tac rather than writing it back', () => {
    const existing = [{ plmn_id: { mcc: '001', mnc: '01' }, tac: 'nonsense' }];
    expect(internals.buildTaiList(existing, PLMN)[0].tac).toBe(1);
  });
});

describe('buildGummei preserves the operator GUMMEI', () => {
  it('keeps a non-default mme_gid and mme_code', () => {
    const existing = [{ plmn_id: { mcc: '001', mnc: '01' }, mme_gid: 500, mme_code: 9 }];
    const out = internals.buildGummei(existing, PLMN)[0];
    expect(out.mme_gid).toBe(500);
    expect(out.mme_code).toBe(9);
  });

  it('lets explicit input win', () => {
    const existing = [{ plmn_id: { mcc: '001', mnc: '01' }, mme_gid: 500, mme_code: 9 }];
    const out = internals.buildGummei(existing, [{ mcc: '001', mnc: '01', mme_gid: 3, mme_code: 4 }])[0];
    expect(out.mme_gid).toBe(3);
    expect(out.mme_code).toBe(4);
  });

  it('defaults only when nothing is configured', () => {
    const out = internals.buildGummei([], PLMN)[0];
    expect(out.mme_gid).toBe(2);
    expect(out.mme_code).toBe(1);
  });
});

describe('PLMN matching is width-sensitive', () => {
  it('does NOT treat MNC 070 and MNC 70 as the same network', () => {
    // These are different PLMNs (TS 23.003). The old `Number(a) === Number(b)`
    // matched them, so one network's identity config could be preserved and
    // rewritten under the other.
    const existing = [{ plmn_id: { mcc: '001', mnc: '070' }, amf_id: { region: 99, set: 98 } }];
    expect(internals.buildGuami(existing, [{ mcc: '001', mnc: '70' }])[0].amf_id)
      .toEqual({ region: 2, set: 1 });
  });

  it('still matches the identical form', () => {
    const existing = [{ plmn_id: { mcc: '001', mnc: '070' }, amf_id: { region: 99, set: 98 } }];
    expect(internals.buildGuami(existing, [{ mcc: '001', mnc: '070' }])[0].amf_id)
      .toEqual({ region: 99, set: 98 });
  });
});

describe('buildPlmnSupport still preserves slices (2026-10-10 regression)', () => {
  it('keeps a configured s_nssai list', () => {
    const existing = [{ plmn_id: { mcc: '001', mnc: '01' }, s_nssai: [{ sst: 1, sd: '000019' }, { sst: 2 }] }];
    expect(internals.buildPlmnSupport(existing, PLMN)[0].s_nssai)
      .toEqual([{ sst: 1, sd: '000019' }, { sst: 2 }]);
  });

  it('defaults to sst 1 when none is configured', () => {
    expect(internals.buildPlmnSupport([], PLMN)[0].s_nssai).toEqual([{ sst: 1 }]);
  });
});

describe('setServerBind preserves other endpoint fields', () => {
  const bind = (existing: unknown, b: { dev: string } | { address: string }): Array<Record<string, unknown>> =>
    (uc as unknown as {
      setServerBind(e: unknown, b: unknown): Array<Record<string, unknown>>;
    }).setServerBind(existing, b);

  it('keeps advertise when changing the address', () => {
    // Open5GS supports advertise on gtpu so a UPF behind NAT announces its
    // public address. Replacing the array dropped it silently.
    const out = bind([{ address: '10.0.1.156', advertise: 'upf.example.org' }], { address: '10.0.2.50' });
    expect(out).toEqual([{ address: '10.0.2.50', advertise: 'upf.example.org' }]);
  });

  it('keeps a non-default port', () => {
    expect(bind([{ address: '10.0.1.175', port: 36413 }], { address: '10.0.9.9' }))
      .toEqual([{ address: '10.0.9.9', port: 36413 }]);
  });

  it('drops address when switching to dev, so no stale sibling remains', () => {
    expect(bind([{ address: '10.0.1.155', port: 38412 }], { dev: 'ens18' }))
      .toEqual([{ dev: 'ens18', port: 38412 }]);
  });

  it('drops dev when switching to address', () => {
    expect(bind([{ dev: 'ens18', advertise: 'amf.example.org' }], { address: '10.0.1.155' }))
      .toEqual([{ address: '10.0.1.155', advertise: 'amf.example.org' }]);
  });

  it('works from an absent or empty endpoint', () => {
    expect(bind(undefined, { address: '1.2.3.4' })).toEqual([{ address: '1.2.3.4' }]);
    expect(bind([], { address: '1.2.3.4' })).toEqual([{ address: '1.2.3.4' }]);
  });

  it('collapses to one entry, which is Auto-Config\'s documented scope', () => {
    expect(bind([{ address: 'a' }, { address: 'b' }], { address: 'c' })).toEqual([{ address: 'c' }]);
  });
});
