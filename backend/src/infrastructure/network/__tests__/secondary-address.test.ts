import { neighbourAnswered, arpingSawReply } from '../secondary-address';

describe('neighbourAnswered', () => {
  it('reports answered for a real REACHABLE neighbour', () => {
    // Captured live from this network: 172.16.0.100 is a third-party device,
    // which is exactly the address this feature must refuse to take.
    expect(neighbourAnswered('172.16.0.100 dev ens18 lladdr 00:02:99:1c:30:f4 REACHABLE')).toBe(true);
  });

  it('reports answered for STALE, DELAY and PROBE — a host replied at some point', () => {
    for (const state of ['STALE', 'DELAY', 'PROBE', 'PERMANENT']) {
      expect(neighbourAnswered(`10.0.0.5 dev eth0 lladdr aa:bb:cc:dd:ee:ff ${state}`)).toBe(true);
    }
  });

  it('reports NOT answered for FAILED — the kernel asked and got nothing', () => {
    // This is the real evidence an address is free, so misreading it as
    // answered would make every free address look occupied.
    expect(neighbourAnswered('10.0.0.5 dev eth0 FAILED')).toBe(false);
  });

  it('reports NOT answered for INCOMPLETE', () => {
    expect(neighbourAnswered('10.0.0.5 dev eth0  INCOMPLETE')).toBe(false);
  });

  it('reports NOT answered for an INCOMPLETE entry that still carries an lladdr', () => {
    // A stale lladdr can linger on an entry the kernel has since given up on;
    // the state word is what decides, not the presence of an address.
    expect(neighbourAnswered('10.0.0.5 dev eth0 lladdr aa:bb:cc:dd:ee:ff INCOMPLETE')).toBe(false);
  });

  it('reports NOT answered for empty output — no entry at all', () => {
    expect(neighbourAnswered('')).toBe(false);
    expect(neighbourAnswered('   \n ')).toBe(false);
  });

  it('requires a real MAC, not just the word lladdr', () => {
    expect(neighbourAnswered('10.0.0.5 dev eth0 lladdr REACHABLE')).toBe(false);
  });

  it('accepts an uppercase MAC', () => {
    expect(neighbourAnswered('10.0.0.5 dev eth0 lladdr AA:BB:CC:DD:EE:FF REACHABLE')).toBe(true);
  });
});

describe('arpingSawReply', () => {
  it('reports a reply when a host answers duplicate-address detection', () => {
    expect(arpingSawReply(
      'ARPING 10.0.0.5 from 0.0.0.0 eth0\n' +
      'Unicast reply from 10.0.0.5 [AA:BB:CC:DD:EE:FF]  0.700ms\n' +
      'Sent 2 probes (2 broadcast(s))\nReceived 1 response(s)\n',
    )).toBe(true);
  });

  it('reports no reply when nothing answered', () => {
    expect(arpingSawReply(
      'ARPING 10.0.0.5 from 0.0.0.0 eth0\nSent 2 probes (2 broadcast(s))\nReceived 0 response(s)\n',
    )).toBe(false);
  });

  it('prefers the explicit zero-count over a stray match elsewhere', () => {
    // "Received 0 response(s)" must win even though the header line mentions
    // the address -- otherwise a free address reads as taken and the run
    // skips addresses it could have used.
    expect(arpingSawReply('ARPING 10.0.0.5\nSent 2 probes\nReceived 0 reply\n')).toBe(false);
  });

  it('handles the singular and plural forms both ways', () => {
    expect(arpingSawReply('Received 1 reply\n')).toBe(true);
    expect(arpingSawReply('Received 2 replies\n')).toBe(true);
    expect(arpingSawReply('Received 0 replies\n')).toBe(false);
  });

  it('reports no reply for empty output rather than guessing', () => {
    expect(arpingSawReply('')).toBe(false);
  });

  it('reports a reply on the unicast line alone, with no summary count', () => {
    expect(arpingSawReply('Unicast reply from 10.0.0.5 [AA:BB:CC:DD:EE:FF]  0.7ms\n')).toBe(true);
  });
});

describe('arpingSawReply — real output captured live on this network', () => {
  // Exact bytes from `arping -D -c 2 -w 2 -I eth0 <ip>` on Ubuntu 24.04,
  // against a known-occupied and a known-free address.
  const OCCUPIED =
    'ARPING 172.16.0.100 from 0.0.0.0 eth0\n' +
    'Unicast reply from 172.16.0.100 [00:02:99:1C:30:F4] for 172.16.0.100 [00:02:99:1C:30:F4] 0.911ms\n' +
    'Sent 1 probes (1 broadcast(s))\n' +
    'Received 1 response(s)\n';
  const FREE =
    'ARPING 172.16.0.121 from 0.0.0.0 eth0\n' +
    'Sent 2 probes (2 broadcast(s))\n' +
    'Received 0 response(s)\n';

  it('reads a real duplicate as taken', () => {
    expect(arpingSawReply(OCCUPIED)).toBe(true);
  });

  it('reads a real free address as free', () => {
    expect(arpingSawReply(FREE)).toBe(false);
  });

  it('handles the doubled address form arping prints for -D', () => {
    // The -D line names the address TWICE ("from X [mac] for X [mac]"), which
    // a regex written against the plain `arping` output would not expect.
    expect(OCCUPIED).toMatch(/for 172\.16\.0\.100/);
    expect(arpingSawReply(OCCUPIED)).toBe(true);
  });

  it('is the only verdict source, because arping -D INVERTS its exit code', () => {
    // Confirmed live: exit 1 for an occupied address, exit 0 for a free one.
    // So exit status must never be used as the signal -- an occupied address
    // takes the error path, and its stdout is what carries the answer. This
    // test exists to stop anyone "simplifying" to an exit-code check, which
    // would report every occupied address as free.
    expect(arpingSawReply(OCCUPIED)).toBe(true);
    expect(arpingSawReply(FREE)).toBe(false);
  });
});

import { parseNetplanAddresses } from '../secondary-address';
import { netplanDropIn } from '../../../domain/services/autoconfig-apply';

describe('parseNetplanAddresses', () => {
  it('round-trips what netplanDropIn writes', () => {
    // This is how a run interrupted before the manifest still knows which
    // addresses are ours.
    const addrs = ['172.16.0.101', '172.16.0.102', '172.16.0.120'];
    expect(parseNetplanAddresses(netplanDropIn('eth0', addrs, 24))).toEqual(addrs);
  });

  it('reads an unquoted form too, in case netplan rewrites the file', () => {
    expect(parseNetplanAddresses('      - 10.0.0.5/24\n')).toEqual(['10.0.0.5']);
  });

  it('ignores the interface name and other keys', () => {
    const out = parseNetplanAddresses(netplanDropIn('ens18', ['10.0.0.5'], 25));
    expect(out).toEqual(['10.0.0.5']);
  });

  it('returns nothing for an empty or unrelated file', () => {
    expect(parseNetplanAddresses('')).toEqual([]);
    expect(parseNetplanAddresses('network:\n  version: 2\n')).toEqual([]);
  });

  it('does not pick up a bare list item that is not an address', () => {
    expect(parseNetplanAddresses('      - 8.8.8.8\n      - "not/an/address"\n')).toEqual([]);
  });

  it('handles a large set without missing any', () => {
    const addrs = Array.from({ length: 24 }, (_, i) => `172.16.0.${100 + i}`);
    expect(parseNetplanAddresses(netplanDropIn('eth0', addrs, 24))).toHaveLength(24);
  });
});
