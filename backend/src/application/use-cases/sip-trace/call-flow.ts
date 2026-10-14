import { createHash } from 'crypto';
import { Db } from 'mongodb';
import { SipTraceDocument, SipTraceSource, SIP_TRACE_COLLECTION } from './sip-trace-store';

// ── Whole-call flow construction ─────────────────────────────────────────────
//
// Turns the raw per-message rows into the end-to-end ladder a call actually
// has: one row per real SIP message on the wire, in time order, between
// labelled endpoints. Two things make that more than a sort.
//
// 1. THE SAME WIRE MESSAGE IS CAPTURED SEVERAL TIMES. Each CSCF mirrors what
//    it receives and what it sends, so a P-CSCF -> S-CSCF request is traced
//    once by the P-CSCF tap (on the way out) and again by the S-CSCF tap (on
//    the way in). Both are genuine observations of ONE message. Rendering them
//    as separate arrows is what makes a simple 5-message call look like a wall
//    of twenty, and it was the single biggest reason the raw list did not read
//    like a call flow.
//
//    Retransmissions, however, must survive -- a retransmitted INVITE is often
//    the whole point of looking. So duplicates are not collapsed by key alone:
//    within one key, occurrences are numbered PER TAP, and the n-th occurrence
//    seen by each tap is merged into the n-th row. Two taps seeing one message
//    once each gives one row; two taps each seeing it three times gives three
//    rows. No count is invented and none is lost.
//
// 2. ENDPOINTS ARE BARE ADDRESSES. A ladder with `127.0.1.2:6060` over a
//    column is accurate and unreadable. The CSCF addresses are known from the
//    IMS config, so they are labelled by role, and anything else is assumed to
//    be a UE and labelled with the SIP user seen on it.

export type EndpointRole = 'ue' | 'pcscf' | 'icscf' | 'scscf' | 'other';

export interface FlowEndpoint {
  /** "ip:port" -- stable id the hops refer to. */
  id: string;
  ip: string;
  port: number;
  role: EndpointRole;
  /** Display label, e.g. "P-CSCF" or "UE 1001". */
  label: string;
  /** Always available, for the tooltip -- the label can hide this. */
  address: string;
}

export type HopClass =
  | 'request'
  | 'provisional'
  | 'success'
  | 'redirect'
  | 'client-error'
  | 'server-error'
  | 'global-error';

export interface FlowHop {
  /** Position in the ladder, 0-based. */
  index: number;
  timestamp: Date;
  /** Milliseconds since the previous hop -- where a call stalls shows up here. */
  deltaMs: number;
  /** Milliseconds since the first hop. */
  offsetMs: number;
  from: string;
  to: string;
  callId: string;
  /** "INVITE", or "180 Ringing" for a reply. */
  label: string;
  cls: HopClass;
  method?: string;
  statusCode?: number;
  cseqNumber?: number;
  cseqMethod?: string;
  /** True for the 2nd and later transmissions of the same message. */
  retransmission: boolean;
  /** Which CSCF taps observed this one message. */
  sources: SipTraceSource[];
  /** Indices into the returned `messages` array -- what a click opens. */
  messageRefs: number[];
}

export interface CallFlow {
  endpoints: FlowEndpoint[];
  hops: FlowHop[];
  /** Every Call-ID represented, in first-seen order. */
  dialogs: string[];
  startTime: Date | null;
  endTime: Date | null;
  /** Raw rows behind the ladder, deduplication not applied. */
  messages: SipTraceDocument[];
  /** How many raw rows were merged away as duplicate observations. */
  mergedDuplicates: number;
}

export interface CscfAddresses {
  pcscfIp?: string;
  icscfIp?: string;
  scscfIp?: string;
}

function classOf(d: SipTraceDocument): HopClass {
  if (d.method) return 'request';
  const c = d.statusCode ?? 0;
  if (c < 200) return 'provisional';
  if (c < 300) return 'success';
  if (c < 400) return 'redirect';
  if (c < 500) return 'client-error';
  if (c < 600) return 'server-error';
  return 'global-error';
}

function labelOf(d: SipTraceDocument): string {
  if (d.method) return d.method;
  const reason = (d.statusReason ?? '').trim();
  return d.statusCode ? `${d.statusCode}${reason ? ` ${reason}` : ''}` : 'reply';
}

/**
 * Identity of one SIP message on the wire.
 *
 * Deliberately does NOT include the capturing tap or the timestamp: those are
 * what differ between two observations of the same message. It DOES include
 * both addresses, so the same request arriving at the next hop stays a
 * distinct row -- that is a different message on a different wire, and it is
 * the hop structure the ladder exists to show.
 *
 * It also includes a digest of the message BYTES, which is load-bearing and
 * not an optimisation. In IMS one Call-ID legitimately crosses the same pair
 * of nodes twice -- the originating and terminating halves of a UE-to-UE call
 * both run through the same P-CSCF and S-CSCF -- so method, CSeq and the two
 * addresses are NOT a unique identity. Keying on those alone merged the two
 * legs and labelled the terminating one a retransmission, which is a
 * confidently wrong statement about a real call. The two legs differ in their
 * Via branch, so they differ in bytes; a true retransmission is byte-identical
 * and still merges. Two taps seeing one datagram see identical bytes, so
 * genuine duplicate observations are unaffected.
 */
function hopKey(d: SipTraceDocument): string {
  const what = d.method ? `R:${d.method}` : `S:${d.statusCode ?? ''}`;
  const body = createHash('sha1').update(d.raw ?? '').digest('hex').slice(0, 16);
  return [
    d.callId,
    d.cseqNumber ?? '',
    d.cseqMethod ?? '',
    what,
    `${d.srcIp}:${d.srcPort}`,
    `${d.dstIp}:${d.dstPort}`,
    body,
  ].join('|');
}

function byTime(a: SipTraceDocument, b: SipTraceDocument): number {
  const t = a.timestamp.getTime() - b.timestamp.getTime();
  return t !== 0 ? t : (a.seq ?? 0) - (b.seq ?? 0);
}

export function buildCallFlow(docs: SipTraceDocument[], cscf: CscfAddresses = {}): CallFlow {
  const messages = [...docs].sort(byTime);

  // ── Merge the taps' separate observations of each single message ──────────
  const groups = new Map<string, { doc: SipTraceDocument; ref: number }[]>();
  messages.forEach((doc, ref) => {
    const k = hopKey(doc);
    const g = groups.get(k);
    if (g) g.push({ doc, ref }); else groups.set(k, [{ doc, ref }]);
  });

  type Row = { doc: SipTraceDocument; refs: number[]; sources: SipTraceSource[]; nth: number };
  const rows: Row[] = [];
  let mergedDuplicates = 0;

  for (const group of groups.values()) {
    // Number each tap's observations independently, then merge equal numbers:
    // the n-th time P-CSCF saw this message is the same transmission as the
    // n-th time S-CSCF saw it.
    const perSource = new Map<SipTraceSource, { doc: SipTraceDocument; ref: number }[]>();
    for (const item of group) {
      const list = perSource.get(item.doc.source);
      if (list) list.push(item); else perSource.set(item.doc.source, [item]);
    }
    const transmissions = Math.max(...[...perSource.values()].map(l => l.length));
    for (let n = 0; n < transmissions; n++) {
      const observations = [...perSource.values()].map(l => l[n]).filter(Boolean);
      if (observations.length === 0) continue;
      observations.sort((a, b) => byTime(a.doc, b.doc));
      mergedDuplicates += observations.length - 1;
      rows.push({
        // Earliest observation wins: a message is sent before it is received,
        // so the sender's tap carries the truer time.
        doc: observations[0].doc,
        refs: observations.map(o => o.ref),
        sources: [...new Set(observations.map(o => o.doc.source))],
        nth: n,
      });
    }
  }

  rows.sort((a, b) => byTime(a.doc, b.doc));

  // ── Endpoints, in order of first appearance (as sngrep orders columns) ────
  // Which SIP user sits at which address. From/To name the two PARTIES of the
  // dialog and never swap, but a reply travels back towards the caller -- so
  // on a response the source is the To party and the destination is the From
  // party. Reading both directions the same way mislabels the caller's own
  // handset with the callee's number, which is worse than no label: it names
  // the wrong phone with full confidence. (Seen for real on a captured call,
  // where the caller's second socket came out labelled as the callee.)
  const userByAddress = new Map<string, string>();
  for (const m of messages) {
    // `!m.method`, not `=== undefined`: the Mongo driver stores an absent
    // method as NULL, so a strict undefined check silently never matches on
    // real stored data -- it passed every unit test (where the field really is
    // undefined) and did nothing in production. The rest of this file already
    // uses the falsy convention for exactly this reason; this line did not.
    const isReply = !m.method;
    const atSrc = isReply ? m.toUser : m.fromUser;
    const atDst = isReply ? m.fromUser : m.toUser;
    const src = `${m.srcIp}:${m.srcPort}`;
    const dst = `${m.dstIp}:${m.dstPort}`;
    if (atSrc && !userByAddress.has(src)) userByAddress.set(src, atSrc);
    if (atDst && !userByAddress.has(dst)) userByAddress.set(dst, atDst);
  }

  const roleByIp = new Map<string, EndpointRole>();
  if (cscf.pcscfIp) roleByIp.set(cscf.pcscfIp, 'pcscf');
  if (cscf.icscfIp) roleByIp.set(cscf.icscfIp, 'icscf');
  if (cscf.scscfIp) roleByIp.set(cscf.scscfIp, 'scscf');
  const ROLE_LABEL: Record<EndpointRole, string> = {
    pcscf: 'P-CSCF', icscf: 'I-CSCF', scscf: 'S-CSCF', ue: 'UE', other: '',
  };

  const endpoints: FlowEndpoint[] = [];
  const seen = new Set<string>();
  const addEndpoint = (ip: string, port: number) => {
    const id = `${ip}:${port}`;
    if (seen.has(id)) return;
    seen.add(id);
    const role = roleByIp.get(ip) ?? 'ue';
    const user = userByAddress.get(id);
    // A CSCF keeps its role name even though a user was seen on it; only a UE
    // gets named after the user, because for a proxy the user is just whoever
    // happened to be in the first message through it.
    const label = role === 'ue'
      ? (user ? `UE ${user}` : `UE ${ip}`)
      : ROLE_LABEL[role];
    endpoints.push({ id, ip, port, role, label, address: id });
  };
  for (const r of rows) {
    addEndpoint(r.doc.srcIp, r.doc.srcPort);
    addEndpoint(r.doc.dstIp, r.doc.dstPort);
  }

  // One node commonly appears as two columns on two sockets -- P-CSCF listens
  // on a UE-facing IPsec port and a network-facing one, and both are real,
  // distinct endpoints worth separating. Two columns both reading "P-CSCF"
  // is not, so a shared label gets its port back.
  const labelCounts = new Map<string, number>();
  for (const e of endpoints) labelCounts.set(e.label, (labelCounts.get(e.label) ?? 0) + 1);
  for (const e of endpoints) {
    if ((labelCounts.get(e.label) ?? 0) > 1) e.label = `${e.label}:${e.port}`;
  }

  const first = rows.length ? rows[0].doc.timestamp.getTime() : 0;
  const hops: FlowHop[] = rows.map((r, i) => {
    const t = r.doc.timestamp.getTime();
    return {
      index: i,
      timestamp: r.doc.timestamp,
      deltaMs: i === 0 ? 0 : t - rows[i - 1].doc.timestamp.getTime(),
      offsetMs: t - first,
      from: `${r.doc.srcIp}:${r.doc.srcPort}`,
      to: `${r.doc.dstIp}:${r.doc.dstPort}`,
      callId: r.doc.callId,
      label: labelOf(r.doc),
      cls: classOf(r.doc),
      method: r.doc.method,
      statusCode: r.doc.statusCode,
      cseqNumber: r.doc.cseqNumber,
      cseqMethod: r.doc.cseqMethod,
      retransmission: r.nth > 0,
      sources: r.sources,
      messageRefs: r.refs,
    };
  });

  const dialogs: string[] = [];
  for (const m of messages) if (!dialogs.includes(m.callId)) dialogs.push(m.callId);

  return {
    endpoints,
    hops,
    dialogs,
    startTime: messages.length ? messages[0].timestamp : null,
    endTime: messages.length ? messages[messages.length - 1].timestamp : null,
    messages,
    mergedDuplicates,
  };
}

/**
 * Other Call-IDs that are probably the same real call.
 *
 * A direct IMS call keeps one Call-ID from end to end, so this returns nothing
 * for the common case. It matters when a B2BUA is in the path: Asterisk
 * (PSTN Gateway, Asterisk-2G, Cross-RAN Calling) terminates one dialog and
 * originates another, so one call a user made is genuinely two Call-IDs with
 * no SIP-level link between them -- see CLAUDE.md pattern 14.
 *
 * The link is therefore heuristic -- shared party, overlapping in time -- and
 * is offered to the operator rather than merged automatically, because
 * silently welding two unrelated dialogs into one ladder would be worse than
 * showing them apart.
 */
export async function findRelatedCallIds(
  db: Db,
  callId: string,
  windowSeconds = 120,
  limit = 8,
): Promise<string[]> {
  const col = db.collection<SipTraceDocument>(SIP_TRACE_COLLECTION);
  const own = await col.find({ callId }).project({ fromUser: 1, toUser: 1, timestamp: 1 }).toArray();
  if (own.length === 0) return [];

  const parties = new Set<string>();
  for (const m of own as Partial<SipTraceDocument>[]) {
    if (m.fromUser) parties.add(m.fromUser);
    if (m.toUser) parties.add(m.toUser);
  }
  if (parties.size === 0) return [];

  const times = (own as Partial<SipTraceDocument>[]).map(m => (m.timestamp as Date).getTime());
  const from = new Date(Math.min(...times) - windowSeconds * 1000);
  const to = new Date(Math.max(...times) + windowSeconds * 1000);
  const users = [...parties];

  const ids = await col.distinct('callId', {
    callId: { $ne: callId },
    timestamp: { $gte: from, $lte: to },
    $or: [{ fromUser: { $in: users } }, { toUser: { $in: users } }],
  });
  return ids.slice(0, limit);
}
