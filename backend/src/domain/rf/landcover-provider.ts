// ESA WorldCover 10m global land-cover tiles ("v200", 2021 map layer),
// fetched on demand from the public, unauthenticated ESA WorldCover S3
// bucket and cached on the host — the same "free public data, no API key,
// graceful null on failure" posture as elevation-provider.ts's SRTM tiles.
// Verified directly against the primary source, not recalled: the S3
// bucket/key format was confirmed with a real `ListObjectsV2` call (not
// just documentation), and the class-code table below is transcribed from
// Table 3 (p.15-16) of ESA's own WorldCover_PUM_V2.0.pdf Product User
// Manual, fetched and read directly — CC BY 4.0, no restriction of use.
//
// Two real differences from elevation-provider.ts's pattern, not a blind
// copy-paste:
//  1. Tile grid is 3°x3°, not 1°x1° — WorldCover's own tiling scheme,
//     confirmed from real S3 keys (e.g. ESA_WorldCover_10m_2021_v200_
//     N00E006_Map.tif, N00E009_Map.tif, ... always 3° apart).
//  2. A decoded 3° tile at 10m is ~33,000x33,000 pixels — roughly 1GB+ if
//     fully decoded, unlike SRTM1's ~26MB (elevation-provider happily
//     keeps 8 of those fully decoded in memory). Never decode a whole
//     tile: cache only the parsed GeoTIFFImage handle (cheap — file
//     offsets/IFD metadata, geotiff.js doesn't eagerly decode pixels) and
//     do a windowed single-pixel readRasters() per query — Cloud-
//     Optimized GeoTIFFs are internally tiled specifically to make this
//     cheap without ever touching the rest of the file. The on-host disk
//     cache (raw .tif bytes) is what avoids re-hitting the network, not an
//     in-memory full decode.

import * as fs from 'fs/promises';
import * as path from 'path';
import pino from 'pino';
import type { GeoTIFFImage } from 'geotiff';
import { HataEnvironment, Cost231CityType } from './rf-types';

// geotiff.js@3.0.5's CJS build (dist-node, what a static `import` compiles
// to under this project's commonjs module target) is broken: its own
// dependency quick-lru went ESM-only from v5 onward, but geotiff's CJS
// entry still requires() it directly — confirmed live, a real upstream
// packaging bug, not a config mistake here. A genuine dynamic import()
// (following geotiff's package.json "import" condition to its ESM build,
// which loads quick-lru as ESM too) fixes it — but tsc, under this
// project's commonjs module target, downlevels a literal `import()`
// expression right back into `Promise.resolve().then(() => require(...))`
// (confirmed by inspecting the compiled output), which hits the exact same
// broken require(). Constructing the import call from a string via
// `new Function` hides it from tsc's static transform entirely, so the
// emitted code keeps Node's real, native dynamic import — a standard,
// widely-used workaround for loading an ESM-only dependency from CJS
// TypeScript, not a hack specific to this file. Cached so module
// resolution only happens once, not per tile.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<typeof import('geotiff')>;
let geotiffModulePromise: Promise<typeof import('geotiff')> | null = null;
function loadGeotiffModule(): Promise<typeof import('geotiff')> {
  if (geotiffModulePromise == null) {
    geotiffModulePromise = dynamicImport('geotiff');
  }
  return geotiffModulePromise;
}

const WORLDCOVER_TILE_STEP_DEG = 3;
const WORLDCOVER_BASE_URL = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map';
const TILE_CACHE_DIR = '/proc/1/root/opt/open5gs-nms/landcover-cache';
const MAX_CACHED_IMAGE_HANDLES = 8;
const FETCH_TIMEOUT_MS = 30_000;

// Table 3, "Coding of the Map layer and definition of the classes" —
// WorldCover_PUM_V2.0.pdf p.15-16. These are the literal single-band pixel
// values in the Map GeoTIFF, not an index into some other table.
export enum WorldCoverClass {
  TreeCover = 10,
  Shrubland = 20,
  Grassland = 30,
  Cropland = 40,
  BuiltUp = 50,
  BareOrSparseVegetation = 60,
  SnowAndIce = 70,
  PermanentWaterBodies = 80,
  HerbaceousWetland = 90,
  Mangroves = 95,
  MossAndLichen = 100,
}

export interface AutoDetectedEnvironment {
  environment: HataEnvironment;
  cityType: Cost231CityType;
  worldCoverClass: WorldCoverClass;
}

// WorldCover's 11 classes don't distinguish clutter *density* within
// "not built-up" — a city's own low-density suburbs read identically to
// open farmland in this dataset (both are just Cropland/Grassland/Tree
// cover). So this is a genuinely coarse, binary convention this tool is
// choosing (built-up vs. everything else), not a WorldCover- or 3GPP-
// specified mapping — every caller must disclose this via the pushed
// Assumption's reason text, never present it as more precise than it is.
export function environmentFromWorldCoverClass(cls: WorldCoverClass): AutoDetectedEnvironment {
  if (cls === WorldCoverClass.BuiltUp) {
    return { environment: 'urban', cityType: 'metropolitan', worldCoverClass: cls };
  }
  return { environment: 'open', cityType: 'medium', worldCoverClass: cls };
}

export interface LandCoverTileCoords {
  swLat: number;
  swLon: number;
}

export function tileSwCornerForLatLon(lat: number, lon: number): LandCoverTileCoords {
  return {
    swLat: Math.floor(lat / WORLDCOVER_TILE_STEP_DEG) * WORLDCOVER_TILE_STEP_DEG,
    swLon: Math.floor(lon / WORLDCOVER_TILE_STEP_DEG) * WORLDCOVER_TILE_STEP_DEG,
  };
}

export function tileKeyFor(coords: LandCoverTileCoords): string {
  const latHemi = coords.swLat >= 0 ? 'N' : 'S';
  const lonHemi = coords.swLon >= 0 ? 'E' : 'W';
  const latMag = Math.abs(coords.swLat).toString().padStart(2, '0');
  const lonMag = Math.abs(coords.swLon).toString().padStart(3, '0');
  return `${latHemi}${latMag}${lonHemi}${lonMag}`;
}

function tileUrl(tileKey: string): string {
  return `${WORLDCOVER_BASE_URL}/ESA_WorldCover_10m_2021_v200_${tileKey}_Map.tif`;
}

function tilePath(tileKey: string): string {
  return path.join(TILE_CACHE_DIR, `${tileKey}.tif`);
}

function etagPath(tileKey: string): string {
  return path.join(TILE_CACHE_DIR, `${tileKey}.etag`);
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function fetchTile(tileKey: string, logger?: pino.Logger): Promise<{ bytes: Buffer; etag: string | null } | null> {
  const url = tileUrl(tileKey);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      logger?.warn({ tileKey, status: res.status }, 'landcover-provider: tile not available (likely ocean/void tile or fetch failure)');
      return null;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    return { bytes, etag: res.headers.get('etag') };
  } catch (err) {
    logger?.warn({ tileKey, err: String(err) }, 'landcover-provider: tile download failed — falling back to no-land-cover-data for this tile');
    return null;
  }
}

async function writeDiskCache(tileKey: string, bytes: Buffer, etag: string | null): Promise<void> {
  try {
    await fs.mkdir(TILE_CACHE_DIR, { recursive: true });
    const tmpPath = `${tilePath(tileKey)}.tmp.${Date.now()}`;
    await fs.writeFile(tmpPath, bytes);
    await fs.rename(tmpPath, tilePath(tileKey));
    if (etag) await fs.writeFile(etagPath(tileKey), etag, 'utf8');
  } catch {
    // Cache-write failure isn't fatal — the tile still gets used from
    // memory for this process's lifetime, just re-downloaded next restart.
  }
}

const imageCache = new Map<string, GeoTIFFImage>();

function imageCacheGet(tileKey: string): GeoTIFFImage | undefined {
  const image = imageCache.get(tileKey);
  if (image) {
    imageCache.delete(tileKey);
    imageCache.set(tileKey, image);
  }
  return image;
}

function imageCacheSet(tileKey: string, image: GeoTIFFImage): void {
  imageCache.set(tileKey, image);
  if (imageCache.size > MAX_CACHED_IMAGE_HANDLES) {
    const oldest = imageCache.keys().next().value;
    if (oldest !== undefined) imageCache.delete(oldest);
  }
}

async function parseImage(bytes: Buffer): Promise<GeoTIFFImage> {
  const { fromArrayBuffer } = await loadGeotiffModule();
  const tiff = await fromArrayBuffer(toArrayBuffer(bytes));
  return tiff.getImage();
}

async function loadImage(tileKey: string, logger?: pino.Logger): Promise<GeoTIFFImage | null> {
  const cached = imageCacheGet(tileKey);
  if (cached) return cached;

  let bytes: Buffer | null = null;
  try {
    bytes = await fs.readFile(tilePath(tileKey));
  } catch {
    bytes = null;
  }

  if (!bytes) {
    const fetched = await fetchTile(tileKey, logger);
    if (!fetched) return null;
    bytes = fetched.bytes;
    await writeDiskCache(tileKey, fetched.bytes, fetched.etag);
  }

  try {
    const image = await parseImage(bytes);
    imageCacheSet(tileKey, image);
    return image;
  } catch (err) {
    logger?.warn({ tileKey, err: String(err) }, 'landcover-provider: tile failed to parse as GeoTIFF, discarding');
    return null;
  }
}

// A coordinate exactly on (or floating-point-noise away from) a tile's own
// edge can compute an index exactly at `size` rather than `size-1` — found
// live: lat=42.0 against a tile spanning [42,45) computed row=36000 for a
// 36000-pixel-tall tile, one past the last valid index, purely from
// dividing by a resolution (1/12000°) that isn't exactly representable in
// floating point. Snapping a by-1 overshoot to the nearest edge pixel is
// correct here — the real-world position differs by a fraction of a 10m
// pixel either way — while anything further out of range still means the
// wrong tile was selected and stays a real null, not silently guessed.
export function snapToTileEdge(index: number, size: number): number | null {
  if (index < 0) return index >= -1 ? 0 : null;
  if (index >= size) return index <= size ? size - 1 : null;
  // Normalize -0 (a real, distinct IEEE-754 value produced whenever a
  // point lands exactly on the tile's north/west edge, e.g. 0 / -resY) to
  // plain 0 — behaviorally identical for array/window indexing either way,
  // but a caller comparing the returned index shouldn't have to know that.
  return index === 0 ? 0 : index;
}

export interface PixelIndices {
  row: number;
  col: number;
}

// Pure coordinate math, split out from getLandCoverClass so it can be unit-
// tested hermetically (no real GeoTIFF parsing/network) — same reasoning
// as elevation-provider.ts's elevationFromTile being its own testable unit.
export function pixelIndicesForLatLon(
  lat: number, lon: number, originX: number, originY: number, resX: number, resY: number, width: number, height: number,
): PixelIndices | null {
  const col = snapToTileEdge(Math.floor((lon - originX) / resX), width);
  const row = snapToTileEdge(Math.floor((lat - originY) / resY), height);
  return col == null || row == null ? null : { row, col };
}

export async function getLandCoverClass(lat: number, lon: number, logger?: pino.Logger): Promise<WorldCoverClass | null> {
  const coords = tileSwCornerForLatLon(lat, lon);
  const tileKey = tileKeyFor(coords);
  const image = await loadImage(tileKey, logger);
  if (!image) return null;

  const [originX, originY] = image.getOrigin();
  const [resX, resY] = image.getResolution();
  const indices = pixelIndicesForLatLon(lat, lon, originX, originY, resX, resY, image.getWidth(), image.getHeight());
  if (!indices) return null;
  const { row, col } = indices;

  try {
    const raster = await image.readRasters({ window: [col, row, col + 1, row + 1] });
    const value = raster[0][0];
    return value in WorldCoverClass ? (value as WorldCoverClass) : null;
  } catch (err) {
    logger?.warn({ tileKey, lat, lon, err: String(err) }, 'landcover-provider: windowed pixel read failed');
    return null;
  }
}

// Startup freshness check — matches this project's existing "synced on
// startup" convention (Prometheus config sync, GenieACS provision sync in
// index.ts). Only re-checks tiles a previous run already cached; a fresh
// install with nothing cached yet does nothing here, exactly like the
// elevation cache populates lazily as different areas get planned rather
// than pre-warming the whole dataset.
export async function refreshStaleLandCoverTiles(logger?: pino.Logger): Promise<{ checked: number; refreshed: number }> {
  let files: string[];
  try {
    files = await fs.readdir(TILE_CACHE_DIR);
  } catch {
    return { checked: 0, refreshed: 0 };
  }

  const tileKeys = files.filter(f => f.endsWith('.tif')).map(f => f.slice(0, -'.tif'.length));
  let refreshed = 0;

  for (const tileKey of tileKeys) {
    try {
      const storedEtag = await fs.readFile(etagPath(tileKey), 'utf8').catch(() => null);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const head = await fetch(tileUrl(tileKey), { method: 'HEAD', signal: controller.signal });
      clearTimeout(timeout);
      if (!head.ok) continue;
      const liveEtag = head.headers.get('etag');
      if (!liveEtag || liveEtag === storedEtag) continue;

      const fetched = await fetchTile(tileKey, logger);
      if (!fetched) continue;
      await writeDiskCache(tileKey, fetched.bytes, fetched.etag);
      imageCache.delete(tileKey);
      refreshed++;
      logger?.info({ tileKey }, 'landcover-provider: cached tile updated upstream, re-downloaded');
    } catch (err) {
      logger?.warn({ tileKey, err: String(err) }, 'landcover-provider: freshness check failed for tile, keeping cached version');
    }
  }

  return { checked: tileKeys.length, refreshed };
}
