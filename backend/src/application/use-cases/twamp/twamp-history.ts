import { Db } from 'mongodb';
import { TwampProtocol, TwampTestResult } from './twamp-runner';

// ── TWAMP long-term history ──────────────────────────────────────────────
//
// Every real TWAMP test this app runs (background poll AND on-demand "Test
// Now") already produces one full result — this just persists that result
// as-is into its own Mongo collection instead of only caching the latest in
// memory (TwampMonitor's own job). No separate sampling loop/cadence to
// invent: the natural "best interval to track" IS each target's own
// pollIntervalSeconds, since that's already a real network operation
// happening at that cadence — storing anything finer would just duplicate
// data, and anything coarser would throw away real results. Query-time
// bucketing (see pickBucketMs/queryHistorySeries) is what keeps a 30-day
// graph fast regardless of how fine the raw cadence is.
//
// Deliberately Mongo-backed rather than Prometheus-backed, unlike Traffic
// History (see CLAUDE.md pattern #12) — this feature specifically needs
// PER-FEATURE configurable retention ("keep 7 days" vs "keep 90 days"),
// which Prometheus can't do (one shared TSDB, one global
// --storage.tsdb.retention.time for every NF/feature). A Mongo TTL index
// gives that natively and can be changed live via collMod, without touching
// Prometheus's own retention or affecting any other metric.

export const TWAMP_HISTORY_COLLECTION = 'nms_twamp_history';
export const DEFAULT_HISTORY_RETENTION_DAYS = 30;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 365;

export interface TwampHistorySample {
  targetId: string;
  name: string;
  host: string;
  protocol: TwampProtocol;
  timestamp: Date;
  success: boolean;
  error?: string;
  avgRttMs?: number;
  minRttMs?: number;
  maxRttMs?: number;
  jitterMs?: number;
  avgForwardDelayMs?: number;
  avgReverseDelayMs?: number;
  delayAsymmetryMs?: number;
  packetsSent?: number;
  packetsReceived?: number;
  packetsLost?: number;
  packetLossRatio?: number;
}

export interface HistorySummaryRow {
  targetId: string;
  name: string;
  host: string;
  protocol: TwampProtocol;
  sampleCount: number;
  successCount: number;
  avgRttMs: number | null;
  minRttMs: number | null;
  maxRttMs: number | null;
  avgJitterMs: number | null;
  avgPacketLossRatio: number | null;
  lastTimestampMs: number;
  lastSuccess: boolean;
}

export interface HistorySeriesPoint {
  ts: number;
  avgRttMs: number | null;
  minRttMs: number | null;
  maxRttMs: number | null;
  jitterMs: number | null;
  packetLossRatio: number | null;
  sampleCount: number;
}

function col(db: Db) {
  return db.collection<TwampHistorySample>(TWAMP_HISTORY_COLLECTION);
}

export async function recordTwampHistorySample(
  db: Db,
  target: { _id: unknown; name: string; host: string; protocol: TwampProtocol },
  result: TwampTestResult,
): Promise<void> {
  const packetLossRatio = result.packetsSent && result.packetsSent > 0
    ? (result.packetsLost ?? 0) / result.packetsSent
    : undefined;
  const doc: TwampHistorySample = {
    targetId: String(target._id),
    name: target.name,
    host: target.host,
    protocol: target.protocol,
    timestamp: new Date(),
    success: result.success,
    error: result.error,
    avgRttMs: result.avgRttMs,
    minRttMs: result.minRttMs,
    maxRttMs: result.maxRttMs,
    jitterMs: result.jitterMs,
    avgForwardDelayMs: result.avgForwardDelayMs,
    avgReverseDelayMs: result.avgReverseDelayMs,
    delayAsymmetryMs: result.delayAsymmetryMs,
    packetsSent: result.packetsSent,
    packetsReceived: result.packetsReceived,
    packetsLost: result.packetsLost,
    packetLossRatio,
  };
  await col(db).insertOne(doc as any);
}

// Idempotent — safe to call on every backend startup and every retention
// change. TTL indexes only expire documents whose indexed field is a real
// BSON Date (recordTwampHistorySample always stores one), checked against
// wall-clock time by a background mongod thread (typically within ~60s of
// expiry, not instant — fine for a "keep N days" feature).
export async function ensureHistoryIndexes(db: Db, retentionDays: number): Promise<void> {
  const c = col(db);
  const seconds = Math.max(1, Math.round(retentionDays * 86400));
  const indexes = await c.indexes().catch(() => [] as any[]);
  const ttlIndex = indexes.find((ix: any) => ix.key && Object.keys(ix.key).length === 1 && ix.key.timestamp === 1 && ix.expireAfterSeconds !== undefined);
  if (!ttlIndex) {
    await c.createIndex({ timestamp: 1 }, { expireAfterSeconds: seconds });
  } else if (ttlIndex.expireAfterSeconds !== seconds) {
    await db.command({ collMod: TWAMP_HISTORY_COLLECTION, index: { keyPattern: { timestamp: 1 }, expireAfterSeconds: seconds } });
  }
  // Separate, non-TTL compound index for the actual query pattern below
  // (filter by target + time range) — the TTL index alone isn't shaped for
  // that.
  const queryIndex = indexes.find((ix: any) => ix.key && ix.key.targetId === 1 && ix.key.timestamp === 1);
  if (!queryIndex) {
    await c.createIndex({ targetId: 1, timestamp: 1 });
  }
}

// Per-target rollup over [from, to] for the sortable overview table —
// worst-to-best RTT sorting happens client-side once this small (one row
// per target) result set is loaded.
export async function queryHistorySummary(db: Db, from: Date, to: Date): Promise<HistorySummaryRow[]> {
  const rows = await col(db).aggregate([
    { $match: { timestamp: { $gte: from, $lte: to } } },
    { $sort: { timestamp: -1 } },
    {
      $group: {
        _id: '$targetId',
        name: { $first: '$name' },
        host: { $first: '$host' },
        protocol: { $first: '$protocol' },
        sampleCount: { $sum: 1 },
        successCount: { $sum: { $cond: ['$success', 1, 0] } },
        avgRttMs: { $avg: { $cond: ['$success', '$avgRttMs', '$$REMOVE'] } },
        minRttMs: { $min: { $cond: ['$success', '$minRttMs', '$$REMOVE'] } },
        maxRttMs: { $max: { $cond: ['$success', '$maxRttMs', '$$REMOVE'] } },
        avgJitterMs: { $avg: { $cond: ['$success', '$jitterMs', '$$REMOVE'] } },
        avgPacketLossRatio: { $avg: { $cond: ['$success', '$packetLossRatio', '$$REMOVE'] } },
        lastTimestamp: { $max: '$timestamp' },
        lastSuccess: { $first: '$success' },
      },
    },
  ]).toArray();

  return rows.map((r: any) => ({
    targetId: r._id,
    name: r.name,
    host: r.host,
    protocol: r.protocol,
    sampleCount: r.sampleCount,
    successCount: r.successCount,
    avgRttMs: r.avgRttMs ?? null,
    minRttMs: r.minRttMs ?? null,
    maxRttMs: r.maxRttMs ?? null,
    avgJitterMs: r.avgJitterMs ?? null,
    avgPacketLossRatio: r.avgPacketLossRatio ?? null,
    lastTimestampMs: r.lastTimestamp instanceof Date ? r.lastTimestamp.getTime() : Number(r.lastTimestamp),
    lastSuccess: !!r.lastSuccess,
  }));
}

// Snaps to a sensible bucket width so a graph never has to render more than
// ~roughly targetPoints points, regardless of how wide a range (up to the
// full 30+ day retention) is requested — short ranges stay at native
// per-test resolution (a 15-minute view at a 60s poll interval needs no
// bucketing at all: 15 buckets), wide ranges get coarser automatically.
const BUCKET_OPTIONS_MS = [
  1_000, 5_000, 10_000, 30_000, 60_000,
  5 * 60_000, 15 * 60_000, 30 * 60_000,
  3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000,
  24 * 3_600_000, 3 * 24 * 3_600_000,
];
export function pickBucketMs(rangeMs: number, targetPoints = 300): number {
  const raw = rangeMs / targetPoints;
  for (const option of BUCKET_OPTIONS_MS) if (raw <= option) return option;
  return BUCKET_OPTIONS_MS[BUCKET_OPTIONS_MS.length - 1];
}

// Bucketed time series for one target's drill-down graph.
export async function queryHistorySeries(
  db: Db, targetId: string, from: Date, to: Date, bucketMs: number,
): Promise<HistorySeriesPoint[]> {
  const rows = await col(db).aggregate([
    { $match: { targetId, timestamp: { $gte: from, $lte: to } } },
    {
      $addFields: {
        _tsMs: { $toLong: '$timestamp' },
      },
    },
    {
      $addFields: {
        _bucket: { $subtract: ['$_tsMs', { $mod: ['$_tsMs', bucketMs] }] },
      },
    },
    {
      $group: {
        _id: '$_bucket',
        avgRttMs: { $avg: { $cond: ['$success', '$avgRttMs', '$$REMOVE'] } },
        minRttMs: { $min: { $cond: ['$success', '$minRttMs', '$$REMOVE'] } },
        maxRttMs: { $max: { $cond: ['$success', '$maxRttMs', '$$REMOVE'] } },
        jitterMs: { $avg: { $cond: ['$success', '$jitterMs', '$$REMOVE'] } },
        packetLossRatio: { $avg: { $cond: ['$success', '$packetLossRatio', '$$REMOVE'] } },
        sampleCount: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]).toArray();

  return rows.map((r: any) => ({
    ts: Number(r._id),
    avgRttMs: r.avgRttMs ?? null,
    minRttMs: r.minRttMs ?? null,
    maxRttMs: r.maxRttMs ?? null,
    jitterMs: r.jitterMs ?? null,
    packetLossRatio: r.packetLossRatio ?? null,
    sampleCount: r.sampleCount,
  }));
}
