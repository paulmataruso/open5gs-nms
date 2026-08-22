// Self-hosted SRTM1 elevation tiles ("skadi" format: 1x1 degree, big-endian
// 16-bit signed integer .hgt grids, gzip on the wire), fetched on demand
// from the public, unauthenticated Tilezen/Mapzen S3 mirror and cached
// locally (in-memory LRU + a real host-filesystem cache, following this
// project's established pattern for bulky host data — see
// frr-source-build.ts, which writes to a real host path rather than a
// Docker volume). No API key or account needed — same free-public-data
// posture as the OpenStreetMap map tiles already used elsewhere in this
// feature.
//
// Unlike the browser-fetched map tiles, this data is needed by the
// calculation itself, so the BACKEND fetches it — a narrow, real outbound-
// internet dependency for the backend host, scoped to one fixed public S3
// URL pattern and only hit once per 1x1 degree tile ever touched. Designed
// to degrade gracefully: an unreachable tile (air-gapped host, network
// blip, ocean tile that doesn't exist) returns null, never throws — every
// caller decides how to fall back (see coverage-grid.ts's terrain
// integration), never a crash, never a silently-wrong number.
//
// Binary host-file I/O deliberately bypasses IHostExecutor (its
// readFile/writeFile are text/utf-8 only) and uses plain fs/promises
// against the real host path via /proc/1/root/, matching this codebase's
// existing precedent for binary data (pcap-controller.ts, log-download-
// controller.ts).

import * as fs from 'fs/promises';
import * as path from 'path';
import * as zlib from 'zlib';
import pino from 'pino';

export const SRTM1_SIZE = 3601;
const VOID_VALUE = -32768;
const SKADI_BASE_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/skadi';
const TILE_CACHE_DIR = '/proc/1/root/opt/open5gs-nms/terrain-cache';
const MAX_CACHED_TILES = 8;
const FETCH_TIMEOUT_MS = 15_000;

export interface TileCoords {
  swLat: number;
  swLon: number;
}

export function tileSwCornerForLatLon(lat: number, lon: number): TileCoords {
  return { swLat: Math.floor(lat), swLon: Math.floor(lon) };
}

export function tileKeyFor(coords: TileCoords): string {
  const latHemi = coords.swLat >= 0 ? 'N' : 'S';
  const lonHemi = coords.swLon >= 0 ? 'E' : 'W';
  const latMag = Math.abs(coords.swLat).toString().padStart(2, '0');
  const lonMag = Math.abs(coords.swLon).toString().padStart(3, '0');
  return `${latHemi}${latMag}${lonHemi}${lonMag}`;
}

// SRTM .hgt: rows run north to south (row 0 = north edge), columns run
// west to east, 16-bit big-endian signed integers. Parsing once at
// tile-load time via DataView (platform-endian typed arrays can't read
// big-endian data directly).
export function parseHgtBuffer(buf: Buffer, size: number): Int16Array {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Int16Array(size * size);
  for (let i = 0; i < size * size; i++) {
    out[i] = view.getInt16(i * 2, false);
  }
  return out;
}

export function elevationFromTile(tile: Int16Array, size: number, coords: TileCoords, lat: number, lon: number): number | null {
  const row = Math.round((coords.swLat + 1 - lat) * (size - 1));
  const col = Math.round((lon - coords.swLon) * (size - 1));
  if (row < 0 || row >= size || col < 0 || col >= size) return null;
  const value = tile[row * size + col];
  return value === VOID_VALUE ? null : value;
}

const memoryCache = new Map<string, Int16Array>();

function cacheGet(tileKey: string): Int16Array | undefined {
  const tile = memoryCache.get(tileKey);
  if (tile) {
    // Refresh recency (Map preserves insertion order) for simple LRU eviction.
    memoryCache.delete(tileKey);
    memoryCache.set(tileKey, tile);
  }
  return tile;
}

function cacheSet(tileKey: string, tile: Int16Array): void {
  memoryCache.set(tileKey, tile);
  if (memoryCache.size > MAX_CACHED_TILES) {
    const oldest = memoryCache.keys().next().value;
    if (oldest !== undefined) memoryCache.delete(oldest);
  }
}

async function readDiskCache(tileKey: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(path.join(TILE_CACHE_DIR, `${tileKey}.hgt`));
  } catch {
    return null;
  }
}

async function writeDiskCache(tileKey: string, raw: Buffer): Promise<void> {
  try {
    await fs.mkdir(TILE_CACHE_DIR, { recursive: true });
    const tmpPath = path.join(TILE_CACHE_DIR, `${tileKey}.hgt.tmp.${Date.now()}`);
    await fs.writeFile(tmpPath, raw);
    await fs.rename(tmpPath, path.join(TILE_CACHE_DIR, `${tileKey}.hgt`));
  } catch {
    // Cache-write failure isn't fatal — the tile still gets used from
    // memory for this process's lifetime, just re-downloaded next restart.
  }
}

async function downloadTile(tileKey: string, logger?: pino.Logger): Promise<Buffer | null> {
  const dirPart = tileKey.slice(0, 3); // e.g. "N37"
  const url = `${SKADI_BASE_URL}/${dirPart}/${tileKey}.hgt.gz`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      logger?.warn({ tileKey, status: res.status }, 'elevation-provider: tile not available (likely ocean/void tile or fetch failure)');
      return null;
    }
    const gzipped = Buffer.from(await res.arrayBuffer());
    return zlib.gunzipSync(gzipped);
  } catch (err) {
    logger?.warn({ tileKey, err: String(err) }, 'elevation-provider: tile download failed — falling back to no-terrain-data for this tile');
    return null;
  }
}

async function loadTile(tileKey: string, logger?: pino.Logger): Promise<Int16Array | null> {
  const cached = cacheGet(tileKey);
  if (cached) return cached;

  let raw = await readDiskCache(tileKey);
  if (!raw) {
    raw = await downloadTile(tileKey, logger);
    if (!raw) return null;
    await writeDiskCache(tileKey, raw);
  }

  if (raw.byteLength !== SRTM1_SIZE * SRTM1_SIZE * 2) {
    logger?.warn({ tileKey, byteLength: raw.byteLength }, 'elevation-provider: tile has unexpected size, discarding');
    return null;
  }

  const parsed = parseHgtBuffer(raw, SRTM1_SIZE);
  cacheSet(tileKey, parsed);
  return parsed;
}

export async function getElevationM(lat: number, lon: number, logger?: pino.Logger): Promise<number | null> {
  const coords = tileSwCornerForLatLon(lat, lon);
  const tileKey = tileKeyFor(coords);
  const tile = await loadTile(tileKey, logger);
  if (!tile) return null;
  return elevationFromTile(tile, SRTM1_SIZE, coords, lat, lon);
}
