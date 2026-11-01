import { findSmfPoolsWiderThanUpf } from '../dnn-dev-resolver';

describe('findSmfPoolsWiderThanUpf', () => {
  test('reports the real 2026-11-01 condition: SMF /16 against a UPF /24', () => {
    const found = findSmfPoolsWiderThanUpf(
      [{ dnn: 'internet', subnet: '10.45.0.0/16' }],
      [{ dnn: 'internet', subnet: '10.45.0.0/24', dev: 'ogstun' }],
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      dnn: 'internet',
      dev: 'ogstun',
      smfSubnet: '10.45.0.0/16',
      upfSubnet: '10.45.0.0/24',
      // 65534 assignable in the /16, only the /24's 254 of them routable.
      unroutableAddresses: 65280,
    });
  });

  test('stays silent on the harmless direction — a NARROWER SMF pool', () => {
    expect(findSmfPoolsWiderThanUpf(
      [{ dnn: 'internet', subnet: '10.45.0.0/24' }],
      [{ dnn: 'internet', subnet: '10.45.0.0/16', dev: 'ogstun' }],
    )).toEqual([]);
  });

  test('stays silent when the pools agree (the fixed state)', () => {
    expect(findSmfPoolsWiderThanUpf(
      [{ dnn: 'internet', subnet: '10.45.0.0/24' }, { dnn: 'ims', subnet: '10.46.0.0/24' }],
      [{ dnn: 'internet', subnet: '10.45.0.0/24', dev: 'ogstun' },
       { dnn: 'ims', subnet: '10.46.0.0/24', dev: 'ogstun2' }],
    )).toEqual([]);
  });

  test('matches by subnet overlap when upf.yaml carries no dnn key', () => {
    const found = findSmfPoolsWiderThanUpf(
      [{ dnn: 'internet', subnet: '10.45.0.0/16' }],
      [{ subnet: '10.45.0.0/24', dev: 'ogstun' }],
    );
    expect(found).toHaveLength(1);
    expect(found[0].dev).toBe('ogstun');
  });

  test('ignores IPv6 pools, whose /48 delegations are not comparable this way', () => {
    expect(findSmfPoolsWiderThanUpf(
      [{ dnn: 'internet', subnet: '2001:db8:cafe::/48' }],
      [{ dnn: 'internet', subnet: '2001:db8:cafe::/64', dev: 'ogstun' }],
    )).toEqual([]);
  });

  test('ignores disjoint pools — a different fault, not a width problem', () => {
    expect(findSmfPoolsWiderThanUpf(
      [{ dnn: 'internet', subnet: '10.45.0.0/16' }],
      [{ dnn: 'other', subnet: '192.0.2.0/24', dev: 'ogstun' }],
    )).toEqual([]);
  });

  test('handles a first octet >= 128 without signed-int corruption (ip-utils regression)', () => {
    const found = findSmfPoolsWiderThanUpf(
      [{ dnn: 'internet', subnet: '192.168.0.0/16' }],
      [{ dnn: 'internet', subnet: '192.168.0.0/24', dev: 'ogstun' }],
    );
    expect(found).toHaveLength(1);
    expect(found[0].unroutableAddresses).toBe(65280);
  });
});
