import { Db } from 'mongodb';
import { TwampProtocol } from './twamp-runner';

// ── TWAMP reflector (server-side) long-term history ──────────────────────
//
// The client half of this module already has history (twamp-history.ts):
// every target test produces a full result, so the natural sample IS the
// test. The reflector half has no equivalent event — nothing here initiates
// anything, remote devices do — so "who was testing against us, how hard,
// and was our reflector even up" only exists as a live snapshot
// (getFullConnections/getLightPeers + the reflector's own loopback
// Prometheus endpoint). That made the History tab client-only: every
// reflector reading on the Info & Stats page was a 5-second window into
// right now, with no way to answer "did that radio stop testing at 03:00?".
//
// So this half needs its own sampling loop (TwampReflectorMonitor) and its
// own store. Mongo-backed, sharing the client side's single configurable
// retention setting, for exactly the reason twamp-history.ts documents: the
// operator-facing "keep N days" control is per-feature, which a shared
// Prometheus TSDB cannot express (one global
// --storage.tsdb.retention.time). One retention value covers both halves —
// there is no sensible reason to keep one side of the same page's history
// longer than the other.
//
// ONE DOCUMENT PER TICK, holding a peers array — not one document per peer.
// That is what makes "zero clients connected" a real, graphable reading
// instead of an absence: per-peer documents would write nothing at all for
// an idle tick, so a genuine zero and a sampler that was not running would
// render identically (a gap). Every tick writes exactly one document even
// when the reflector is stopped, so downtime is visible rather than
// inferred.

export const TWAMP_REFLECTOR_HISTORY_COLLECTION = 'nms_twamp_reflector_history';

export interface ReflectorPeerSample {
  /**
   * Peer IDENTITY is the IP, deliberately not ip:port. A TWAMP-Light
   * sender's ephemeral source port legitimately changes between test runs
   * (see twamp-server.go's lightPeers map comment), so keying history on
   * ip:port would scatter one radio's history across a new series every
   * time it restarted a session. `sessions` below keeps the port detail
   * that matters without that cost.
   */
  peerIp: string;
  protocol: TwampProtocol;
  /** Distinct ip:port sessions this peer IP had open at sample time. */
  sessions: number;
  /**
   * Cumulative reflected-packet counter for this peer, as the reflector
   * itself reports it (twamp_light_packets_reflected_total). Light-only:
   * the full-protocol path has no per-peer counter, only aggregate library
   * counters, so this and the two fields below stay undefined there.
   */
  packetsReflected?: number;
  /** Packets reflected since the previous tick — see reflectorCounterDelta(). */
  packetsDelta?: number;
  /**
   * packetsDelta over the real elapsed time between the two ticks. Stored
   * alongside the raw delta rather than derived at query time because the
   * elapsed interval varies per sample (a slow tick, a restarted backend),
   * so only the sampler knows the correct divisor. Query-time bucketing
   * then averages a real rate instead of dividing a summed count by an
   * assumed cadence.
   */
  packetsPerSec?: number;
  lastSeenMs?: number;
}

export interface TwampReflectorSample {
  timestamp: Date;
  /** systemctl is-active twamp-server — the same signal /server/status reports. */
  serviceActive: boolean;
  enableFull: boolean;
  enableLight: boolean;
  /** Distinct peer IPs, by protocol. */
  fullPeers: number;
  lightPeers: number;
  totalPeers: number;
  /** Sum of every peer's packetsPerSec this tick (undefined on the first tick). */
  packetsPerSec?: number;
  peers: ReflectorPeerSample[];
}

export interface ReflectorSummaryRow {
  peerIp: string;
  protocol: TwampProtocol;
  /** Ticks in the range where this peer was present. */
  presentSamples: number;
  /** Exact packets reflected to this peer within the range. */
  packetsInRange: number | null;
  avgPacketsPerSec: number | null;
  maxPacketsPerSec: number | null;
  maxSessions: number;
  firstSeenMs: number;
  lastSeenMs: number;
}

export interface ReflectorSummary {
  rows: ReflectorSummaryRow[];
  /** Total ticks stored in the range — the denominator for a presence %. */
  totalSamples: number;
  /** Ticks where the reflector service was active. */
  activeSamples: number;
}

export interface ReflectorSeriesPoint {
  ts: number;
  avgFullPeers: number | null;
  maxFullPeers: number | null;
  avgLightPeers: number | null;
  maxLightPeers: number | null;
  avgTotalPeers: number | null;
  maxTotalPeers: number | null;
  avgPacketsPerSec: number | null;
  maxPacketsPerSec: number | null;
  /** Fraction of this bucket's ticks where the reflector was running (0-1). */
  upRatio: number;
  sampleCount: number;
}

export interface ReflectorPeerSeriesPoint {
  ts: number;
  avgPacketsPerSec: number | null;
  maxPacketsPerSec: number | null;
  packetsInBucket: number | null;
  maxSessions: number | null;
  /** Fraction of this bucket's ticks where this peer was present (0-1). */
  presenceRatio: number;
  sampleCount: number;
}

function col(db: Db) {
  return db.collection<TwampReflectorSample>(TWAMP_REFLECTOR_HISTORY_COLLECTION);
}

/**
 * Packets reflected between two consecutive readings of one peer's
 * cumulative counter.
 *
 * Prometheus counter semantics, deliberately: a value BELOW the previous
 * one means the reflector process restarted and its counters began again at
 * zero, so the current value is itself the real count since that restart
 * and is attributed to this interval. Dropping it instead would silently
 * erase whatever traffic arrived after a restart — exactly the window an
 * operator is most likely to be looking at. `undefined` is reserved for the
 * genuinely unknowable case: the first reading for a peer, where there is
 * no baseline to subtract.
 */
export function reflectorCounterDelta(prev: number | undefined, cur: number): number | undefined {
  if (prev === undefined || !Number.isFinite(prev)) return undefined;
  if (!Number.isFinite(cur) || cur < 0) return undefined;
  if (cur < prev) return cur;
  return cur - prev;
}

/**
 * Converts a packet delta to a per-second rate over the real elapsed
 * interval. Returns undefined when the interval is not usable (a clock
 * step, two samples in the same millisecond), rather than dividing by
 * ~zero and storing a nonsense spike.
 */
export function reflectorPacketRate(delta: number | undefined, elapsedMs: number): number | undefined {
  if (delta === undefined) return undefined;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 500) return undefined;
  return delta / (elapsedMs / 1000);
}

export async function recordReflectorHistorySample(db: Db, sample: TwampReflectorSample): Promise<void> {
  await col(db).insertOne(sample as any);
}

/**
 * Idempotent, and intentionally the same shape as twamp-history.ts's
 * ensureHistoryIndexes — called from the same three places (startup, the
 * retention-settings route, and a restore) so the two halves of this
 * module's history can never end up on different retention.
 */
export async function ensureReflectorHistoryIndexes(db: Db, retentionDays: number): Promise<void> {
  const c = col(db);
  const seconds = Math.max(1, Math.round(retentionDays * 86400));
  const indexes = await c.indexes().catch(() => [] as any[]);
  const ttlIndex = indexes.find((ix: any) => ix.key && Object.keys(ix.key).length === 1 && ix.key.timestamp === 1 && ix.expireAfterSeconds !== undefined);
  if (!ttlIndex) {
    await c.createIndex({ timestamp: 1 }, { expireAfterSeconds: seconds });
  } else if (ttlIndex.expireAfterSeconds !== seconds) {
    await db.command({ collMod: TWAMP_REFLECTOR_HISTORY_COLLECTION, index: { keyPattern: { timestamp: 1 }, expireAfterSeconds: seconds } });
  }
  // Unlike the client-side store there is no second, target-scoped query
  // pattern to index for: every query here is a pure time-range scan (the
  // per-peer drill-down filters inside each document's peers array, which
  // no index can serve), and the TTL index above is already keyed on
  // timestamp, so it serves those directly.
}

/** Per-peer rollup over [from, to] for the sortable reflector overview table. */
export async function queryReflectorSummary(db: Db, from: Date, to: Date): Promise<ReflectorSummary> {
  const match = { timestamp: { $gte: from, $lte: to } };

  const [totals] = await col(db).aggregate([
    { $match: match },
    { $group: { _id: null, totalSamples: { $sum: 1 }, activeSamples: { $sum: { $cond: ['$serviceActive', 1, 0] } } } },
  ]).toArray();

  const rows = await col(db).aggregate([
    { $match: match },
    { $sort: { timestamp: 1 } },
    { $unwind: '$peers' },
    {
      $group: {
        _id: '$peers.peerIp',
        protocol: { $last: '$peers.protocol' },
        presentSamples: { $sum: 1 },
        // $$REMOVE keeps a peer whose counter is unavailable (every
        // full-protocol peer) out of the average entirely, rather than
        // averaging in zeros that would read as "idle" instead of
        // "not measured".
        packetsInRange: { $sum: { $ifNull: ['$peers.packetsDelta', 0] } },
        avgPacketsPerSec: { $avg: { $ifNull: ['$peers.packetsPerSec', '$$REMOVE'] } },
        maxPacketsPerSec: { $max: { $ifNull: ['$peers.packetsPerSec', '$$REMOVE'] } },
        maxSessions: { $max: '$peers.sessions' },
        firstSeen: { $min: '$timestamp' },
        lastSeen: { $max: '$timestamp' },
        anyCounter: { $max: { $ifNull: ['$peers.packetsReflected', '$$REMOVE'] } },
      },
    },
  ]).toArray();

  return {
    totalSamples: totals?.totalSamples ?? 0,
    activeSamples: totals?.activeSamples ?? 0,
    rows: rows.map((r: any) => ({
      peerIp: r._id,
      protocol: r.protocol,
      presentSamples: r.presentSamples,
      // A peer with no counter at all (full protocol) reports null rather
      // than a summed 0, which would claim it reflected nothing.
      packetsInRange: r.anyCounter === undefined || r.anyCounter === null ? null : r.packetsInRange,
      avgPacketsPerSec: r.avgPacketsPerSec ?? null,
      maxPacketsPerSec: r.maxPacketsPerSec ?? null,
      maxSessions: r.maxSessions ?? 0,
      firstSeenMs: r.firstSeen instanceof Date ? r.firstSeen.getTime() : Number(r.firstSeen),
      lastSeenMs: r.lastSeen instanceof Date ? r.lastSeen.getTime() : Number(r.lastSeen),
    })),
  };
}

/** Bucketed aggregate series — connected clients and reflected throughput. */
export async function queryReflectorSeries(
  db: Db, from: Date, to: Date, bucketMs: number,
): Promise<ReflectorSeriesPoint[]> {
  const rows = await col(db).aggregate([
    { $match: { timestamp: { $gte: from, $lte: to } } },
    { $addFields: { _tsMs: { $toLong: '$timestamp' } } },
    { $addFields: { _bucket: { $subtract: ['$_tsMs', { $mod: ['$_tsMs', bucketMs] }] } } },
    {
      $group: {
        _id: '$_bucket',
        avgFullPeers: { $avg: '$fullPeers' },
        maxFullPeers: { $max: '$fullPeers' },
        avgLightPeers: { $avg: '$lightPeers' },
        maxLightPeers: { $max: '$lightPeers' },
        avgTotalPeers: { $avg: '$totalPeers' },
        maxTotalPeers: { $max: '$totalPeers' },
        avgPacketsPerSec: { $avg: { $ifNull: ['$packetsPerSec', '$$REMOVE'] } },
        maxPacketsPerSec: { $max: { $ifNull: ['$packetsPerSec', '$$REMOVE'] } },
        upSamples: { $sum: { $cond: ['$serviceActive', 1, 0] } },
        sampleCount: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]).toArray();

  return rows.map((r: any) => ({
    ts: Number(r._id),
    avgFullPeers: r.avgFullPeers ?? null,
    maxFullPeers: r.maxFullPeers ?? null,
    avgLightPeers: r.avgLightPeers ?? null,
    maxLightPeers: r.maxLightPeers ?? null,
    avgTotalPeers: r.avgTotalPeers ?? null,
    maxTotalPeers: r.maxTotalPeers ?? null,
    avgPacketsPerSec: r.avgPacketsPerSec ?? null,
    maxPacketsPerSec: r.maxPacketsPerSec ?? null,
    upRatio: r.sampleCount > 0 ? r.upSamples / r.sampleCount : 0,
    sampleCount: r.sampleCount,
  }));
}

/**
 * Bucketed series for ONE peer.
 *
 * Pulls the peer out of each tick's array with $arrayElemAt+$filter instead
 * of $unwind+$match, so a tick where the peer was ABSENT still contributes a
 * row. That is what makes presenceRatio a real measurement ("this radio was
 * testing for 40% of that hour") — $unwind would drop those ticks and every
 * bucket would trivially report 100% present.
 */
export async function queryReflectorPeerSeries(
  db: Db, peerIp: string, from: Date, to: Date, bucketMs: number,
): Promise<ReflectorPeerSeriesPoint[]> {
  const rows = await col(db).aggregate([
    { $match: { timestamp: { $gte: from, $lte: to } } },
    {
      $addFields: {
        _peer: {
          $arrayElemAt: [
            { $filter: { input: { $ifNull: ['$peers', []] }, as: 'p', cond: { $eq: ['$$p.peerIp', peerIp] } } },
            0,
          ],
        },
        _tsMs: { $toLong: '$timestamp' },
      },
    },
    { $addFields: { _bucket: { $subtract: ['$_tsMs', { $mod: ['$_tsMs', bucketMs] }] } } },
    {
      $group: {
        _id: '$_bucket',
        avgPacketsPerSec: { $avg: { $ifNull: ['$_peer.packetsPerSec', '$$REMOVE'] } },
        maxPacketsPerSec: { $max: { $ifNull: ['$_peer.packetsPerSec', '$$REMOVE'] } },
        packetsInBucket: { $sum: { $ifNull: ['$_peer.packetsDelta', 0] } },
        maxSessions: { $max: { $ifNull: ['$_peer.sessions', '$$REMOVE'] } },
        // $type, not a comparison against null: $arrayElemAt on an
        // empty array leaves the field MISSING, and missing-vs-null
        // comparison semantics in an aggregation expression are exactly
        // the kind of subtlety that silently reports every bucket as 100%
        // present. $type says "missing" or "object" with no ambiguity.
        presentSamples: { $sum: { $cond: [{ $eq: [{ $type: '$_peer' }, 'object'] }, 1, 0] } },
        sampleCount: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]).toArray();

  return rows.map((r: any) => ({
    ts: Number(r._id),
    avgPacketsPerSec: r.avgPacketsPerSec ?? null,
    maxPacketsPerSec: r.maxPacketsPerSec ?? null,
    packetsInBucket: r.packetsInBucket ?? null,
    maxSessions: r.maxSessions ?? null,
    presenceRatio: r.sampleCount > 0 ? r.presentSamples / r.sampleCount : 0,
    sampleCount: r.sampleCount,
  }));
}
