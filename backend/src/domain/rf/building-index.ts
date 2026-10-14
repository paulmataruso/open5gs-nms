// Building footprint index: spatial lookup, ray/segment intersection, and
// height-aware LOS/NLOS classification.
//
// This is what turns a propagation model into a plan. Without footprints every
// prediction is free-space plus terrain, so a street-level small cell looks
// identical whether it faces an open park or a row of six-storey blocks.
//
// Deliberate design choices:
//
//   * A uniform grid index, not an R-tree. Footprint counts here are in the
//     hundreds to low thousands over a few square kilometres, where a grid's
//     constant factors beat a tree's and the implementation has no balancing
//     to get wrong. Cell size is tuned to the typical footprint span.
//
//   * Local equirectangular metres rather than a projection library. Over a
//     planning area of a few km the error is well under the uncertainty in the
//     building heights themselves, and it keeps this dependency-free.
//
//   * Height evidence is explicit and three-valued. A footprint with no height
//     tag is NOT assumed short (which would silently invent LOS) nor assumed
//     tall (which would invent blockage). It is 'unknown' and handled
//     conservatively, and the classification reports which it was.

export interface BuildingFootprint {
  id: string;
  /** Closed ring, [lon, lat] pairs. First and last may or may not repeat. */
  ring: [number, number][];
  /** Metres above ground, when known. */
  heightM?: number;
  /** How the height was established — drives the conservatism policy. */
  heightSource?: 'tag' | 'levels' | 'unknown';
  demandWeight?: number;
  residentialDemand?: number;
  densityScore?: number;
  tags?: Record<string, string>;
}

const METRES_PER_DEG_LAT = 111132.92;

export function metresPerDegLon(latitudeDeg: number): number {
  return 111320 * Math.cos((latitudeDeg * Math.PI) / 180);
}

/** Assumed storey height when deriving a height from building:levels. */
export const METRES_PER_BUILDING_LEVEL = 3.0;

/**
 * Height assumed for a footprint with no height evidence at all. Chosen as a
 * low-rise default: it still blocks a street-level receiver (so clutter is not
 * ignored) without fabricating a tower that shadows a whole sector.
 */
export const UNKNOWN_BUILDING_HEIGHT_M = 6.0;

export interface Point {
  lon: number;
  lat: number;
}

export interface WallIntersection {
  building: BuildingFootprint;
  point: Point;
  /** Distance from the segment start, metres. */
  distanceM: number;
}

export type LosState = 'los' | 'nlos' | 'unknown';

export interface LosClassification {
  state: LosState;
  /** Footprints whose roofline actually obstructs the straight ray. */
  obstructions: BuildingFootprint[];
  /** Number of footprint walls the ray crossed, regardless of height. */
  wallEventCount: number;
  heightEvidence: 'measured' | 'derived' | 'assumed' | 'none';
  detail: string;
}

/** Resolve a usable height plus how confident we are in it. */
export function resolveBuildingHeightM(building: BuildingFootprint): { heightM: number; evidence: 'measured' | 'derived' | 'assumed' } {
  if (Number.isFinite(building.heightM) && (building.heightM as number) > 0) {
    return { heightM: building.heightM as number, evidence: building.heightSource === 'levels' ? 'derived' : 'measured' };
  }
  const levels = Number(building.tags?.['building:levels']);
  if (Number.isFinite(levels) && levels > 0) {
    return { heightM: levels * METRES_PER_BUILDING_LEVEL, evidence: 'derived' };
  }
  const tagged = parseLengthMetres(building.tags?.height);
  if (tagged !== null) return { heightM: tagged, evidence: 'measured' };
  return { heightM: UNKNOWN_BUILDING_HEIGHT_M, evidence: 'assumed' };
}

/** Parse an OSM length: "12", "12 m", "12.5", "40'" (feet). */
export function parseLengthMetres(value?: string): number | null {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  const feet = /^([\d.]+)\s*(?:'|ft|feet)$/.exec(text);
  if (feet) {
    const n = Number(feet[1]);
    return Number.isFinite(n) && n > 0 ? n * 0.3048 : null;
  }
  const metres = /^([\d.]+)\s*m?$/.exec(text);
  if (metres) {
    const n = Number(metres[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

interface IndexedBuilding {
  building: BuildingFootprint;
  minLon: number; minLat: number; maxLon: number; maxLat: number;
}

/** Grid cell span in degrees, ~200 m — comfortably larger than a footprint. */
const GRID_CELL_DEG = 0.002;

export class BuildingIndex {
  private readonly cells = new Map<string, IndexedBuilding[]>();
  private readonly all: IndexedBuilding[] = [];

  constructor(buildings: BuildingFootprint[] = []) {
    for (const building of buildings) this.add(building);
  }

  get size(): number {
    return this.all.length;
  }

  buildings(): BuildingFootprint[] {
    return this.all.map(entry => entry.building);
  }

  add(building: BuildingFootprint): void {
    if (!building.ring || building.ring.length < 3) return;
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const [lon, lat] of building.ring) {
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    }
    const entry: IndexedBuilding = { building, minLon, minLat, maxLon, maxLat };
    this.all.push(entry);
    for (const key of this.cellKeys(minLon, minLat, maxLon, maxLat)) {
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(entry); else this.cells.set(key, [entry]);
    }
  }

  private cellKeys(minLon: number, minLat: number, maxLon: number, maxLat: number): string[] {
    const keys: string[] = [];
    const x0 = Math.floor(minLon / GRID_CELL_DEG), x1 = Math.floor(maxLon / GRID_CELL_DEG);
    const y0 = Math.floor(minLat / GRID_CELL_DEG), y1 = Math.floor(maxLat / GRID_CELL_DEG);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.push(`${x}:${y}`);
    return keys;
  }

  /** Candidate footprints whose bbox overlaps the segment's bbox. */
  private candidatesForSegment(a: Point, b: Point): IndexedBuilding[] {
    const minLon = Math.min(a.lon, b.lon), maxLon = Math.max(a.lon, b.lon);
    const minLat = Math.min(a.lat, b.lat), maxLat = Math.max(a.lat, b.lat);
    const seen = new Set<IndexedBuilding>();
    for (const key of this.cellKeys(minLon, minLat, maxLon, maxLat)) {
      const bucket = this.cells.get(key);
      if (!bucket) continue;
      for (const entry of bucket) {
        if (entry.maxLon < minLon || entry.minLon > maxLon || entry.maxLat < minLat || entry.minLat > maxLat) continue;
        seen.add(entry);
      }
    }
    return [...seen];
  }

  /**
   * Every wall crossing between a and b, ordered by distance from a.
   * A ray passing through a building yields two crossings (in and out), which
   * is what makes the per-wall penetration-loss accounting correct.
   */
  segmentIntersections(a: Point, b: Point): WallIntersection[] {
    const out: WallIntersection[] = [];
    const mPerLon = metresPerDegLon((a.lat + b.lat) / 2);
    for (const entry of this.candidatesForSegment(a, b)) {
      const ring = entry.building.ring;
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % n];
        const hit = segmentIntersection(a.lon, a.lat, b.lon, b.lat, x1, y1, x2, y2);
        if (!hit) continue;
        const dx = (hit.lon - a.lon) * mPerLon;
        const dy = (hit.lat - a.lat) * METRES_PER_DEG_LAT;
        out.push({ building: entry.building, point: hit, distanceM: Math.hypot(dx, dy) });
      }
    }
    out.sort((p, q) => p.distanceM - q.distanceM);
    return out;
  }

  /** Is the point inside any footprint? Used for indoor-endpoint detection. */
  containingBuilding(point: Point): BuildingFootprint | null {
    const key = `${Math.floor(point.lon / GRID_CELL_DEG)}:${Math.floor(point.lat / GRID_CELL_DEG)}`;
    for (const entry of this.cells.get(key) ?? []) {
      if (pointInRing(point.lon, point.lat, entry.building.ring)) return entry.building;
    }
    return null;
  }

  /**
   * Height-aware LOS/NLOS for the straight path from tx to rx.
   *
   * A footprint only obstructs if its roofline rises above the straight line
   * at the point where the ray crosses it — a two-storey shed under a
   * rooftop-mounted sector does not block anything, and treating every wall
   * crossing as blockage is the single most common way these maps come out
   * far too pessimistic.
   */
  classifyPath(
    tx: Point, txHeightM: number,
    rx: Point, rxHeightM: number,
  ): LosClassification {
    const intersections = this.segmentIntersections(tx, rx);
    if (intersections.length === 0) {
      return {
        state: 'los', obstructions: [], wallEventCount: 0, heightEvidence: 'none',
        detail: 'no building footprint crosses the direct path',
      };
    }
    const mPerLon = metresPerDegLon((tx.lat + rx.lat) / 2);
    const totalM = Math.hypot((rx.lon - tx.lon) * mPerLon, (rx.lat - tx.lat) * METRES_PER_DEG_LAT);
    const obstructions: BuildingFootprint[] = [];
    let weakestEvidence: 'measured' | 'derived' | 'assumed' = 'measured';
    const rank = { measured: 0, derived: 1, assumed: 2 } as const;
    const seen = new Set<string>();

    for (const hit of intersections) {
      const { heightM, evidence } = resolveBuildingHeightM(hit.building);
      if (rank[evidence] > rank[weakestEvidence]) weakestEvidence = evidence;
      // Straight-line height at this along-path distance.
      const fraction = totalM > 0 ? hit.distanceM / totalM : 0;
      const rayHeightM = txHeightM + (rxHeightM - txHeightM) * fraction;
      if (heightM > rayHeightM && !seen.has(hit.building.id)) {
        seen.add(hit.building.id);
        obstructions.push(hit.building);
      }
    }

    if (obstructions.length === 0) {
      return {
        state: 'los', obstructions: [], wallEventCount: intersections.length,
        heightEvidence: weakestEvidence,
        detail: `${intersections.length} wall crossing(s), none rising above the direct ray`,
      };
    }
    // An obstruction established only from an assumed height is reported as
    // 'unknown' rather than a confident NLOS: the geometry says blocked, but
    // the evidence behind it is our default, not data.
    const state: LosState = weakestEvidence === 'assumed' ? 'unknown' : 'nlos';
    return {
      state,
      obstructions,
      wallEventCount: intersections.length,
      heightEvidence: weakestEvidence,
      detail:
        `${obstructions.length} footprint(s) rise above the direct ray` +
        (state === 'unknown'
          ? `; height evidence is an assumed ${UNKNOWN_BUILDING_HEIGHT_M} m default, so this is reported as unknown rather than confirmed NLOS`
          : ''),
    };
  }
}

/** Proper segment-segment intersection. Returns the crossing point or null. */
export function segmentIntersection(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): Point | null {
  const r_px = bx - ax, r_py = by - ay;
  const s_px = dx - cx, s_py = dy - cy;
  const denominator = r_px * s_py - r_py * s_px;
  if (denominator === 0) return null; // parallel or collinear
  const t = ((cx - ax) * s_py - (cy - ay) * s_px) / denominator;
  const u = ((cx - ax) * r_py - (cy - ay) * r_px) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { lon: ax + t * r_px, lat: ay + t * r_py };
}

/** Ray-casting point-in-polygon. */
export function pointInRing(lon: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Destination point from an origin, bearing (deg from north) and range. */
export function destinationPoint(origin: Point, bearingDeg: number, distanceM: number): Point {
  const rad = (bearingDeg * Math.PI) / 180;
  const north = Math.cos(rad) * distanceM;
  const east = Math.sin(rad) * distanceM;
  return {
    lat: origin.lat + north / METRES_PER_DEG_LAT,
    lon: origin.lon + east / metresPerDegLon(origin.lat),
  };
}

/** Ground distance between two points, metres. */
export function groundDistanceM(a: Point, b: Point): number {
  const mPerLon = metresPerDegLon((a.lat + b.lat) / 2);
  return Math.hypot((b.lon - a.lon) * mPerLon, (b.lat - a.lat) * METRES_PER_DEG_LAT);
}
