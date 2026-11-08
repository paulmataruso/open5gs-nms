import {
  parseHostAddresses,
  findUnbindableAddresses,
  unbindableAddressMessage,
} from '../auto-config-preflight';

// Real `ip -o addr show` output from the clean-host test VM, trimmed.
const IP_OUTPUT = [
  '1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever',
  '1: lo    inet6 ::1/128 scope host \\       valid_lft forever preferred_lft forever',
  '2: eth0    inet 172.16.0.171/24 metric 100 brd 172.16.0.255 scope global dynamic eth0\\       valid_lft 42s',
  '3: eth1    inet 192.168.253.20/24 brd 192.168.253.255 scope global eth1\\       valid_lft forever',
  '6: ogstun    inet 10.45.0.1/16 scope global ogstun\\       valid_lft forever preferred_lft forever',
  '7: ogstun2    inet 10.46.0.1/24 scope global ogstun2\\       valid_lft forever preferred_lft forever',
].join('\n');

describe('parseHostAddresses', () => {
  it('extracts every v4 and v6 address without the prefix length', () => {
    expect(parseHostAddresses(IP_OUTPUT)).toEqual([
      '127.0.0.1', '::1', '172.16.0.171', '192.168.253.20', '10.45.0.1', '10.46.0.1',
    ]);
  });

  it('returns an empty list for empty input rather than throwing', () => {
    expect(parseHostAddresses('')).toEqual([]);
  });

  it('deduplicates an address that appears on two lines', () => {
    const dup = `${IP_OUTPUT}\n9: extra    inet 172.16.0.171/24 scope global extra`;
    expect(parseHostAddresses(dup).filter(a => a === '172.16.0.171')).toHaveLength(1);
  });
});

describe('findUnbindableAddresses', () => {
  const host = parseHostAddresses(IP_OUTPUT);

  it('accepts addresses the host actually holds', () => {
    expect(findUnbindableAddresses({
      s1mmeIP: '172.16.0.171', sgwuGtpIP: '172.16.0.171',
      amfNgapIP: '192.168.253.20', upfGtpIP: '192.168.253.20',
    }, host)).toEqual([]);
  });

  it('rejects the exact addresses that killed 4 NFs on the clean host', () => {
    // The real reproduction: these were written to the YAML and every NF
    // then aborted with "Cannot assign requested address".
    const bad = findUnbindableAddresses({
      s1mmeIP: '10.0.9.175', sgwuGtpIP: '10.0.9.176',
      amfNgapIP: '10.0.9.155', upfGtpIP: '10.0.9.156',
    }, host);
    expect(bad.map(b => b.address).sort()).toEqual(
      ['10.0.9.155', '10.0.9.156', '10.0.9.175', '10.0.9.176'],
    );
    // The field label matters — it is what the operator has to go and fix.
    expect(bad.find(b => b.address === '10.0.9.155')?.field).toBe('NGAP (AMF)');
  });

  it('always allows the whole of 127/8, which the kernel routes to lo', () => {
    // This project hands the loopback-only PFCP endpoints 127.0.0.4/.7, and
    // those never appear in `ip addr` — treating them as missing would
    // refuse every localUpfOnly deployment.
    expect(findUnbindableAddresses({
      smfPfcpIP: '127.0.0.4', localUpfPfcpIP: '127.0.0.7', sgwcPfcpIP: '127.0.0.3',
    }, host)).toEqual([]);
  });

  it('allows the wildcard and v6 loopback', () => {
    expect(findUnbindableAddresses(
      { s1mmeIP: '0.0.0.0', amfNgapIP: '::', upfGtpIP: '::1', sgwuGtpIP: '' }, host,
    )).toEqual([]);
  });

  it('skips interface-name bindings entirely', () => {
    // s1mmeDev/amfNgapDev name an interface, never an address, so there is
    // nothing to check — and the absent IP fields must not be flagged.
    expect(findUnbindableAddresses({
      s1mmeIP: undefined, amfNgapIP: undefined,
      sgwuGtpIP: '172.16.0.171', upfGtpIP: '192.168.253.20',
    } as never, host)).toEqual([]);
  });

  it('honours applyInterfaces=false — an unchecked card contributes nothing', () => {
    expect(findUnbindableAddresses({
      applyInterfaces: false,
      s1mmeIP: '10.0.9.175', sgwuGtpIP: '10.0.9.176',
      amfNgapIP: '10.0.9.155', upfGtpIP: '10.0.9.156',
    }, host)).toEqual([]);
  });

  it('honours applyPfcp=false', () => {
    expect(findUnbindableAddresses({
      applyPfcp: false, smfPfcpIP: '10.0.9.4', sgwcPfcpIP: '10.0.9.3',
    }, host)).toEqual([]);
  });

  it('treats an omitted toggle as applied, matching AutoConfigInput defaults', () => {
    // applyInterfaces is `input.applyInterfaces ?? true` in the use case, so
    // undefined must mean "checked" here too or the two disagree.
    expect(findUnbindableAddresses({ amfNgapIP: '10.0.9.155' }, host)).toHaveLength(1);
  });

  it('does NOT check remote SGW-U addresses, which live on another host', () => {
    const input = {
      sgwcPfcpIP: '172.16.0.171',
      remoteSgwus: [{ pfcpIP: '10.88.0.1', gtpuIP: '10.88.0.2' }],
    } as never;
    expect(findUnbindableAddresses(input, host)).toEqual([]);
  });

  it('does NOT check session pool gateways, which the apply assigns itself', () => {
    const input = {
      sessionPools: [{ subnet: '10.99.0.0/16', gateway: '10.99.0.1', dev: 'ogstun9' }],
      sessionPoolIPv4Gateway: '10.99.0.1',
    } as never;
    expect(findUnbindableAddresses(input, host)).toEqual([]);
  });

  it('reports nothing when the host list is empty but only loopbacks are asked for', () => {
    expect(findUnbindableAddresses({ smfPfcpIP: '127.0.0.4' }, [])).toEqual([]);
  });
});

describe('unbindableAddressMessage', () => {
  const host = parseHostAddresses(IP_OUTPUT);

  it('names the field, the address and what the host does have', () => {
    const bad = findUnbindableAddresses({ amfNgapIP: '10.0.9.155' }, host);
    const msg = unbindableAddressMessage(bad, host);
    expect(msg).toContain('NGAP (AMF) → 10.0.9.155');
    expect(msg).toContain('172.16.0.171');
    expect(msg).toContain('192.168.253.20');
  });

  it('omits loopbacks from the "this host holds" list, which are never the answer', () => {
    const bad = findUnbindableAddresses({ amfNgapIP: '10.0.9.155' }, host);
    const msg = unbindableAddressMessage(bad, host);
    expect(msg).not.toContain('127.0.0.1');
    expect(msg).not.toContain('::1');
  });

  it('omits link-local and unique-local noise, which buried the real list', () => {
    // Measured on the real test VM: 10 dummy interfaces plus eth0/eth1/docker0
    // produced ~15 fe80:: entries, making a ~2000-char message nobody reads.
    const noisy = [
      '172.16.0.171', 'fe80::be24:11ff:fefe:437f', '192.168.253.20',
      'fd00:1234::5', '169.254.1.1', '10.0.9.155',
    ];
    const msg = unbindableAddressMessage([{ field: 'NGAP (AMF)', address: '10.0.77.1' }], noisy);
    expect(msg).toContain('172.16.0.171');
    expect(msg).toContain('192.168.253.20');
    expect(msg).not.toContain('fe80::');
    expect(msg).not.toContain('fd00:');
    expect(msg).not.toContain('169.254.');
  });

  it('keeps a genuine global IPv6 address, which is a legitimate bind target', () => {
    const msg = unbindableAddressMessage(
      [{ field: 'NGAP (AMF)', address: '10.0.77.1' }],
      ['2602:f7e3:0:3:be24:11ff:fefe:437f', 'fe80::1'],
    );
    expect(msg).toContain('2602:f7e3:0:3:be24:11ff:fefe:437f');
    expect(msg).not.toContain('fe80::1');
  });

  it('says so explicitly when the host has no routable address at all', () => {
    const msg = unbindableAddressMessage(
      [{ field: 'NGAP (AMF)', address: '10.0.9.155' }], ['127.0.0.1'],
    );
    expect(msg).toContain('no non-loopback addresses');
  });

  it('points at how this deployment creates service addresses', () => {
    const msg = unbindableAddressMessage([{ field: 'UPF GTP-U', address: '10.0.9.156' }], host);
    expect(msg).toMatch(/L3 Routing/);
  });
});
