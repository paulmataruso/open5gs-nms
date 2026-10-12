import { parseHep3, HepParseError, HEP_CHUNK, HEP_PROTO_SIP } from '../hep-parser';

// Build real HEP3 datagrams byte by byte rather than asserting against a
// hand-written hex blob, so the fixtures stay readable and a format mistake
// shows up as a failing assertion instead of an unexplained blob diff.
function chunk(type: number, body: Buffer, vendor = 0): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt16BE(vendor, 0);
  head.writeUInt16BE(type, 2);
  head.writeUInt16BE(body.length + 6, 4);
  return Buffer.concat([head, body]);
}
const u8 = (n: number) => { const b = Buffer.alloc(1); b.writeUInt8(n, 0); return b; };
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; };
const ip4 = (s: string) => Buffer.from(s.split('.').map(Number));

function hep3(chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(6);
  head.write('HEP3', 0, 'ascii');
  head.writeUInt16BE(body.length + 6, 4);
  return Buffer.concat([head, body]);
}

const SIP = 'REGISTER sip:ims.mnc001.mcc001.3gppnetwork.org SIP/2.0\r\nCall-ID: abc123\r\n\r\n';

function fullPacket(overrides: Buffer[] = []): Buffer {
  return hep3([
    chunk(HEP_CHUNK.PROTOCOL_FAMILY, u8(2)),
    chunk(HEP_CHUNK.PROTOCOL_ID, u8(17)),
    chunk(HEP_CHUNK.IPV4_SRC, ip4('10.0.1.195')),
    chunk(HEP_CHUNK.IPV4_DST, ip4('10.0.1.178')),
    chunk(HEP_CHUNK.SRC_PORT, u16(5060)),
    chunk(HEP_CHUNK.DST_PORT, u16(5100)),
    chunk(HEP_CHUNK.TIMESTAMP_SEC, u32(1760000000)),
    chunk(HEP_CHUNK.TIMESTAMP_USEC, u32(500000)),
    chunk(HEP_CHUNK.PROTOCOL_TYPE, u8(HEP_PROTO_SIP)),
    chunk(HEP_CHUNK.CAPTURE_AGENT_ID, u32(1)),
    chunk(HEP_CHUNK.PAYLOAD, Buffer.from(SIP, 'utf8')),
    ...overrides,
  ]);
}

describe('parseHep3', () => {
  it('extracts every field from a complete datagram', () => {
    const p = parseHep3(fullPacket());
    expect(p.srcIp).toBe('10.0.1.195');
    expect(p.dstIp).toBe('10.0.1.178');
    expect(p.srcPort).toBe(5060);
    expect(p.dstPort).toBe(5100);
    expect(p.ipProto).toBe(17);
    expect(p.payloadType).toBe(HEP_PROTO_SIP);
    expect(p.captureAgentId).toBe(1);
    expect(p.payload).toBe(SIP);
  });

  it('reconstructs the timestamp from the seconds + microseconds chunks', () => {
    const p = parseHep3(fullPacket());
    expect(p.timestamp.getTime()).toBe(1760000000 * 1000 + 500);
  });

  it('falls back to arrival time when the agent sends no timestamp', () => {
    // Without this fallback every such message would be dated to 1970 and sort
    // to the top of the trace forever.
    const noTs = hep3([
      chunk(HEP_CHUNK.IPV4_SRC, ip4('1.2.3.4')),
      chunk(HEP_CHUNK.IPV4_DST, ip4('5.6.7.8')),
      chunk(HEP_CHUNK.PAYLOAD, Buffer.from(SIP)),
    ]);
    const before = Date.now();
    const p = parseHep3(noTs);
    expect(p.timestamp.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(p.timestamp.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('carries the capture agent id, which is what distinguishes the CSCFs', () => {
    for (const id of [1, 2, 3]) {
      const pkt = hep3([
        chunk(HEP_CHUNK.CAPTURE_AGENT_ID, u32(id)),
        chunk(HEP_CHUNK.PAYLOAD, Buffer.from(SIP)),
      ]);
      expect(parseHep3(pkt).captureAgentId).toBe(id);
    }
  });

  it('reads the correlation id when present', () => {
    const pkt = fullPacket([chunk(HEP_CHUNK.CORRELATION_ID, Buffer.from('corr-xyz'))]);
    expect(parseHep3(pkt).correlationId).toBe('corr-xyz');
  });

  it('skips an unknown generic chunk by its declared length', () => {
    // Forward compatibility: a newer agent emitting a chunk we do not know
    // must not cost us the payload that follows it.
    const pkt = hep3([
      chunk(0x00ff, Buffer.from('whatever')),
      chunk(HEP_CHUNK.PAYLOAD, Buffer.from(SIP)),
      chunk(0x00fe, Buffer.from('trailing')),
    ]);
    expect(parseHep3(pkt).payload).toBe(SIP);
  });

  it('skips a vendor-specific chunk rather than misreading it as generic', () => {
    // Vendor 42's type 0x000f is NOT the generic payload chunk; reading it as
    // one would silently replace the real SIP message with vendor data.
    const pkt = hep3([
      chunk(HEP_CHUNK.PAYLOAD, Buffer.from(SIP)),
      chunk(HEP_CHUNK.PAYLOAD, Buffer.from('VENDOR-DATA'), 42),
    ]);
    expect(parseHep3(pkt).payload).toBe(SIP);
  });

  it('handles IPv6 address chunks', () => {
    const v6 = Buffer.alloc(16); v6.writeUInt16BE(0x2001, 0); v6.writeUInt16BE(0xdb8, 2); v6[15] = 1;
    const pkt = hep3([
      chunk(HEP_CHUNK.IPV6_SRC, v6),
      chunk(HEP_CHUNK.IPV6_DST, v6),
      chunk(HEP_CHUNK.PAYLOAD, Buffer.from(SIP)),
    ]);
    const p = parseHep3(pkt);
    expect(p.srcIp).toBe('2001:db8:0:0:0:0:0:1');
  });

  describe('rejects malformed input with a distinguishable reason', () => {
    const codeOf = (buf: Buffer) => {
      try { parseHep3(buf); return 'no-throw'; }
      catch (e) { return e instanceof HepParseError ? e.code : 'wrong-error-type'; }
    };

    it('too short to hold a header', () => {
      expect(codeOf(Buffer.from('HEP'))).toBe('too_short');
    });

    it('not HEP at all (something else is sending to the port)', () => {
      expect(codeOf(Buffer.from('GET / HTTP/1.1\r\n\r\n'))).toBe('bad_magic');
    });

    it('declared length disagreeing with the real datagram length', () => {
      // Trusting the declared length here would read past the buffer end.
      const pkt = fullPacket();
      pkt.writeUInt16BE(pkt.length + 50, 4);
      expect(codeOf(pkt)).toBe('length_mismatch');
    });

    it('a chunk whose length overruns the datagram', () => {
      const pkt = fullPacket();
      // inflate the first chunk's length past the end, then fix the outer
      // length so it is specifically the CHUNK that is wrong
      pkt.writeUInt16BE(9999, 6 + 4);
      expect(codeOf(pkt)).toBe('truncated_chunk');
    });

    it('a chunk claiming a length below its own 6-byte header', () => {
      const pkt = fullPacket();
      pkt.writeUInt16BE(3, 6 + 4);
      expect(codeOf(pkt)).toBe('truncated_chunk');
    });

    it('no payload chunk', () => {
      const pkt = hep3([chunk(HEP_CHUNK.SRC_PORT, u16(5060))]);
      expect(codeOf(pkt)).toBe('no_payload');
    });

    it('a compressed payload, reported distinctly from "no payload"', () => {
      // These have different causes and different fixes, so they must not
      // share one error code.
      const pkt = hep3([chunk(HEP_CHUNK.PAYLOAD_COMPRESSED, Buffer.from([0x1f, 0x8b]))]);
      expect(codeOf(pkt)).toBe('compressed_payload');
    });
  });
});
