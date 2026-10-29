import { Db } from 'mongodb';
import { DialogScope } from './call-scope';
import { ResolvedParty } from './call-debug-resolve';
import { SIP_TRACE_COLLECTION, SipTraceDocument } from './sip-trace-store';

// ── Call Debug session storage ───────────────────────────────────────────────
//
// One row per debugging session. Tiny and long-lived, deliberately unlike the
// trace messages it points at.

export const CALL_DEBUG_COLLECTION = 'nms_call_debug_sessions';

/** Mirrors the trace's own cap so a snapshot cannot become unbounded. */
export const SNAPSHOT_LIMIT = 2000;

export type CallDebugStatus = 'running' | 'stopped' | 'interrupted' | 'failed';

export interface CallDebugCounters {
  matched: number;
  filtered: number;
  keepalives: number;
  unparsedKept: number;
}

export interface CallDebugSession {
  id: string;
  label: string;
  status: CallDebugStatus;
  startedAt: Date;
  stoppedAt?: Date;
  startedBy: string;
  /** What the operator typed, plus everything we resolved about it. */
  parties: ResolvedParty[];
  /** Flattened identity list actually handed to the collector. */
  identities: string[];
  dialogScope: DialogScope;
  tagOnly: boolean;
  /** Advisory lines computed at start (registration / IPsec readiness). */
  readiness: string[];
  pcapId?: string;
  pcapError?: string;
  bpf?: string;
  interfaces?: string[];
  autostopSeconds?: number;
  autostopFilesizeKb?: number;
  /**
   * Whether SIP tracing was ALREADY on before this session turned it on.
   * Persisted rather than held in memory because it is the only way a crash
   * mid-session can be unwound correctly -- setSipTracingEnabled(true) writes
   * `sipTracingEnabled` into the host IMS state, so tracing survives a backend
   * restart by design while the in-memory scope filter does not. Without this
   * field, reconciliation would leave tracing forced on with nothing scoping
   * it: unbounded capture, in the feature built to prevent exactly that.
   */
  tracingWasEnabled: boolean;
  counters: CallDebugCounters;
  /**
   * The session's own matched messages, copied in at stop.
   *
   * Necessary because of a retention asymmetry that is easy to get backwards:
   * nms_sip_trace has a TTL index (24h by default, verified live), while this
   * session row and its pcap file have none. Without a snapshot, a session
   * would outlive the very dialogs it points at and its view would silently
   * return nothing, while `/calls/:id/messages` answered 404 "it may have aged
   * out".
   */
  snapshot?: { takenAt: Date; truncated: boolean; messages: SipTraceDocument[] };
  snapshotError?: string;
}

const col = (db: Db) => db.collection<CallDebugSession>(CALL_DEBUG_COLLECTION);

export async function ensureCallDebugIndexes(db: Db): Promise<void> {
  const c = col(db);
  await c.createIndex({ id: 1 }, { unique: true }).catch(() => {});
  await c.createIndex({ startedAt: -1 }).catch(() => {});
  // At most one running session, enforced by the DATABASE rather than by a
  // read-then-write check in the handler. Express serves requests
  // concurrently, so two browser tabs pressing Start together would otherwise
  // both pass an "is one running?" test and produce two sessions, two pcaps
  // and a last-write-wins scope filter. A unique partial index makes the
  // second insert fail instead.
  await c
    .createIndex(
      { status: 1 },
      { unique: true, partialFilterExpression: { status: 'running' } },
    )
    .catch(() => {});
}

export async function insertSession(db: Db, s: CallDebugSession): Promise<void> {
  await col(db).insertOne(s as never);
}

export async function getSession(db: Db, id: string): Promise<CallDebugSession | null> {
  return col(db).findOne({ id }, { projection: { snapshot: 0 } }) as Promise<CallDebugSession | null>;
}

/** Includes the snapshot; used by the detail view. */
export async function getSessionFull(db: Db, id: string): Promise<CallDebugSession | null> {
  return col(db).findOne({ id }) as Promise<CallDebugSession | null>;
}

export async function getRunningSession(db: Db): Promise<CallDebugSession | null> {
  return col(db).findOne({ status: 'running' }, { projection: { snapshot: 0 } }) as Promise<CallDebugSession | null>;
}

export async function listSessions(db: Db, limit = 50): Promise<CallDebugSession[]> {
  return col(db)
    .find({}, { projection: { snapshot: 0 } })
    .sort({ startedAt: -1 })
    .limit(Math.min(200, Math.max(1, limit)))
    .toArray() as Promise<CallDebugSession[]>;
}

export async function updateSession(db: Db, id: string, patch: Partial<CallDebugSession>): Promise<void> {
  await col(db).updateOne({ id }, { $set: patch as never });
}

export async function deleteSession(db: Db, id: string): Promise<void> {
  await col(db).deleteOne({ id });
}

/**
 * Copy this session's matched messages into the session row.
 *
 * Bounded and best-effort: a snapshot failure must never stop a session from
 * being closed out, or a transient Mongo problem would leave a session stuck
 * 'running' with the collector still scoped.
 */
export async function snapshotSession(db: Db, id: string): Promise<{ count: number; truncated: boolean }> {
  const messages = (await db
    .collection<SipTraceDocument>(SIP_TRACE_COLLECTION)
    .find({ sessionId: id })
    .sort({ timestamp: 1, seq: 1 })
    .limit(SNAPSHOT_LIMIT + 1)
    .toArray()) as SipTraceDocument[];
  const truncated = messages.length > SNAPSHOT_LIMIT;
  const kept = truncated ? messages.slice(0, SNAPSHOT_LIMIT) : messages;
  await updateSession(db, id, {
    snapshot: { takenAt: new Date(), truncated, messages: kept },
  });
  return { count: kept.length, truncated };
}

export async function countSessionMessages(db: Db, id: string): Promise<number> {
  return db.collection<SipTraceDocument>(SIP_TRACE_COLLECTION).countDocuments({ sessionId: id });
}
