import pino from 'pino';
import { CallCaptureScope, PcapUseCase } from '../pcap';

// buildScope is private, and reached here with a cast rather than being made
// public: widening production visibility purely for a test would invite a
// caller to bypass start()'s own validation. For 'call' mode it touches
// neither the host executor nor the config repo, so stubs suffice.
const uc = () => new PcapUseCase({} as never, {} as never, pino({ level: 'silent' }));
const build = (scope: CallCaptureScope) =>
  (uc() as unknown as { buildScope: (s: unknown) => Promise<{ bpf: string; description: string }> })
    .buildScope({ mode: 'call', call: scope });

describe("pcap 'call' scope", () => {
  it('emits host-only clauses, with no proto/port narrowing', async () => {
    // A Call Debug capture is explicitly FULL: SIP and RTP and Diameter and
    // GTP-U. Reusing the NF-descriptor clause shape (`host X and udp port N`)
    // would silently defeat that, because the IMS descriptor carries only
    // rtpPortMin -- one port out of a 10,000-port media range.
    const r = await build({ hosts: ['10.46.0.70', '10.0.1.178'], nets: [], description: 'd' });
    expect(r.bpf).toBe('host 10.46.0.70 or host 10.0.1.178');
    expect(r.bpf).not.toMatch(/port/);
  });

  it('uses the net primitive for a CIDR, never host', async () => {
    // dumpcap rejects the WHOLE filter with "Mask syntax for networks only"
    // if a CIDR is given to `host`, and then exits immediately -- which
    // presents as a capture that ran for no time at all.
    const r = await build({ hosts: [], nets: ['10.46.0.0/24'], description: 'd' });
    expect(r.bpf).toBe('net 10.46.0.0/24');
  });

  it('combines pool and host clauses when only one party resolved', async () => {
    const r = await build({ hosts: ['10.0.1.178'], nets: ['10.46.0.0/24'], description: 'd' });
    expect(r.bpf).toBe('net 10.46.0.0/24 or host 10.0.1.178');
  });

  it('refuses to build an empty filter rather than capturing everything', async () => {
    // An empty bpf makes start() omit -f entirely, which captures the whole
    // host. For a feature whose purpose is bounded capture that is the worst
    // possible fallback, so it must be an error.
    await expect(build({ hosts: [], nets: [], description: 'd' })).rejects.toThrow(/Nothing to scope/);
  });

  it('passes the caller-composed description through unchanged', async () => {
    const r = await build({ hosts: ['10.46.0.70'], nets: [], description: 'Call debug: 15550000001 → UE 10.46.0.70' });
    expect(r.description).toBe('Call debug: 15550000001 → UE 10.46.0.70');
  });
});
