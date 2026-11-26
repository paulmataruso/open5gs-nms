import { AutoConfigUseCase } from '../auto-config';

/**
 * Session-pool handling, where two real defects lived.
 *
 * 1. The entries were REBUILT as `{subnet, gateway, dnn, dev}`, so any other
 *    key on a pool was deleted. Found against this deployment's own smf.yaml,
 *    whose `ims` pool carries `dns: [10.0.1.178]` — an apply touching session
 *    pools would have sent IMS-APN UEs to the global resolver instead of the
 *    IMS one. CLAUDE.md pattern #2: clone and mutate, never rebuild.
 * 2. With pools requested but none supplied and both legacy subnets blank, the
 *    result was `session: []`, DELETING every UE address pool. With no pool
 *    the UPF cannot allocate a UE address, so a successful-looking apply was a
 *    total data-plane outage.
 *
 * Preview also lacked apply's DNN-first ordering, so the approved diff did not
 * match what was written.
 */
interface Internals {
  resolveSessionPools(input: unknown): Array<Record<string, unknown>>;
  toSessionEntries(existing: unknown, pools: Array<Record<string, unknown>>): Array<Record<string, unknown>>;
  dnnFirst(entries: Array<Record<string, unknown>>): Array<Record<string, unknown>>;
}

const uc = new AutoConfigUseCase(
  {} as never, {} as never, {} as never,
  { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never,
  '/tmp',
);
const internals = uc as unknown as Internals;

describe('toSessionEntries preserves unmodelled pool keys', () => {
  it('keeps a per-session dns list, the live case', () => {
    const onDisk = [{ subnet: '10.46.0.0/24', gateway: '10.46.0.1', dnn: 'ims', dns: ['10.0.1.178'] }];
    const out = internals.toSessionEntries(onDisk, [
      { subnet: '10.46.0.0/24', gateway: '10.46.0.1', dnn: 'ims', dev: '' },
    ]);
    expect(out).toEqual([{ subnet: '10.46.0.0/24', gateway: '10.46.0.1', dnn: 'ims', dns: ['10.0.1.178'] }]);
  });

  it('keeps any other hand-added key', () => {
    const onDisk = [{ subnet: '10.45.0.0/24', operator_note: 'do not remove' }];
    const out = internals.toSessionEntries(onDisk, [{ subnet: '10.45.0.0/24', dnn: 'internet' }]);
    expect(out[0].operator_note).toBe('do not remove');
    expect(out[0].dnn).toBe('internet');
  });

  it('matches the on-disk entry by subnet', () => {
    const onDisk = [
      { subnet: '10.45.0.0/24', dns: ['1.1.1.1'] },
      { subnet: '10.46.0.0/24', dns: ['10.0.1.178'] },
    ];
    const out = internals.toSessionEntries(onDisk, [{ subnet: '10.46.0.0/24', dnn: 'ims' }]);
    expect(out).toEqual([{ subnet: '10.46.0.0/24', dnn: 'ims', dns: ['10.0.1.178'] }]);
  });

  it('still CLEARS a modelled field the operator removed', () => {
    // The four fields the NMS owns must remain fully controllable.
    const onDisk = [{ subnet: '10.45.0.0/24', gateway: '10.45.0.1', dev: 'ogstun', dns: ['1.1.1.1'] }];
    const out = internals.toSessionEntries(onDisk, [{ subnet: '10.45.0.0/24' }]);
    expect(out[0].gateway).toBeUndefined();
    expect(out[0].dev).toBeUndefined();
    expect(out[0].dns).toEqual(['1.1.1.1']); // not ours to clear
  });

  it('builds a fresh entry for a pool with no on-disk counterpart', () => {
    const out = internals.toSessionEntries([], [{ subnet: '10.47.0.0/24', gateway: '10.47.0.1' }]);
    expect(out).toEqual([{ subnet: '10.47.0.0/24', gateway: '10.47.0.1' }]);
  });
});

describe('resolveSessionPools refuses to wipe every pool', () => {
  it('throws when pools are requested but none are supplied', () => {
    expect(() => internals.resolveSessionPools({ sessionPools: [] }))
      .toThrow(/refusing to write an empty session list/i);
  });

  it('throws when the legacy subnets are blank too', () => {
    expect(() => internals.resolveSessionPools({
      sessionPools: [], sessionPoolIPv4Subnet: '', sessionPoolIPv6Subnet: '',
    })).toThrow(/refusing/i);
  });

  it('returns the explicit pools when given', () => {
    const pools = [{ subnet: '10.45.0.0/24' }];
    expect(internals.resolveSessionPools({ sessionPools: pools })).toEqual(pools);
  });

  it('falls back to the legacy pair, dropping blanks', () => {
    const out = internals.resolveSessionPools({
      sessionPools: [],
      sessionPoolIPv4Subnet: '10.45.0.0/24', sessionPoolIPv4Gateway: '10.45.0.1',
      sessionPoolIPv6Subnet: '', sessionPoolIPv6Gateway: '',
    });
    expect(out).toHaveLength(1);
    expect(out[0].subnet).toBe('10.45.0.0/24');
  });
});

describe('dnnFirst ordering', () => {
  it('puts DNN-specific pools before default ones, so they are not shadowed', () => {
    const out = internals.dnnFirst([
      { subnet: 'a' }, { subnet: 'b', dnn: 'ims' }, { subnet: 'c' }, { subnet: 'd', dnn: 'internet' },
    ]);
    expect(out.map(e => e.subnet)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('is a no-op when every pool names a DNN', () => {
    const entries = [{ subnet: 'a', dnn: 'x' }, { subnet: 'b', dnn: 'y' }];
    expect(internals.dnnFirst(entries)).toEqual(entries);
  });
});
