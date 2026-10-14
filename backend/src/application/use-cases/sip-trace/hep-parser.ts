// ── HEP (Homer Encapsulation Protocol) parser: v1/v2 and v3 ─────────────────
//
// Kamailio's own `siptrace` module mirrors every SIP message it handles to a
// HEP collector. That is the tap this module reads, rather than sniffing the
// wire with tcpdump/sngrep, for one decisive reason on this deployment: UE
// SIP arrives inside IPsec ESP (ims_ipsec_pcscf), so a packet sniffer on the
// radio-facing interface sees ESP, not SIP. siptrace runs *inside* the proxy,
// after decryption, so it sees the real messages -- and loses nothing to
// capture buffer drops either.
//
// Two wire formats arrive here, because siptrace can emit either.
//
// `hep_version` defaults to **1**, not 3 (siptrace.c: `int hep_version = 1`,
// and siptrace's own README says "Default value is 1"). Versions 1 and 2
// share one fixed-layout binary header; version 3 is the TLV format Homer
// uses today. Supporting both is what lets capture work on a CSCF whose
// config does not set `hep_version` -- which is every CSCF this project
// configures, since a modparam has to follow its own loadmodule and so
// cannot live in the generated include. Reading v1 here, rather than adding
// that modparam to the static templates, keeps turning capture on free of a
// CSCF restart -- which is the entire point of the feature.
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
//
// Wire format (HEP1/HEP2) -- `struct hep_hdr` + `struct hep_iphdr`, taken
// from siptrace_hep.c's own encoder rather than inferred:
//
//   hp_v             1 byte, 1 or 2
//   hp_l             1 byte, header length INCLUDING the address pair
//                    (16 for IPv4, 40 for IPv6) but NOT the v2 time header
//   hp_f             1 byte, address family (2 AF_INET, 10 AF_INET6)
//   hp_p             1 byte, IP protocol
//   hp_sport         2 bytes, big-endian (htons)
//   hp_dport         2 bytes, big-endian (htons)
//   src/dst address  8 bytes (IPv4) or 32 bytes (IPv6), network order
//   v2 only:         tv_sec 4 + tv_usec 4 + captid 2, all LITTLE-endian --
//                    `to_le()` is a no-op on x86, so these are host order,
//                    the one field group in HEP that is not big-endian
//   payload          the rest of the datagram, raw SIP
//
// There is no payload-type and no capture-agent chunk in v1/v2: every v1/v2
// datagram from siptrace is SIP by construction, and this project tells the
// three CSCFs apart by which collector PORT received the packet (see
// CAPTURE_PORTS in sip-trace-store.ts), not by a capture id, so nothing we
// actually use is lost by the older format.

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
      | 'compressed_payload'
      | 'unsupported_version'
      | 'bad_header',
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
    // Reaching here means the datagram is not v3 at all. Callers should use
    // parseHep(), which dispatches to the v1/v2 reader instead of failing --
    // siptrace's own default is v1, so a non-v3 datagram is the common case,
    // not the odd one. This function stays strict so a v3-specific test or
    // caller gets a clear error rather than a silently mis-parsed packet.
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

/** Address families as they appear in `hp_f` (Linux values). */
const HEP_AF_INET = 2;
const HEP_AF_INET6 = 10;

/** `sizeof(struct hep_hdr)`: hp_v, hp_l, hp_f, hp_p, hp_sport, hp_dport. */
const HEP12_HDR = 8;
/** tv_sec + tv_usec + captid, the v2-only time header. */
const HEP12_TIME = 10;

/**
 * Parse one HEPv1 or HEPv2 datagram -- the format siptrace emits by default.
 *
 * Mirrors parseHep3's contract: same HepPacket out, same HepParseError codes,
 * so the collector counts drops identically whichever format a CSCF sends.
 */
export function parseHep1or2(buf: Buffer): HepPacket {
  if (buf.length < HEP12_HDR) throw new HepParseError(`datagram too short (${buf.length}B)`, 'too_short');

  const version = buf.readUInt8(0);
  if (version !== 1 && version !== 2) {
    throw new HepParseError(`HEP version ${version} is not 1 or 2`, 'unsupported_version');
  }

  const hdrLen = buf.readUInt8(1);
  const family = buf.readUInt8(2);
  const ipProto = buf.readUInt8(3);
  const srcPort = buf.readUInt16BE(4);
  const dstPort = buf.readUInt16BE(6);

  // hp_l is validated against the family rather than trusted, because it is
  // the offset every later read depends on: a wrong value would silently slice
  // the address pair out of the SIP text, which parses as a plausible-looking
  // malformed message instead of an obvious error.
  const addrLen = family === HEP_AF_INET ? 4 : family === HEP_AF_INET6 ? 16 : 0;
  if (addrLen === 0) {
    throw new HepParseError(`unknown address family ${family} in hp_f`, 'bad_header');
  }
  const expectedHdr = HEP12_HDR + addrLen * 2;
  if (hdrLen !== expectedHdr) {
    throw new HepParseError(
      `hp_l is ${hdrLen}, expected ${expectedHdr} for family ${family}`,
      'bad_header',
    );
  }
  if (buf.length < expectedHdr) {
    throw new HepParseError(`header declares ${expectedHdr}B, datagram is ${buf.length}B`, 'too_short');
  }

  const read = family === HEP_AF_INET ? ipv4 : ipv6;
  const srcIp = read(buf.subarray(HEP12_HDR, HEP12_HDR + addrLen));
  const dstIp = read(buf.subarray(HEP12_HDR + addrLen, HEP12_HDR + addrLen * 2));

  let off = expectedHdr;
  let timestamp = new Date();
  if (version === 2) {
    if (buf.length < off + HEP12_TIME) {
      throw new HepParseError(`v2 time header runs past end of ${buf.length}B datagram`, 'too_short');
    }
    // Little-endian: see the `to_le()` note in this file's header.
    const tvSec = buf.readUInt32LE(off);
    const tvUsec = buf.readUInt32LE(off + 4);
    if (tvSec > 0) timestamp = new Date(tvSec * 1000 + Math.floor(tvUsec / 1000));
    off += HEP12_TIME;
    // `struct hep_timehdr` is 10 bytes of fields but sizeof() rounds it to 12
    // on any normal alignment, and siptrace memcpy's sizeof() -- so the two
    // trailing padding bytes are on the wire. They are always zero, and SIP
    // never starts with NUL, so skipping them here reads both layouts without
    // having to guess which compiler built the sender.
    while (off < buf.length && buf[off] === 0 && off < expectedHdr + HEP12_TIME + 2) off++;
  }

  if (off >= buf.length) {
    throw new HepParseError('no payload after HEP header', 'no_payload');
  }

  return {
    srcIp,
    srcPort,
    dstIp,
    dstPort,
    ipProto,
    // v1/v2 carry no payload-type field; siptrace only ever sends SIP on it.
    payloadType: HEP_PROTO_SIP,
    // No capture-agent field either (v2's captid is the closest thing, and is
    // 0 unless hep_capture_id is set). The listening port identifies the CSCF.
    captureAgentId: 0,
    timestamp,
    payload: buf.toString('utf8', off),
  };
}

/**
 * Parse one HEP datagram of any version siptrace can emit.
 *
 * This is what the collector calls: the version is a property of the sender's
 * config, not something we get to choose, and on this project it is v1 by
 * default. Dispatching on the magic rather than on configuration means a CSCF
 * that later gains `hep_version 3` keeps working with no collector change.
 */
export function parseHep(buf: Buffer): HepPacket {
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'HEP3') return parseHep3(buf);
  return parseHep1or2(buf);
}
