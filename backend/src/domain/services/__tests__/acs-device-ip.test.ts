import {
  resolveAcsDeviceIp, connectionRequestHost,
  ACS_CONNECTION_REQUEST_PARAM, ACS_DEVICE_IP_PARAM,
} from '../acs-device-ip';

// Builds the shape GenieACS's NBI really returns: every leaf is
// {_value, _timestamp}, and the two timestamps are the whole point.
function device(opts: {
  directIp?: string; directAt?: string;
  crUrl?: string; crAt?: string;
}): Record<string, any> {
  const d: Record<string, any> = {};
  const put = (dotPath: string, value: string, ts?: string) => {
    const parts = dotPath.split('.');
    let node = d;
    for (const p of parts.slice(0, -1)) node = (node[p] ??= {});
    node[parts[parts.length - 1]] = { _value: value, _timestamp: ts };
  };
  if (opts.directIp !== undefined) put(ACS_DEVICE_IP_PARAM, opts.directIp, opts.directAt);
  if (opts.crUrl !== undefined) put(ACS_CONNECTION_REQUEST_PARAM, opts.crUrl, opts.crAt);
  return d;
}

describe('connectionRequestHost', () => {
  test('pulls the IPv4 host out of a real ConnectionRequestURL', () => {
    expect(connectionRequestHost('http://172.16.0.31:7547/H4BLFH82HV2B4VHV')).toBe('172.16.0.31');
    expect(connectionRequestHost('https://10.0.2.151:7547/x')).toBe('10.0.2.151');
    expect(connectionRequestHost('http://10.0.2.151/')).toBe('10.0.2.151');
    expect(connectionRequestHost('http://10.0.2.151')).toBe('10.0.2.151');
  });

  test('a hostname is a valid URL but is not an answer to "what IP"', () => {
    expect(connectionRequestHost('http://enb-1.lab.local:7547/x')).toBe('');
  });

  test('rejects junk rather than inventing a host', () => {
    for (const bad of ['', 'not a url', '172.16.0.31:7547', 'http://', 'http://999.1.1.1:7547/x',
                       'http://10.0.2.01:7547/x']) {
      expect(connectionRequestHost(bad)).toBe('');
    }
  });
});

describe('resolveAcsDeviceIp', () => {
  test('the real case from this deployment: a stale cached address loses to the live one', () => {
    // Sercomm 2112CW5000195, captured live 2026-11-01. The cached interface
    // address was 18 minutes old and on a different subnet; the
    // ConnectionRequestURL timestamp equalled _lastInform.
    const r = resolveAcsDeviceIp(device({
      directIp: '10.0.2.151', directAt: '2026-11-01T17:49:03.788Z',
      crUrl: 'http://172.16.0.31:7547/V2R0R8N0X44BPJT2', crAt: '2026-11-01T18:07:22.620Z',
    }));
    expect(r.ip).toBe('172.16.0.31');
    expect(r.source).toBe('connection-request');
    expect(r.staleAlternative).toEqual({ ip: '10.0.2.151', source: 'device-ip', ageSeconds: 1099 });
  });

  test('agreement reports no stale alternative at all', () => {
    const r = resolveAcsDeviceIp(device({
      directIp: '172.16.0.62', directAt: '2026-10-28T03:12:26.897Z',
      crUrl: 'http://172.16.0.62:7547/ZJ4FJ88LJN4VVTZH', crAt: '2026-11-01T18:10:35.840Z',
    }));
    // Four days stale, but it happens to be right because the radio has not
    // moved — so there is nothing to flag.
    expect(r).toEqual({ ip: '172.16.0.62', source: 'connection-request' });
  });

  test('a device with no Device.IP subtree at all still resolves', () => {
    // The Sercomm NR SCE5164 on this host has no Device.IP.Interface.
    const r = resolveAcsDeviceIp(device({ crUrl: 'http://172.16.0.59:7547/F2XT0FJ24RN0268T', crAt: '2026-10-31T19:25:08.376Z' }));
    expect(r).toEqual({ ip: '172.16.0.59', source: 'connection-request' });
  });

  test('falls back to the cached address when the URL carries a hostname', () => {
    const r = resolveAcsDeviceIp(device({
      directIp: '10.0.2.151', directAt: '2026-11-01T17:49:03.788Z',
      crUrl: 'http://enb-1.lab.local:7547/x', crAt: '2026-11-01T18:07:22.620Z',
    }));
    expect(r).toEqual({ ip: '10.0.2.151', source: 'device-ip' });
  });

  test('a genuinely newer cached read beats the URL', () => {
    // What happens right after a Summon: the GPV re-read the interface address
    // seconds before the inform that re-reported the URL.
    const r = resolveAcsDeviceIp(device({
      directIp: '192.168.5.9', directAt: '2026-11-01T18:11:22.314Z',
      crUrl: 'http://172.16.0.31:7547/x', crAt: '2026-11-01T18:09:00.000Z',
    }));
    expect(r.ip).toBe('192.168.5.9');
    expect(r.source).toBe('device-ip');
    expect(r.staleAlternative).toEqual({ ip: '172.16.0.31', source: 'connection-request', ageSeconds: 142 });
  });

  test('a missing timestamp counts as the oldest possible read, never the newest', () => {
    const r = resolveAcsDeviceIp(device({
      directIp: '10.0.2.151',
      crUrl: 'http://172.16.0.31:7547/x', crAt: '2026-11-01T18:07:22.620Z',
    }));
    expect(r.ip).toBe('172.16.0.31');
    // And the other way round, so neither source gets a free pass.
    const r2 = resolveAcsDeviceIp(device({
      directIp: '10.0.2.151', directAt: '2026-11-01T18:07:22.620Z',
      crUrl: 'http://172.16.0.31:7547/x',
    }));
    expect(r2.ip).toBe('10.0.2.151');
  });

  test('an unparseable timestamp does not throw or win', () => {
    const r = resolveAcsDeviceIp(device({
      directIp: '10.0.2.151', directAt: 'not-a-date',
      crUrl: 'http://172.16.0.31:7547/x', crAt: '2026-11-01T18:07:22.620Z',
    }));
    expect(r.ip).toBe('172.16.0.31');
  });

  test('nothing usable reads as none rather than an empty-looking success', () => {
    expect(resolveAcsDeviceIp({})).toEqual({ ip: '', source: 'none' });
    expect(resolveAcsDeviceIp(device({ directIp: '', crUrl: '' }))).toEqual({ ip: '', source: 'none' });
    expect(resolveAcsDeviceIp(device({ directIp: '0' }))).toEqual({ ip: '', source: 'none' });
  });

  test('an empty or non-IPv4 cached value never displaces a good URL host', () => {
    for (const junk of ['', ' ', '0.0.0.0.0', 'n/a']) {
      const r = resolveAcsDeviceIp(device({
        directIp: junk, directAt: '2026-11-01T19:00:00.000Z',
        crUrl: 'http://172.16.0.31:7547/x', crAt: '2026-11-01T18:00:00.000Z',
      }));
      expect(r.ip).toBe('172.16.0.31');
    }
  });

  test('0.0.0.0 is a real dotted quad and is reported as read, not silently dropped', () => {
    // Deliberate: inventing a different answer would hide a genuinely
    // misconfigured interface. It only wins if it is actually fresher.
    const r = resolveAcsDeviceIp(device({ directIp: '0.0.0.0', directAt: '2026-11-01T19:00:00.000Z' }));
    expect(r).toEqual({ ip: '0.0.0.0', source: 'device-ip' });
  });
});
