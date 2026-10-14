import { Db } from 'mongodb';
import { ParsedSip, parseSipMessage, sipUser } from './sip-message-parser';
import { HepPacket } from './hep-parser';

// ── SIP trace storage ────────────────────────────────────────────────────────
//
// Same posture as nms_cdr (cdr-store.ts): Kamailio is the source of truth, and
// this collection exists to make what it already emitted searchable and
// orderable. Per-feature configurable retention via a TTL index, matching the
// CDR and TWAMP-history pattern -- a SIP trace is high-volume, so the default
// retention is deliberately short (hours, not months) and the UI says so.

export const SIP_TRACE_COLLECTION = 'nms_sip_trace';
export const DEFAULT_SIP_TRACE_RETENTION_HOURS = 24;
export const MIN_SIP_TRACE_RETENTION_HOURS = 1;
export const MAX_SIP_TRACE_RETENTION_HOURS = 720; // 30 days

/**
 * Which Kamailio instance a message came from. Derived from HEP's capture
 * agent id, which the generated include sets per instance -- see
 * CAPTURE_AGENT_IDS below.
 */
export type SipTraceSource = 'pcscf' | 'icscf' | 'scscf' | 'unknown';

/**
 * One collector port per Kamailio instance -- this is how a message's source
 * instance is identified, and it needs explaining because the obvious
 * mechanism does not work here.
 *
 * HEP carries a capture-agent id field (chunk 0x000c) meant for exactly this.
 * But setting it requires `modparam("siptrace", "hep_capture_id", N)`, and a
 * modparam must follow its module's loadmodule. The IMS templates load
 * siptrace at ~line 260 while the generated include we control is imported at
 * line 12, so we cannot place one. The stock template's own modparam block
 * does not set it either, which means every instance would report agent id 0
 * and the whole trace would collapse into one indistinguishable stream.
 *
 * What the include CAN set is `CAPTURE_NODE`, whose value becomes
 * siptrace's `duplicate_uri` -- a full SIP URI including the port. So each
 * instance is pointed at its own port and the receiving socket identifies it.
 * Authoritative, needs no template change, and is visible in the generated
 * config.
 *
 * Changing a port here without regenerating the includes silently relabels
 * every message from that instance.
 */
export const CAPTURE_PORTS: Record<Exclude<SipTraceSource, 'unknown'>, number> = {
  pcscf: 9060,
  icscf: 9061,
  scscf: 9062,
};

const PORT_TO_SOURCE = new Map<number, SipTraceSource>(
  Object.entries(CAPTURE_PORTS).map(([k, v]) => [v, k as SipTraceSource]),
);

export function sourceFromPort(port: number): SipTraceSource {
  return PORT_TO_SOURCE.get(port) ?? 'unknown';
}

export interface SipTraceDocument {
  _id?: unknown;
  callId: string;
  timestamp: Date;
  source: SipTraceSource;
  captureAgentId: number;
  srcIp: string;
  srcPort: number;
  dstIp: string;
  dstPort: number;
  transport: string;
  /** Request method, absent on responses. */
  method?: string;
  statusCode?: number;
  statusReason?: string;
  cseqMethod?: string;
  cseqNumber?: number;
  fromUri?: string;
  fromUser?: string;
  toUri?: string;
  toUser?: string;
  /** Verbatim message -- what the detail pane shows. */
  raw: string;
  /** Monotonic within one datagram burst, to keep same-millisecond ordering stable. */
  seq: number;
}

function col(db: Db) {
  return db.collection<SipTraceDocument>(SIP_TRACE_COLLECTION);
}

const transportName = (proto: number): string =>
  proto === 6 ? 'TCP' : proto === 17 ? 'UDP' : proto === 132 ? 'SCTP' : `IP(${proto})`;

/**
 * Turn one parsed HEP packet into a storable document.
 *
 * A message with no Call-ID is kept under a synthetic id rather than dropped:
 * a malformed or truncated message is frequently the thing an operator is
 * hunting, and discarding it here would make it invisible in the one tool
 * meant to show it.
 */
export function toDocument(
  pkt: HepPacket,
  seq: number,
  source: SipTraceSource,
  parsed?: ParsedSip,
): SipTraceDocument {
  const p = parsed ?? parseSipMessage(pkt.payload);
  return {
    callId: p.callId && p.callId.trim() ? p.callId.trim() : `_nocallid_${pkt.timestamp.getTime()}_${seq}`,
    timestamp: pkt.timestamp,
    source,
    captureAgentId: pkt.captureAgentId,
    srcIp: pkt.srcIp,
    srcPort: pkt.srcPort,
    dstIp: pkt.dstIp,
    dstPort: pkt.dstPort,
    transport: transportName(pkt.ipProto),
    method: p.method,
    statusCode: p.statusCode,
    statusReason: p.statusReason,
    cseqMethod: p.cseqMethod,
    cseqNumber: p.cseqNumber,
    fromUri: p.fromUri,
    fromUser: sipUser(p.fromUri),
    toUri: p.toUri,
    toUser: sipUser(p.toUri),
    raw: pkt.payload,
    seq,
  };
}

/** Idempotent; safe on every startup and on every retention change. */
export async function ensureSipTraceIndexes(db: Db, retentionHours: number): Promise<void> {
  const c = col(db);
  const seconds = Math.max(60, Math.round(retentionHours * 3600));
  const indexes = await c.indexes().catch(() => [] as any[]);

  const ttl = indexes.find(
    (ix: any) => ix.key && Object.keys(ix.key).length === 1 && ix.key.timestamp === 1 && ix.expireAfterSeconds !== undefined,
  );
  if (!ttl) {
    await c.createIndex({ timestamp: 1 }, { expireAfterSeconds: seconds });
  } else if (ttl.expireAfterSeconds !== seconds) {
    await db.command({
      collMod: SIP_TRACE_COLLECTION,
      index: { keyPattern: { timestamp: 1 }, expireAfterSeconds: seconds },
    });
  }

  // Ladder: every message of one call, in order.
  if (!indexes.find((ix: any) => ix.key && ix.key.callId === 1 && ix.key.timestamp === 1)) {
    await c.createIndex({ callId: 1, timestamp: 1, seq: 1 });
  }
  // Call list: newest first.
  if (!indexes.find((ix: any) => ix.key && ix.key.timestamp === -1 && Object.keys(ix.key).length === 1)) {
    await c.createIndex({ timestamp: -1 });
  }
  // Search by party.
  if (!indexes.find((ix: any) => ix.key && ix.key.fromUser === 1)) {
    await c.createIndex({ fromUser: 1, timestamp: -1 });
  }
  if (!indexes.find((ix: any) => ix.key && ix.key.toUser === 1)) {
    await c.createIndex({ toUser: 1, timestamp: -1 });
  }
}

export async function insertMessages(db: Db, docs: SipTraceDocument[]): Promise<void> {
  if (docs.length === 0) return;
  // ordered:false so one malformed document cannot discard the rest of the
  // batch. The cast drops our `_id?: unknown` (which exists so callers can
  // read the field back) to satisfy the driver's OptionalId, which insists on
  // ObjectId; nothing here ever supplies an _id, so Mongo assigns them.
  await col(db).insertMany(docs as unknown as Parameters<ReturnType<typeof col>['insertMany']>[0], {
    ordered: false,
  });
}

export interface CallSummary {
  callId: string;
  startTime: Date;
  endTime: Date;
  messageCount: number;
  /** The dialog-establishing method, e.g. INVITE or REGISTER. */
  initialMethod?: string;
  fromUser?: string;
  toUser?: string;
  /** Highest final response seen, for an at-a-glance outcome. */
  lastStatus?: number;
  sources: SipTraceSource[];
}

export interface CallListFilter {
  from?: Date;
  to?: Date;
  search?: string;
  method?: string;
  source?: SipTraceSource;
  page?: number;
  pageSize?: number;
  /**
   * 'calls' (the default) lists only dialogs that are an actual call -- ones
   * containing an INVITE. Anything else here is a dialog in the SIP sense but
   * not a call, and on a live IMS it outnumbers the calls heavily: P-CSCF
   * sends I-CSCF an OPTIONS keepalive every few seconds forever, every
   * handset re-REGISTERs on a timer, and SUBSCRIBE/NOTIFY runs continuously.
   * Making that the default list buries the one thing an operator opened the
   * page to find.
   *
   * 'all' is the unfiltered view, for when the question is about registration
   * or messaging rather than a call.
   */
  kind?: 'calls' | 'all';
}

export async function listCalls(
  db: Db,
  f: CallListFilter,
): Promise<{ rows: CallSummary[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, f.pageSize ?? 50));

  const match: Record<string, unknown> = {};
  if (f.from || f.to) {
    const t: Record<string, Date> = {};
    if (f.from) t.$gte = f.from;
    if (f.to) t.$lte = f.to;
    match.timestamp = t;
  }
  if (f.source) match.source = f.source;
  if (f.search && f.search.trim()) {
    // Escaped: a search box must never be able to inject a regex that pins a
    // CPU core on a large collection.
    const rx = new RegExp(f.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    match.$or = [{ callId: rx }, { fromUser: rx }, { toUser: rx }, { fromUri: rx }, { toUri: rx }];
  }

  const pipeline: Record<string, unknown>[] = [
    { $match: match },
    { $sort: { timestamp: 1, seq: 1 } },
    {
      $group: {
        _id: '$callId',
        startTime: { $first: '$timestamp' },
        endTime: { $last: '$timestamp' },
        messageCount: { $sum: 1 },
        methods: { $push: '$method' },
        statuses: { $push: '$statusCode' },
        fromUser: { $first: '$fromUser' },
        toUser: { $first: '$toUser' },
        sources: { $addToSet: '$source' },
      },
    },
  ];
  if (f.method) pipeline.push({ $match: { methods: f.method.toUpperCase() } });
  // Applied after $group, because "is this dialog a call" is a property of the
  // whole dialog, not of any one message: matching INVITE before grouping
  // would return a dialog consisting only of its INVITE and drop the replies,
  // the ACK and the BYE that make it a call worth looking at.
  if ((f.kind ?? 'calls') === 'calls') pipeline.push({ $match: { methods: 'INVITE' } });
  pipeline.push({ $sort: { startTime: -1 } });

  const countAgg = await col(db)
    .aggregate([...pipeline, { $count: 'n' }])
    .toArray();
  const total = countAgg.length ? (countAgg[0] as any).n : 0;

  const rows = await col(db)
    .aggregate([...pipeline, { $skip: (page - 1) * pageSize }, { $limit: pageSize }])
    .toArray();

  return {
    rows: rows.map((r: any) => {
      const methods: (string | undefined)[] = r.methods ?? [];
      const statuses: (number | undefined)[] = (r.statuses ?? []).filter((s: unknown) => typeof s === 'number');
      return {
        callId: r._id,
        startTime: r.startTime,
        endTime: r.endTime,
        messageCount: r.messageCount,
        initialMethod: methods.find(m => !!m) ?? undefined,
        fromUser: r.fromUser,
        toUser: r.toUser,
        lastStatus: statuses.length ? statuses[statuses.length - 1] : undefined,
        sources: (r.sources ?? []).filter((s: unknown): s is SipTraceSource => !!s),
      };
    }),
    total,
    page,
    pageSize,
  };
}

/** Every message of one call, oldest first -- the ladder's input. */
export async function getCallMessages(db: Db, callId: string): Promise<SipTraceDocument[]> {
  return col(db)
    .find({ callId })
    .sort({ timestamp: 1, seq: 1 })
    .limit(2000)
    .toArray();
}

export async function countMessages(db: Db): Promise<number> {
  return col(db).estimatedDocumentCount();
}
