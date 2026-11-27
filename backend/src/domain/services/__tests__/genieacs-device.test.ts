import { acsNodeAt, acsValueAt, acsValueWithTimeAt, AcsDevice } from '../genieacs-device';

/**
 * The dotted-path walk over a GenieACS device document, extracted from
 * acs-device-ip.ts and sercomm-rf-precondition.ts (which each had their own
 * copy, both typed `Record<string, any>` with an `any` cursor).
 *
 * The behaviour that is NOT a straight move is `_value` narrowing: the old
 * copies did `String(node._value).trim()`, so a path that resolved to a
 * CONTAINER node rather than a leaf produced the literal text
 * "[object Object]" and carried on into an IPv4 check or straight into an
 * operator-facing status string. It is now reported absent. Scalars —
 * string, number, boolean — stringify exactly as before, so every well-formed
 * reading is unchanged.
 */

/** `Device.IP.Interface.1.IPv4Address.1.IPAddress`, as GenieACS nests it. */
const device: AcsDevice = {
  Device: {
    IP: {
      Interface: {
        '1': {
          IPv4Address: {
            '1': {
              IPAddress: { _value: ' 10.0.2.151 ', _timestamp: '2026-11-27T10:00:00.000Z' },
            },
          },
        },
      },
    },
    ManagementServer: {
      ConnectionRequestURL: {
        _value: 'http://172.16.0.31:7547/abc',
        _timestamp: '2026-11-27T10:18:00.000Z',
      },
    },
  },
};

const IP_PATH = 'Device.IP.Interface.1.IPv4Address.1.IPAddress';

describe('acsNodeAt', () => {
  it('resolves a numeric path segment, which GenieACS stores as a string key', () => {
    const node = acsNodeAt(device, IP_PATH);
    expect(node?._value).toBe(' 10.0.2.151 ');
  });

  it('returns undefined for a path that does not resolve', () => {
    expect(acsNodeAt(device, 'Device.Nope.Missing')).toBeUndefined();
    expect(acsNodeAt(device, 'Device.IP.Interface.9.IPv4Address')).toBeUndefined();
  });

  it('returns undefined rather than throwing when a scalar sits mid-path', () => {
    // A device that has not reported a subtree, or has reported a leaf where
    // this code expected a container.
    const d: AcsDevice = { Device: { IP: 'not-an-object' } };
    expect(acsNodeAt(d, 'Device.IP.Interface.1')).toBeUndefined();
  });

  it('returns undefined for a null mid-path and for a null leaf', () => {
    const d: AcsDevice = { Device: { IP: null, Other: { Leaf: null } } };
    expect(acsNodeAt(d, 'Device.IP.Interface')).toBeUndefined();
    expect(acsNodeAt(d, 'Device.Other.Leaf')).toBeUndefined();
  });
});

describe('acsValueAt', () => {
  it('trims the cached value', () => {
    expect(acsValueAt(device, IP_PATH)).toBe('10.0.2.151');
  });

  it('returns null for an absent path or an absent _value', () => {
    expect(acsValueAt(device, 'Device.Nope')).toBeNull();
    expect(acsValueAt({ A: { B: { _timestamp: 'x' } } }, 'A.B')).toBeNull();
    expect(acsValueAt({ A: { B: { _value: null } } }, 'A.B')).toBeNull();
    expect(acsValueAt({ A: { B: { _value: undefined } } }, 'A.B')).toBeNull();
  });

  it('stringifies a numeric or boolean value exactly as before', () => {
    // TR-069 ints and booleans are normal readings, not malformed ones: the
    // Sercomm GPS parameters are integer millionths of a degree, and
    // AdminState arrives as 1/0 or true/false depending on firmware.
    expect(acsValueAt({ A: { B: { _value: 0 } } }, 'A.B')).toBe('0');
    expect(acsValueAt({ A: { B: { _value: 37774929 } } }, 'A.B')).toBe('37774929');
    expect(acsValueAt({ A: { B: { _value: true } } }, 'A.B')).toBe('true');
    expect(acsValueAt({ A: { B: { _value: false } } }, 'A.B')).toBe('false');
  });

  it('reports a container or array value as absent, not as "[object Object]"', () => {
    // The behaviour change. Previously these became "[object Object]" and
    // "1,2", either of which is a non-empty string an operator could see.
    expect(acsValueAt({ A: { B: { _value: { nested: 1 } } } }, 'A.B')).toBeNull();
    expect(acsValueAt({ A: { B: { _value: [1, 2] } } }, 'A.B')).toBeNull();
  });

  it('reports a non-finite number as absent', () => {
    expect(acsValueAt({ A: { B: { _value: NaN } } }, 'A.B')).toBeNull();
    expect(acsValueAt({ A: { B: { _value: Infinity } } }, 'A.B')).toBeNull();
  });

  it('keeps an empty string as an empty string, not as absent', () => {
    // Callers distinguish "reported nothing" from "not reporting at all" —
    // sercomm-rf-precondition's sasStatus does `?? ''` on exactly this.
    expect(acsValueAt({ A: { B: { _value: '   ' } } }, 'A.B')).toBe('');
  });
});

describe('acsValueWithTimeAt', () => {
  it('parses _timestamp to epoch milliseconds', () => {
    const got = acsValueWithTimeAt(device, IP_PATH);
    expect(got).toEqual({
      value: '10.0.2.151',
      at: Date.parse('2026-11-27T10:00:00.000Z'),
    });
  });

  it('is 0 for a missing or unparseable timestamp, so it loses every comparison', () => {
    // 0 rather than NaN deliberately: NaN makes every >= comparison false,
    // which would silently hand the win to whichever side was tested second.
    expect(acsValueWithTimeAt({ A: { B: { _value: 'x' } } }, 'A.B')).toEqual({ value: 'x', at: 0 });
    expect(acsValueWithTimeAt({ A: { B: { _value: 'x', _timestamp: 'junk' } } }, 'A.B'))
      .toEqual({ value: 'x', at: 0 });
    expect(acsValueWithTimeAt({ A: { B: { _value: 'x', _timestamp: 12345 } } }, 'A.B'))
      .toEqual({ value: 'x', at: 0 });
  });

  it('returns null when there is no value, regardless of the timestamp', () => {
    expect(acsValueWithTimeAt({ A: { B: { _timestamp: '2026-11-27T10:00:00.000Z' } } }, 'A.B'))
      .toBeNull();
  });

  it('orders two real readings by freshness', () => {
    // The whole reason the timestamp is carried: ConnectionRequestURL is
    // re-reported on every Inform while the cached interface address is not,
    // so the fresher one is the device's real current address.
    const direct = acsValueWithTimeAt(device, IP_PATH);
    const cru = acsValueWithTimeAt(device, 'Device.ManagementServer.ConnectionRequestURL');
    expect(direct).not.toBeNull();
    expect(cru).not.toBeNull();
    expect(cru!.at).toBeGreaterThan(direct!.at);
  });
});
