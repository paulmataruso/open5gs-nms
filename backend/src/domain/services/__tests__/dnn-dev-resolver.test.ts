// Regression coverage for the smf.yaml<->upf.yaml dnn/dev join, extracted from
// subscriber-management.ts's resolveDnnDevMap() (#28) once tun-management.ts (#29)
// needed the identical join for a second, independent purpose.
import { resolveDnnDevPairs } from '../dnn-dev-resolver';

describe('resolveDnnDevPairs', () => {
  test('matches by upf.yaml\'s own dnn field when present', () => {
    const smf = [{ dnn: 'internet', subnet: '10.45.0.0/16' }];
    const upf = [{ dnn: 'internet', subnet: '10.45.0.0/24', dev: 'ogstun' }];
    expect(resolveDnnDevPairs(smf, upf)).toEqual([
      { dnn: 'internet', dev: 'ogstun', subnet: '10.45.0.0/16' },
    ]);
  });

  test('falls back to exact subnet match when upf.yaml has no dnn field', () => {
    const smf = [{ dnn: 'video.example.com', subnet: '203.0.113.0/24' }];
    const upf = [{ subnet: '203.0.113.0/24', dev: 'video' }]; // no dnn key at all
    expect(resolveDnnDevPairs(smf, upf)).toEqual([
      { dnn: 'video.example.com', dev: 'video', subnet: '203.0.113.0/24' },
    ]);
  });

  test('falls back to IPv4 CIDR overlap when SMF/UPF declare different prefix lengths', () => {
    const smf = [{ dnn: 'internet', subnet: '10.45.0.0/16' }];
    const upf = [{ subnet: '10.45.0.0/24', dev: 'ogstun' }]; // no dnn, narrower prefix
    expect(resolveDnnDevPairs(smf, upf)).toEqual([
      { dnn: 'internet', dev: 'ogstun', subnet: '10.45.0.0/16' },
    ]);
  });

  test('calls onUnresolved and omits the entry when no UPF session matches by dnn or subnet', () => {
    const onUnresolved = jest.fn();
    const smf = [{ dnn: 'orphan', subnet: '192.0.2.0/24' }];
    const upf = [{ dnn: 'internet', subnet: '10.45.0.0/24', dev: 'ogstun' }];
    expect(resolveDnnDevPairs(smf, upf, onUnresolved)).toEqual([]);
    expect(onUnresolved).toHaveBeenCalledWith('orphan', '192.0.2.0/24');
  });

  test('multiple DNNs on separate custom-named TUN devices resolve independently (issue #28\'s exact scenario)', () => {
    const smf = [
      { dnn: 'internet', subnet: '10.45.0.0/16', gateway: '10.45.0.1' },
      { dnn: 'ptt.example.com', subnet: '198.51.100.0/24', gateway: '198.51.100.1' },
      { dnn: 'video.example.com', subnet: '203.0.113.0/24', gateway: '203.0.113.1' },
      { dnn: 'surveillance.example.net', subnet: '192.0.2.0/24', gateway: '192.0.2.1' },
    ];
    const upf = [
      { subnet: '10.45.0.0/24', gateway: '10.45.0.1', dev: 'ogstun' },
      { subnet: '198.51.100.0/24', gateway: '198.51.100.1', dev: 'ptt' },
      { subnet: '203.0.113.0/24', gateway: '203.0.113.1', dev: 'video' },
      { subnet: '192.0.2.0/24', gateway: '192.0.2.1', dev: 'surveillance' },
    ];
    const pairs = resolveDnnDevPairs(smf, upf);
    const map = new Map(pairs.map((p) => [p.dnn, p.dev]));
    expect(map.get('internet')).toBe('ogstun');
    expect(map.get('ptt.example.com')).toBe('ptt');
    expect(map.get('video.example.com')).toBe('video');
    expect(map.get('surveillance.example.net')).toBe('surveillance');
  });

  test('empty inputs return an empty array without throwing', () => {
    expect(resolveDnnDevPairs([], [])).toEqual([]);
    expect(resolveDnnDevPairs(undefined as any, undefined as any)).toEqual([]);
  });
});
