import { reflectorCounterDelta, reflectorPacketRate } from '../twamp-reflector-history';
import { buildReflectorSample, BuildReflectorSampleInput } from '../twamp-reflector-monitor';
import { ServerConnectionEntry } from '../twamp-runner';

// The reflector history sampler's arithmetic, executed rather than reviewed.
// Every rule here is one an operator reads directly off a graph and cannot
// sanity-check: a wrong reset rule invents a traffic spike, a wrong peer-key
// rule splits one radio into several clients, and a wrong "unknown vs zero"
// rule reports a device as idle when it was never measured at all.

const light = (peerIp: string, peerPort: string, lastSeenMs?: number, packetCount?: number): ServerConnectionEntry => ({
  peerIp, peerPort, localAddr: '', protocol: 'light', lastSeenMs, packetCount,
});
const full = (peerIp: string, peerPort: string): ServerConnectionEntry => ({
  peerIp, peerPort, localAddr: '10.0.1.175:862', protocol: 'full',
});

function build(partial: Partial<BuildReflectorSampleInput> = {}) {
  return buildReflectorSample({
    timestampMs: 1_700_000_000_000,
    serviceActive: true,
    enableFull: false,
    enableLight: true,
    full: [],
    light: [],
    counters: {},
    prevCounters: {},
    elapsedMs: 30_000,
    ...partial,
  });
}

describe('reflectorCounterDelta', () => {
  test('the first reading for a peer has no baseline, so the delta is unknown', () => {
    // Not 0: zero would claim "this peer reflected nothing in this interval",
    // which is a measurement. There simply was no previous reading.
    expect(reflectorCounterDelta(undefined, 2527)).toBeUndefined();
  });

  test('a normal increment is the difference', () => {
    expect(reflectorCounterDelta(2500, 2527)).toBe(27);
  });

  test('an unchanged counter is a real zero, not unknown', () => {
    expect(reflectorCounterDelta(2527, 2527)).toBe(0);
  });

  test('a counter that went backwards is a reflector restart, so the current value IS the interval', () => {
    // Prometheus counter semantics. Dropping it would erase every packet that
    // arrived after a restart — precisely the window being investigated when
    // someone looks at a restart on the graph.
    expect(reflectorCounterDelta(2527, 12)).toBe(12);
  });

  test('a reset to exactly zero yields zero, not the pre-restart value', () => {
    expect(reflectorCounterDelta(2527, 0)).toBe(0);
  });

  test('unusable readings are unknown rather than guessed', () => {
    expect(reflectorCounterDelta(NaN, 10)).toBeUndefined();
    expect(reflectorCounterDelta(10, NaN)).toBeUndefined();
    expect(reflectorCounterDelta(10, -1)).toBeUndefined();
  });
});

describe('reflectorPacketRate', () => {
  test('divides the delta by the real elapsed interval', () => {
    expect(reflectorPacketRate(300, 30_000)).toBe(10);
  });

  test('an unknown delta stays unknown', () => {
    expect(reflectorPacketRate(undefined, 30_000)).toBeUndefined();
  });

  test('a degenerate interval yields no rate instead of a divide-by-almost-zero spike', () => {
    // Two samples landing in the same instant (a clock step, a doubled tick)
    // would otherwise produce an enormous packets/sec that dominates the
    // chart's Y axis and hides every real value.
    expect(reflectorPacketRate(300, 0)).toBeUndefined();
    expect(reflectorPacketRate(300, 100)).toBeUndefined();
    expect(reflectorPacketRate(300, 499)).toBeUndefined();
    expect(reflectorPacketRate(300, 500)).toBe(600);
  });

  test('a zero delta is a real zero rate', () => {
    expect(reflectorPacketRate(0, 30_000)).toBe(0);
  });
});

describe('buildReflectorSample', () => {
  test('counts distinct devices, not sessions, and keeps the session count per device', () => {
    // One radio opening a second ephemeral source port is still one client.
    // twamp-server.go's own lightPeers map is keyed by ip:port, so the raw
    // readings genuinely contain both.
    const s = build({
      light: [light('10.0.2.48', '5001'), light('10.0.2.48', '5002'), light('10.0.2.17', '5001')],
    });
    expect(s.lightPeers).toBe(2);
    expect(s.totalPeers).toBe(2);
    expect(s.peers).toHaveLength(2);
    expect(s.peers.find(p => p.peerIp === '10.0.2.48')!.sessions).toBe(2);
    expect(s.peers.find(p => p.peerIp === '10.0.2.17')!.sessions).toBe(1);
  });

  test('counts full and light peers separately and sums them', () => {
    const s = build({
      enableFull: true,
      full: [full('10.0.2.100', '44000')],
      light: [light('10.0.2.48', '5001'), light('10.0.2.17', '5001')],
    });
    expect(s.fullPeers).toBe(1);
    expect(s.lightPeers).toBe(2);
    expect(s.totalPeers).toBe(3);
  });

  test('a full-protocol peer carries presence but no throughput fields', () => {
    // The library exposes only aggregate session/packet counters for the full
    // path, so there is nothing per-peer to report. Left undefined rather
    // than zero, which the table would render as "0 packets".
    const s = build({ enableFull: true, full: [full('10.0.2.100', '44000')] });
    const peer = s.peers[0];
    expect(peer.sessions).toBe(1);
    expect(peer.packetsReflected).toBeUndefined();
    expect(peer.packetsDelta).toBeUndefined();
    expect(peer.packetsPerSec).toBeUndefined();
  });

  test('derives each light peer rate from its own counter and sums the total', () => {
    const s = build({
      light: [light('10.0.2.48', '5001'), light('10.0.2.17', '5001')],
      prevCounters: { '10.0.2.48': 1000, '10.0.2.17': 2000 },
      counters: { '10.0.2.48': 1300, '10.0.2.17': 2150 },
      elapsedMs: 30_000,
    });
    const a = s.peers.find(p => p.peerIp === '10.0.2.48')!;
    const b = s.peers.find(p => p.peerIp === '10.0.2.17')!;
    expect(a.packetsDelta).toBe(300);
    expect(a.packetsPerSec).toBe(10);
    expect(b.packetsDelta).toBe(150);
    expect(b.packetsPerSec).toBe(5);
    expect(s.packetsPerSec).toBe(15);
  });

  test('the first tick records the counter but no rate, and no aggregate rate at all', () => {
    const s = build({
      light: [light('10.0.2.48', '5001')],
      counters: { '10.0.2.48': 2527 },
      prevCounters: {},
      elapsedMs: 0,
    });
    expect(s.peers[0].packetsReflected).toBe(2527);
    expect(s.peers[0].packetsDelta).toBeUndefined();
    // undefined, not 0 — queryReflectorSeries excludes it from the average
    // rather than averaging in a zero that reads as "the reflector went idle".
    expect(s.packetsPerSec).toBeUndefined();
  });

  test('a peer present in the counters but not currently testing is not a connected client', () => {
    // twamp-server.go never deletes a peer's Prometheus counter, it only
    // drops the peer from its 5-minute "active" view. Presence must follow
    // the active view, or a radio that stopped testing hours ago would still
    // be graphed as connected forever.
    const s = build({ light: [], counters: { '10.0.2.48': 2527 }, prevCounters: { '10.0.2.48': 2000 } });
    expect(s.peers).toHaveLength(0);
    expect(s.lightPeers).toBe(0);
    expect(s.packetsPerSec).toBeUndefined();
  });

  test('keeps the newest lastSeen across a device’s sessions', () => {
    const s = build({ light: [light('10.0.2.48', '5001', 1000), light('10.0.2.48', '5002', 9000)] });
    expect(s.peers[0].lastSeenMs).toBe(9000);
  });

  test('a stopped reflector still produces a real sample, not an absence', () => {
    // This is the whole reason one document is written per tick rather than
    // one per peer: downtime has to be graphable.
    const s = build({ serviceActive: false, light: [], counters: {} });
    expect(s.serviceActive).toBe(false);
    expect(s.totalPeers).toBe(0);
    expect(s.peers).toEqual([]);
    expect(s.timestamp).toBeInstanceOf(Date);
  });

  test('records which protocols the reflector was configured for', () => {
    // Without this the "Full (TCP)" series cannot be told apart from a
    // listener that was switched off for the whole range.
    const s = build({ enableFull: true, enableLight: false });
    expect(s.enableFull).toBe(true);
    expect(s.enableLight).toBe(false);
  });
});
