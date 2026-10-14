import {
  parseHep,
  parseHep1or2,
  parseHep3,
  HepParseError,
  HEP_CHUNK,
  HEP_PROTO_SIP,
} from '../hep-parser';

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

// ── HEPv1 / HEPv2 ───────────────────────────────────────────────────────────
//
// These matter more than their simplicity suggests: siptrace's `hep_version`
// defaults to 1, so v1 -- not v3 -- is what the CSCFs on this deployment
// actually send. The collector required v3 for a while, which meant every
// real captured message was counted as `bad_magic` and silently discarded
// while the UI reported capture as running.

/** Build a HEPv1/v2 datagram the way siptrace_hep.c lays one out. */
function hep12(opts: {
  version?: number;
  family?: number;
  proto?: number;
  srcIp?: string;
  dstIp?: string;
  srcPort?: number;
  dstPort?: number;
  /** Override hp_l, to prove it is validated rather than trusted. */
  hdrLen?: number;
  /** v2 only. */
  tvSec?: number;
  tvUsec?: number;
  /** v2 only: 12 is what sizeof(struct hep_timehdr) rounds to, 10 is the raw fields. */
  timeHdrBytes?: 10 | 12;
  payload?: string;
}): Buffer {
  const version = opts.version ?? 1;
  const family = opts.family ?? 2;
  const addr = family === 10 ? 16 : 4;
  const head = Buffer.alloc(8);
  head.writeUInt8(version, 0);
  head.writeUInt8(opts.hdrLen ?? 8 + addr * 2, 1);
  head.writeUInt8(family, 2);
  head.writeUInt8(opts.proto ?? 17, 3);
  head.writeUInt16BE(opts.srcPort ?? 5060, 4);
  head.writeUInt16BE(opts.dstPort ?? 4060, 6);
  const parts = [head, ip4(opts.srcIp ?? '10.0.1.178'), ip4(opts.dstIp ?? '127.0.1.1')];
  if (version === 2) {
    const t = Buffer.alloc(opts.timeHdrBytes ?? 12);
    t.writeUInt32LE(opts.tvSec ?? 1760000000, 0);   // little-endian: see to_le()
    t.writeUInt32LE(opts.tvUsec ?? 250000, 4);
    t.writeUInt16LE(0, 8);
    parts.push(t);
  }
  parts.push(Buffer.from(opts.payload ?? SIP, 'utf8'));
  return Buffer.concat(parts);
}

describe('parseHep1or2', () => {
  it('reads every field from a v1 IPv4 datagram', () => {
    const p = parseHep1or2(hep12({}));
    expect(p.srcIp).toBe('10.0.1.178');
    expect(p.dstIp).toBe('127.0.1.1');
    expect(p.srcPort).toBe(5060);
    expect(p.dstPort).toBe(4060);
    expect(p.ipProto).toBe(17);
    expect(p.payload).toBe(SIP);
  });

  it('reports v1/v2 payloads as SIP, since the format carries no type field', () => {
    // The collector drops anything that is not SIP, so a v1 packet defaulting
    // to 0 here would be discarded as "non-SIP" on arrival.
    expect(parseHep1or2(hep12({})).payloadType).toBe(HEP_PROTO_SIP);
  });

  it('parses the exact header a live I-CSCF put on the wire', () => {
    // Captured from this deployment with tcpdump: 01 10 02 11 | 13c4 0fdc |
    // 10.0.1.178 | 127.0.1.1. Pinned as bytes so a future "tidy-up" of the
    // offsets has to break this test rather than silently break capture.
    const wire = Buffer.concat([
      Buffer.from('01100211', 'hex'),
      Buffer.from('13c40fdc', 'hex'),
      Buffer.from('0a0001b2', 'hex'),
      Buffer.from('7f000101', 'hex'),
      Buffer.from(SIP, 'utf8'),
    ]);
    const p = parseHep1or2(wire);
    expect(p.srcIp).toBe('10.0.1.178');
    expect(p.srcPort).toBe(5060);
    expect(p.dstIp).toBe('127.0.1.1');
    expect(p.dstPort).toBe(4060);
    expect(p.payload).toBe(SIP);
  });

  it('reads a v2 little-endian timestamp', () => {
    const p = parseHep1or2(hep12({ version: 2, tvSec: 1760000000, tvUsec: 250000 }));
    expect(p.timestamp.getTime()).toBe(1760000000 * 1000 + 250);
    expect(p.payload).toBe(SIP);
  });

  it('skips the two padding bytes sizeof(hep_timehdr) adds, and copes without them', () => {
    expect(parseHep1or2(hep12({ version: 2, timeHdrBytes: 12 })).payload).toBe(SIP);
    expect(parseHep1or2(hep12({ version: 2, timeHdrBytes: 10 })).payload).toBe(SIP);
  });

  it('dates a v1 message to arrival, having no timestamp of its own', () => {
    const before = Date.now();
    const p = parseHep1or2(hep12({}));
    expect(p.timestamp.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('parses an IPv6 v1 datagram', () => {
    const v6 = Buffer.alloc(8);
    v6.writeUInt8(1, 0);
    v6.writeUInt8(8 + 32, 1);
    v6.writeUInt8(10, 2);
    v6.writeUInt8(17, 3);
    v6.writeUInt16BE(5060, 4);
    v6.writeUInt16BE(4060, 6);
    const a = Buffer.alloc(16); a.writeUInt16BE(0xfd00, 0); a.writeUInt16BE(1, 14);
    const b = Buffer.alloc(16); b.writeUInt16BE(0xfd00, 0); b.writeUInt16BE(2, 14);
    const p = parseHep1or2(Buffer.concat([v6, a, b, Buffer.from(SIP, 'utf8')]));
    expect(p.srcIp).toContain('fd00');
    expect(p.payload).toBe(SIP);
  });

  it('rejects an hp_l that disagrees with the address family', () => {
    // Trusting it would slice the address pair into the SIP text, which parses
    // as a merely-malformed message instead of an obvious error.
    const err = (() => { try { parseHep1or2(hep12({ hdrLen: 40 })); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(HepParseError);
    expect((err as HepParseError).code).toBe('bad_header');
  });

  it('rejects an unknown address family', () => {
    const err = (() => { try { parseHep1or2(hep12({ family: 99 })); } catch (e) { return e; } })();
    expect((err as HepParseError).code).toBe('bad_header');
  });

  it('rejects a version it does not implement', () => {
    const err = (() => { try { parseHep1or2(hep12({ version: 4 })); } catch (e) { return e; } })();
    expect((err as HepParseError).code).toBe('unsupported_version');
  });

  it('rejects a datagram with a header but no payload', () => {
    const err = (() => { try { parseHep1or2(hep12({ payload: '' })); } catch (e) { return e; } })();
    expect((err as HepParseError).code).toBe('no_payload');
  });
});

describe('parseHep', () => {
  it('dispatches on the magic, not on configuration', () => {
    expect(parseHep(fullPacket()).payload).toBe(SIP);        // v3 TLV
    expect(parseHep(hep12({}).subarray(0)).payload).toBe(SIP); // v1 fixed header
    expect(parseHep(hep12({ version: 2 })).payload).toBe(SIP);
  });

  it('keeps the v3 reader strict, so a v1 packet is not mis-parsed as v3', () => {
    const err = (() => { try { parseHep3(hep12({})); } catch (e) { return e; } })();
    expect((err as HepParseError).code).toBe('bad_magic');
  });

  it('still reports a genuinely unrecognisable datagram rather than guessing', () => {
    const err = (() => { try { parseHep(Buffer.from('nonsense', 'utf8')); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(HepParseError);
  });
});
