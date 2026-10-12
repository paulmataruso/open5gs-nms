// ── HEP (Homer Encapsulation Protocol) v3 parser ─────────────────────────────
//
// Kamailio's own `siptrace` module mirrors every SIP message it handles to a
// HEP collector. That is the tap this module reads, rather than sniffing the
// wire with tcpdump/sngrep, for one decisive reason on this deployment: UE
// SIP arrives inside IPsec ESP (ims_ipsec_pcscf), so a packet sniffer on the
// radio-facing interface sees ESP, not SIP. siptrace runs *inside* the proxy,
// after decryption, so it sees the real messages -- and loses nothing to
// capture buffer drops either.
//
// Wire format (HEP3), all integers big-endian:
//
//   "HEP3"            4 bytes, ASCII magic
//   total_length      2 bytes, counts these 6 header bytes too
//   then a sequence of TLV chunks:
//     vendor_id       2 bytes
//     type_id         2 bytes
//     chunk_length    2 bytes, counts these 6 chunk-header bytes too
//     payload         chunk_length - 6 bytes
//
// Only vendor 0 (the generic/HEP-core vendor) chunks are interpreted; a
// vendor-specific chunk is skipped by its own declared length rather than
// aborting the parse, so a capture agent that adds proprietary chunks stays
// readable.

/** Generic (vendor 0) HEP chunk type IDs we care about. */
export const HEP_CHUNK = {
  PROTOCOL_FAMILY: 0x0001,
  PROTOCOL_ID: 0x0002,
  IPV4_SRC: 0x0003,
  IPV4_DST: 0x0004,
  IPV6_SRC: 0x0005,
  IPV6_DST: 0x0006,
  SRC_PORT: 0x0007,
  DST_PORT: 0x0008,
  TIMESTAMP_SEC: 0x0009,
  TIMESTAMP_USEC: 0x000a,
  PROTOCOL_TYPE: 0x000b,
  CAPTURE_AGENT_ID: 0x000c,
  KEEP_ALIVE: 0x000d,
  AUTH_KEY: 0x000e,
  PAYLOAD: 0x000f,
  PAYLOAD_COMPRESSED: 0x0010,
  CORRELATION_ID: 0x0011,
} as const;

/** HEP payload protocol types (chunk 0x000b). 1 = SIP. */
export const HEP_PROTO_SIP = 1;

export interface HepPacket {
  srcIp: string;
  srcPort: number;
  dstIp: string;
  dstPort: number;
  /** IP protocol number: 6 TCP, 17 UDP, 132 SCTP. */
  ipProto: number;
  /** HEP payload protocol type; 1 is SIP. */
  payloadType: number;
  /** Capture agent id -- how we tell P-CSCF from I-CSCF from S-CSCF apart. */
  captureAgentId: number;
  timestamp: Date;
  payload: string;
  correlationId?: string;
}

export class HepParseError extends Error {
  constructor(
    message: string,
    /** Stable, countable reason code for metrics -- not for display. */
    readonly code:
      | 'too_short'
      | 'bad_magic'
      | 'length_mismatch'
      | 'truncated_chunk'
      | 'no_payload'
      | 'compressed_payload',
  ) {
    super(message);
    this.name = 'HepParseError';
  }
}

function ipv4(buf: Buffer): string {
  return `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}`;
}

function ipv6(buf: Buffer): string {
  // Plain (non-compressed) presentation form. Enough to identify a peer; this
  // is not used for comparison, so skipping :: shortening is fine.
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(i).toString(16));
  return parts.join(':');
}

/**
 * Parse one HEP3 datagram.
 *
 * Throws HepParseError with a stable `code` rather than returning null, so the
 * collector can count *why* packets were dropped instead of just how many --
 * a silent drop counter cannot tell "not HEP at all" from "HEP but truncated",
 * and those have completely different causes.
 */
export function parseHep3(buf: Buffer): HepPacket {
  if (buf.length < 6) throw new HepParseError(`datagram too short (${buf.length}B)`, 'too_short');
  if (buf.toString('ascii', 0, 4) !== 'HEP3') {
    // A HEPv1/v2 agent would land here. siptrace defaults to v3 and the IMS
    // templates do not override hep_version, so this means something else is
    // sending to our port -- worth surfacing distinctly, not as "truncated".
    throw new HepParseError(
      `not a HEP3 datagram (first 4 bytes: ${buf.subarray(0, Math.min(4, buf.length)).toString('hex')})`,
      'bad_magic',
    );
  }

  const total = buf.readUInt16BE(4);
  if (total !== buf.length) {
    // Trusting the declared length over the real one would read past the end
    // of a short datagram, so this is rejected rather than clamped.
    throw new HepParseError(`declared length ${total} != actual ${buf.length}`, 'length_mismatch');
  }

  let srcIp = '';
  let dstIp = '';
  let srcPort = 0;
  let dstPort = 0;
  let ipProto = 0;
  let payloadType = 0;
  let captureAgentId = 0;
  let tsSec = 0;
  let tsUsec = 0;
  let payload: string | undefined;
  let correlationId: string | undefined;
  let sawCompressed = false;

  let off = 6;
  while (off + 6 <= buf.length) {
    const vendor = buf.readUInt16BE(off);
    const type = buf.readUInt16BE(off + 2);
    const len = buf.readUInt16BE(off + 4);
    if (len < 6 || off + len > buf.length) {
      throw new HepParseError(`chunk at offset ${off} declares ${len}B, overruns datagram`, 'truncated_chunk');
    }
    const body = buf.subarray(off + 6, off + len);

    if (vendor === 0) {
      switch (type) {
        case HEP_CHUNK.PROTOCOL_ID: ipProto = body.readUInt8(0); break;
        case HEP_CHUNK.IPV4_SRC: if (body.length >= 4) srcIp = ipv4(body); break;
        case HEP_CHUNK.IPV4_DST: if (body.length >= 4) dstIp = ipv4(body); break;
        case HEP_CHUNK.IPV6_SRC: if (body.length >= 16) srcIp = ipv6(body); break;
        case HEP_CHUNK.IPV6_DST: if (body.length >= 16) dstIp = ipv6(body); break;
        case HEP_CHUNK.SRC_PORT: srcPort = body.readUInt16BE(0); break;
        case HEP_CHUNK.DST_PORT: dstPort = body.readUInt16BE(0); break;
        case HEP_CHUNK.TIMESTAMP_SEC: tsSec = body.readUInt32BE(0); break;
        case HEP_CHUNK.TIMESTAMP_USEC: tsUsec = body.readUInt32BE(0); break;
        case HEP_CHUNK.PROTOCOL_TYPE: payloadType = body.readUInt8(0); break;
        case HEP_CHUNK.CAPTURE_AGENT_ID: captureAgentId = body.readUInt32BE(0); break;
        case HEP_CHUNK.PAYLOAD: payload = body.toString('utf8'); break;
        case HEP_CHUNK.PAYLOAD_COMPRESSED: sawCompressed = true; break;
        case HEP_CHUNK.CORRELATION_ID: correlationId = body.toString('utf8'); break;
        default: break; // unknown generic chunk -- skip by length
      }
    }
    off += len;
  }

  if (payload === undefined) {
    if (sawCompressed) {
      // siptrace does not compress, so this would mean a different agent. Call
      // it out specifically rather than reporting "no payload", which would
      // send someone looking for the wrong bug.
      throw new HepParseError('payload is compressed (chunk 0x0010); not supported', 'compressed_payload');
    }
    throw new HepParseError('no payload chunk (0x000f) present', 'no_payload');
  }

  // A capture agent that omits the timestamp chunks would otherwise date every
  // message to 1970; fall back to arrival time instead.
  const timestamp = tsSec > 0 ? new Date(tsSec * 1000 + Math.floor(tsUsec / 1000)) : new Date();

  return { srcIp, srcPort, dstIp, dstPort, ipProto, payloadType, captureAgentId, timestamp, payload, correlationId };
}
