import { PcapUseCase } from '../pcap';

/**
 * NF capture descriptors, where a list-valued address produced a filter
 * dumpcap rejects.
 *
 * `address` is scalar-or-list throughout Open5GS, but `rawServer()` declared it
 * `address?: string` while reading from an `any`, so an array flowed straight
 * into `PcapHostPort.addr` (also typed `string`). Nothing complained, and
 * downstream `hp.addr.includes('/')` resolved to Array.prototype.includes and
 * returned false, so the filter came out as:
 *
 *   host 127.0.0.4,10.0.0.4 and udp port 2152
 *
 * which dumpcap rejects outright, exiting immediately -- the same
 * near-zero-duration-capture symptom this file's own net/host comment
 * documents for a different cause. `sbiPorts()` 25 lines above already
 * normalised to the first element; its neighbours did not.
 */
function makeUseCase(configs: unknown): PcapUseCase {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return new PcapUseCase(
    {} as never,
    { loadAll: () => Promise.resolve(configs) } as never,
    logger as never,
  );
}

describe('buildNfDescriptors address normalisation', () => {
  it('takes the first address when mme s1ap/gtpc are list-valued', async () => {
    const uc = makeUseCase({
      mme: { rawYaml: { mme: {
        s1ap: { server: [{ address: ['10.0.1.175', '10.9.9.9'] }] },
        gtpc: { server: [{ address: ['127.0.0.2', '10.8.8.8'] }] },
      } } },
    });
    const descs = await uc.buildNfDescriptors();
    const mme = descs.find(d => d.nf === 'mme');
    expect(mme).toBeDefined();
    const addrs = mme!.hostPorts.map(h => h.addr);
    expect(addrs).toContain('10.0.1.175');
    expect(addrs).toContain('127.0.0.2');
    // The bug: an array reaching addr would stringify with a comma.
    for (const a of addrs) expect(a).not.toContain(',');
  });

  it('takes the first address for a list-valued upf gtpu', async () => {
    const uc = makeUseCase({
      upf: { gtpu: { addr: ['10.0.1.156', '10.7.7.7'] }, pfcp: { addr: '127.0.0.7' } },
    });
    const descs = await uc.buildNfDescriptors();
    const upf = descs.find(d => d.nf === 'upf');
    expect(upf!.hostPorts.find(h => h.role === 'GTP-U')!.addr).toBe('10.0.1.156');
  });

  it('handles a scalar address unchanged', async () => {
    const uc = makeUseCase({
      mme: { rawYaml: { mme: { s1ap: { server: [{ address: '10.0.1.175' }] } } } },
    });
    const descs = await uc.buildNfDescriptors();
    expect(descs.find(d => d.nf === 'mme')!.hostPorts[0].addr).toBe('10.0.1.175');
  });

  it('honours a configured port instead of only the default', async () => {
    const uc = makeUseCase({
      mme: { rawYaml: { mme: { s1ap: { server: [{ address: '10.0.1.175', port: 36413 }] } } } },
    });
    const descs = await uc.buildNfDescriptors();
    expect(descs.find(d => d.nf === 'mme')!.hostPorts[0].port).toBe(36413);
  });

  it('falls back to the standard port when none is set', async () => {
    const uc = makeUseCase({
      mme: { rawYaml: { mme: { s1ap: { server: [{ address: '10.0.1.175' }] } } } },
    });
    const descs = await uc.buildNfDescriptors();
    expect(descs.find(d => d.nf === 'mme')!.hostPorts[0].port).toBe(36412);
  });

  it('skips an endpoint whose address is an empty string', async () => {
    const uc = makeUseCase({
      mme: { rawYaml: { mme: { s1ap: { server: [{ address: '' }] } } } },
    });
    const descs = await uc.buildNfDescriptors();
    expect(descs.find(d => d.nf === 'mme')).toBeUndefined();
  });

  it('reads the SMF GTP-C address from the parsed config, not a loopback default', async () => {
    // Regression guard for the #82 parseGtpc fix, from this consumer's side.
    const uc = makeUseCase({
      smf: { sbi: { addr: '127.0.0.4', port: 7777 }, gtpc: { addr: '127.0.0.4' }, pfcp: { addr: '127.0.0.4' } },
    });
    const descs = await uc.buildNfDescriptors();
    const gtpc = descs.find(d => d.nf === 'smf')!.hostPorts.find(h => h.role === 'GTP-C');
    expect(gtpc!.addr).toBe('127.0.0.4');
  });
});
