import { buildCallFlow } from '../call-flow';
import { SipTraceDocument, SipTraceSource } from '../sip-trace-store';

// The deduplication here is the one piece of real logic in the flow builder,
// and it has two failure modes that look like success: collapsing genuine
// retransmissions (hiding the thing an engineer opened the trace to find), and
// failing to collapse the taps' duplicate views of one message (which is what
// made a 5-message call render as twenty arrows). Both are pinned below.

const PCSCF = '10.0.1.178';
const SCSCF = '127.0.1.2';
const UE_A = '10.46.0.70';
const UE_B = '10.46.0.73';

let seq = 0;
function msg(o: {
  source: SipTraceSource;
  t: number;
  src: string; sport?: number;
  dst: string; dport?: number;
  method?: string;
  status?: number;
  reason?: string;
  cseq?: number;
  cseqMethod?: string;
  callId?: string;
  fromUser?: string;
  toUser?: string;
  /** Message bytes; part of a message's identity, so tests can vary it. */
  raw?: string;
}): SipTraceDocument {
  return {
    callId: o.callId ?? 'call-1',
    timestamp: new Date(1760000000000 + o.t),
    source: o.source,
    captureAgentId: 0,
    srcIp: o.src, srcPort: o.sport ?? 5060,
    dstIp: o.dst, dstPort: o.dport ?? 5060,
    transport: 'udp',
    // Mongo stores an absent method as null, which is what a reply really
    // looks like on disk -- so model that, not a convenient `undefined`.
    method: o.method ?? (o.status !== undefined ? (null as unknown as undefined) : undefined),
    statusCode: o.status,
    statusReason: o.reason,
    cseqNumber: o.cseq ?? 1,
    cseqMethod: o.cseqMethod ?? o.method ?? 'INVITE',
    fromUser: o.fromUser,
    toUser: o.toUser,
    raw: o.raw ?? `${o.method ?? o.status} branch=fixed`,
    seq: seq++,
  };
}

describe('buildCallFlow deduplication', () => {
  it('merges the two taps that both saw one P-CSCF -> S-CSCF message', () => {
    // P-CSCF traces it on the way out, S-CSCF on the way in. One message.
    const flow = buildCallFlow([
      msg({ source: 'pcscf', t: 0, src: PCSCF, dst: SCSCF, method: 'INVITE' }),
      msg({ source: 'scscf', t: 2, src: PCSCF, dst: SCSCF, method: 'INVITE' }),
    ]);
    expect(flow.hops).toHaveLength(1);
    expect(flow.hops[0].sources.sort()).toEqual(['pcscf', 'scscf']);
    expect(flow.mergedDuplicates).toBe(1);
    // The sender's tap is the truer time: a message is sent before received.
    expect(flow.hops[0].timestamp.getTime() % 1000).toBe(0);
    // Both raw rows stay reachable, so the detail view can show either.
    expect(flow.hops[0].messageRefs).toHaveLength(2);
  });

  it('keeps a retransmission as its own hop', () => {
    const flow = buildCallFlow([
      msg({ source: 'pcscf', t: 0, src: UE_A, dst: PCSCF, method: 'INVITE' }),
      msg({ source: 'pcscf', t: 500, src: UE_A, dst: PCSCF, method: 'INVITE' }),
      msg({ source: 'pcscf', t: 1500, src: UE_A, dst: PCSCF, method: 'INVITE' }),
    ]);
    expect(flow.hops).toHaveLength(3);
    expect(flow.hops.map(h => h.retransmission)).toEqual([false, true, true]);
    expect(flow.mergedDuplicates).toBe(0);
  });

  it('merges per transmission, so retransmissions seen by two taps stay separate', () => {
    // The trap: collapsing by key alone gives 1 hop, treating each row
    // separately gives 4. The answer is 2 -- two transmissions, each seen twice.
    const flow = buildCallFlow([
      msg({ source: 'pcscf', t: 0, src: PCSCF, dst: SCSCF, method: 'INVITE' }),
      msg({ source: 'scscf', t: 1, src: PCSCF, dst: SCSCF, method: 'INVITE' }),
      msg({ source: 'pcscf', t: 500, src: PCSCF, dst: SCSCF, method: 'INVITE' }),
      msg({ source: 'scscf', t: 501, src: PCSCF, dst: SCSCF, method: 'INVITE' }),
    ]);
    expect(flow.hops).toHaveLength(2);
    expect(flow.hops[0].retransmission).toBe(false);
    expect(flow.hops[1].retransmission).toBe(true);
    expect(flow.hops.every(h => h.sources.length === 2)).toBe(true);
  });

  it('does not merge the same request on a different hop', () => {
    // UE->P-CSCF and P-CSCF->S-CSCF are the same SIP request but two real
    // messages on two wires; the hop structure is the point of the ladder.
    const flow = buildCallFlow([
      msg({ source: 'pcscf', t: 0, src: UE_A, dst: PCSCF, method: 'INVITE' }),
      msg({ source: 'pcscf', t: 3, src: PCSCF, dst: SCSCF, method: 'INVITE' }),
    ]);
    expect(flow.hops).toHaveLength(2);
    expect(flow.mergedDuplicates).toBe(0);
  });

  it('keeps the two legs of a UE-to-UE call apart instead of calling one a retransmission', () => {
    // The real bug this caught: in IMS one Call-ID crosses the same P-CSCF and
    // S-CSCF twice, once for the originating half and once for the
    // terminating half. Same method, same CSeq, same addresses, different Via
    // branch -- so they differ in bytes and must stay two hops, neither
    // flagged as a retransmission.
    const flow = buildCallFlow([
      msg({ source: 'pcscf', t: 18, src: SCSCF, dst: PCSCF, method: 'INVITE', raw: 'INVITE branch=orig' }),
      msg({ source: 'pcscf', t: 46, src: SCSCF, dst: PCSCF, method: 'INVITE', raw: 'INVITE branch=term' }),
    ]);
    expect(flow.hops).toHaveLength(2);
    expect(flow.hops.map(h => h.retransmission)).toEqual([false, false]);
    expect(flow.mergedDuplicates).toBe(0);
  });

  it('still treats a byte-identical repeat as a retransmission', () => {
    const flow = buildCallFlow([
      msg({ source: 'pcscf', t: 0, src: UE_A, dst: PCSCF, method: 'INVITE', raw: 'INVITE branch=z9' }),
      msg({ source: 'pcscf', t: 500, src: UE_A, dst: PCSCF, method: 'INVITE', raw: 'INVITE branch=z9' }),
    ]);
    expect(flow.hops).toHaveLength(2);
    expect(flow.hops.map(h => h.retransmission)).toEqual([false, true]);
  });

  it('does not merge a request with its reply', () => {
    const flow = buildCallFlow([
      msg({ source: 'pcscf', t: 0, src: UE_A, dst: PCSCF, method: 'INVITE' }),
      msg({ source: 'pcscf', t: 10, src: PCSCF, dst: UE_A, status: 100, reason: 'Trying' }),
    ]);
    expect(flow.hops).toHaveLength(2);
    expect(flow.hops[1].label).toBe('100 Trying');
    expect(flow.hops[1].cls).toBe('provisional');
  });
});

describe('buildCallFlow presentation', () => {
  it('labels CSCFs by role and UEs by their SIP user', () => {
    const flow = buildCallFlow(
      [
        msg({ source: 'pcscf', t: 0, src: UE_A, dst: PCSCF, method: 'INVITE', fromUser: '1001', toUser: '1002' }),
        msg({ source: 'scscf', t: 5, src: PCSCF, dst: SCSCF, method: 'INVITE', fromUser: '1001', toUser: '1002' }),
      ],
      { pcscfIp: PCSCF, scscfIp: SCSCF, icscfIp: '127.0.1.1' },
    );
    const byId = Object.fromEntries(flow.endpoints.map(e => [e.id, e]));
    expect(byId[`${PCSCF}:5060`].label).toBe('P-CSCF');
    expect(byId[`${SCSCF}:5060`].label).toBe('S-CSCF');
    expect(byId[`${UE_A}:5060`].label).toBe('UE 1001');
    // The address is always kept for the tooltip, even when the label hides it.
    expect(byId[`${PCSCF}:5060`].address).toBe(`${PCSCF}:5060`);
  });

  it('labels the caller\'s handset by the caller, even when only a reply reached it', () => {
    // Found on a real captured call: a reply's From/To still name the dialog's
    // parties, but it travels back TOWARDS the caller. Treating its
    // destination as the To party labelled the caller's own second socket with
    // the callee's number -- naming the wrong phone confidently.
    const flow = buildCallFlow(
      [
        msg({
          source: 'pcscf', t: 0, src: UE_A, sport: 63748, dst: PCSCF, dport: 6101,
          method: 'INVITE', fromUser: '15550000004', toUser: '15550000001',
        }),
        // The 183 comes back to the caller on a different socket.
        msg({
          source: 'pcscf', t: 282, src: PCSCF, sport: 6101, dst: UE_A, dport: 57892,
          status: 183, reason: 'Session Progress', fromUser: '15550000004', toUser: '15550000001',
        }),
      ],
      { pcscfIp: PCSCF },
    );
    const labels = flow.endpoints.filter(e => e.role === 'ue').map(e => e.label).sort();
    expect(labels).toEqual(['UE 15550000004:57892', 'UE 15550000004:63748']);
    expect(labels.some(l => l.includes('15550000001'))).toBe(false);
  });

  it('still labels the callee from the request that reached it', () => {
    const flow = buildCallFlow(
      [
        msg({
          source: 'pcscf', t: 0, src: PCSCF, dst: UE_B, dport: 41417,
          method: 'INVITE', fromUser: '15550000004', toUser: '15550000001',
        }),
      ],
      { pcscfIp: PCSCF },
    );
    expect(flow.endpoints.find(e => e.role === 'ue')!.label).toBe('UE 15550000001');
  });

  it('falls back to the address when the CSCF addresses are unknown', () => {
    // getCscfAddresses() returns {} if IMS state is unreadable; the ladder must
    // still render rather than mislabel every node as a UE with no hint.
    const flow = buildCallFlow([msg({ source: 'pcscf', t: 0, src: UE_A, dst: PCSCF, method: 'INVITE' })]);
    expect(flow.endpoints.map(e => e.label)).toEqual([`UE ${UE_A}`, `UE ${PCSCF}`]);
  });

  it('gives a shared label its port back, so two P-CSCF sockets are telling apart', () => {
    // P-CSCF really does appear twice: a UE-facing IPsec socket and a
    // network-facing one. Two columns both reading "P-CSCF" is unreadable.
    const flow = buildCallFlow(
      [
        msg({ source: 'pcscf', t: 0, src: UE_A, dst: PCSCF, dport: 6103, method: 'INVITE' }),
        msg({ source: 'pcscf', t: 5, src: PCSCF, sport: 5060, dst: SCSCF, method: 'INVITE' }),
      ],
      { pcscfIp: PCSCF, scscfIp: SCSCF },
    );
    const labels = flow.endpoints.filter(e => e.role === 'pcscf').map(e => e.label).sort();
    expect(labels).toEqual(['P-CSCF:5060', 'P-CSCF:6103']);
    // A role appearing once keeps the clean name.
    expect(flow.endpoints.find(e => e.role === 'scscf')!.label).toBe('S-CSCF');
  });

  it('orders endpoint columns by first appearance, like sngrep', () => {
    const flow = buildCallFlow(
      [
        msg({ source: 'pcscf', t: 0, src: UE_A, dst: PCSCF, method: 'INVITE' }),
        msg({ source: 'scscf', t: 5, src: PCSCF, dst: SCSCF, method: 'INVITE' }),
        msg({ source: 'pcscf', t: 9, src: PCSCF, dst: UE_B, method: 'INVITE' }),
      ],
      { pcscfIp: PCSCF, scscfIp: SCSCF },
    );
    expect(flow.endpoints.map(e => e.id)).toEqual([
      `${UE_A}:5060`, `${PCSCF}:5060`, `${SCSCF}:5060`, `${UE_B}:5060`,
    ]);
  });

  it('reports time deltas, which is where a stalled call shows up', () => {
    const flow = buildCallFlow([
      msg({ source: 'pcscf', t: 0, src: UE_A, dst: PCSCF, method: 'INVITE' }),
      msg({ source: 'pcscf', t: 120, src: PCSCF, dst: UE_A, status: 100 }),
      msg({ source: 'pcscf', t: 8120, src: PCSCF, dst: UE_A, status: 180 }),
    ]);
    expect(flow.hops.map(h => h.deltaMs)).toEqual([0, 120, 8000]);
    expect(flow.hops.map(h => h.offsetMs)).toEqual([0, 120, 8120]);
  });

  it('spans several dialogs when given them, keeping each hop attributed', () => {
    const flow = buildCallFlow([
      msg({ source: 'pcscf', t: 0, src: UE_A, dst: PCSCF, method: 'INVITE', callId: 'leg-a' }),
      msg({ source: 'pcscf', t: 50, src: PCSCF, dst: UE_B, method: 'INVITE', callId: 'leg-b' }),
    ]);
    expect(flow.dialogs).toEqual(['leg-a', 'leg-b']);
    expect(flow.hops.map(h => h.callId)).toEqual(['leg-a', 'leg-b']);
  });

  it('classifies reply ranges so the ladder can colour them', () => {
    const codes = [100, 180, 200, 302, 404, 503, 603];
    const flow = buildCallFlow(
      codes.map((status, i) => msg({ source: 'pcscf', t: i, src: PCSCF, dst: UE_A, status, cseq: i + 1 })),
    );
    expect(flow.hops.map(h => h.cls)).toEqual([
      'provisional', 'provisional', 'success', 'redirect', 'client-error', 'server-error', 'global-error',
    ]);
  });

  it('returns an empty flow rather than throwing on no messages', () => {
    const flow = buildCallFlow([]);
    expect(flow.hops).toEqual([]);
    expect(flow.endpoints).toEqual([]);
    expect(flow.startTime).toBeNull();
  });
});
