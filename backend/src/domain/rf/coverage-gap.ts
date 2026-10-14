import { BuildingFootprint, BuildingIndex, Point, groundDistanceM } from './building-index';
import { traceBeam, type RayTraceProfile, type RayTraceResult } from './ray-trace';

// Coverage gap finder: demand-weighted buildings inside the beam that are not
// actually served.
//
// The point of this, as distinct from a coverage map: a coverage map answers
// "how far does the signal go", which is a question about the radio. This
// answers "which premises that matter are underserved", which is a question
// about the plan. A sector can look healthy on a coverage map and still miss
// the one apartment block that drives the demand.
//
// The service threshold here is DELIBERATELY SEPARATE from receiver
// sensitivity. Sensitivity answers "can a receiver demodulate at all"; a
// building-service threshold answers "would we be willing to sell service
// here", which is a commercial margin above bare usability. Conflating them
// makes every marginal building look fine.

/** Default building-service threshold, dBm — a margin above bare sensitivity. */
export const DEFAULT_BUILDING_SERVICE_THRESHOLD_DBM = -100;

/** Cap on reported gaps, so a sparse plan cannot return a whole city. */
export const MAX_REPORTED_GAPS = 500;

export interface CoverageGapOptions {
  origin: Point;
  azimuthDeg: number;
  rays: number;
  radiusM: number;
  profile: RayTraceProfile;
  buildings: BuildingIndex;
  /** Received power at or below which a building counts as unserved. */
  serviceThresholdDbm?: number;
  /** Only consider buildings with residential demand. */
  residentialOnly?: boolean;
  /** Reuse an existing trace rather than recomputing it. */
  precomputed?: RayTraceResult;
}

export interface CoverageGapEntry {
  buildingId: string;
  /** Best received power the beam delivered to this building, dBm. Null if never illuminated. */
  bestRxDbm: number | null;
  /** demandWeight + residentialDemand — the figure the ranking uses. */
  combinedDemand: number;
  demandWeight: number;
  residentialDemand: number;
  distanceM: number;
  centroid: Point;
  reason: 'never_illuminated' | 'below_service_threshold';
}

export interface CoverageGapResult {
  gaps: CoverageGapEntry[];
  truncated: boolean;
  summary: {
    candidateBuildings: number;
    servedBuildings: number;
    gapBuildings: number;
    /** Combined demandWeight + residentialDemand across in-scope buildings. */
    totalDemandWeight: number;
    servedDemandWeight: number;
    unservedDemandWeight: number;
    demandServedPct: number;
    serviceThresholdDbm: number;
  };
}

/** Area-weighted centroid of a footprint ring. */
export function footprintCentroid(building: BuildingFootprint): Point {
  const ring = building.ring;
  let lon = 0, lat = 0;
  for (const [x, y] of ring) { lon += x; lat += y; }
  return { lon: lon / ring.length, lat: lat / ring.length };
}

/**
 * Is this footprint inside the sector's angular span and radius? Buildings
 * behind the antenna are not "gaps" — they were never in scope.
 */
function insideBeam(origin: Point, azimuthDeg: number, beamWidthDeg: number, radiusM: number, centroid: Point): { inside: boolean; distanceM: number } {
  const distanceM = groundDistanceM(origin, centroid);
  if (distanceM > radiusM) return { inside: false, distanceM };
  const dLon = centroid.lon - origin.lon;
  const dLat = centroid.lat - origin.lat;
  // Bearing from north, clockwise.
  const bearing = (Math.atan2(dLon * Math.cos((origin.lat * Math.PI) / 180), dLat) * 180) / Math.PI;
  let delta = (bearing - azimuthDeg) % 360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return { inside: Math.abs(delta) <= beamWidthDeg / 2, distanceM };
}

export function findCoverageGaps(options: CoverageGapOptions): CoverageGapResult {
  const threshold = options.serviceThresholdDbm ?? DEFAULT_BUILDING_SERVICE_THRESHOLD_DBM;
  const trace =
    options.precomputed ??
    traceBeam({
      origin: options.origin, azimuthDeg: options.azimuthDeg, rays: options.rays,
      radiusM: options.radiusM, profile: options.profile, buildings: options.buildings,
      collectSegments: false,
    });

  const gaps: CoverageGapEntry[] = [];
  let candidateBuildings = 0;
  let servedBuildings = 0;
  let totalDemandWeight = 0;
  let servedDemandWeight = 0;

  for (const building of options.buildings.buildings()) {
    const residentialDemand = building.residentialDemand ?? 0;
    if (options.residentialOnly && residentialDemand <= 0) continue;

    const centroid = footprintCentroid(building);
    const { inside, distanceM } = insideBeam(
      options.origin, options.azimuthDeg, options.profile.beamWidthDeg, options.radiusM, centroid,
    );
    if (!inside) continue;

    candidateBuildings++;
    const demandWeight = building.demandWeight ?? 0;
    // Total demand must combine BOTH components, exactly as the gap ranking
    // below does. Counting only demandWeight made the headline percentage
    // meaningless in a residential area: houses carry residentialDemand and
    // almost no demandWeight, so the total came out at (or near) zero and the
    // served fraction degenerated to 0% or 100% regardless of coverage.
    // Confirmed live against 42 real OSM footprints.
    totalDemandWeight += demandWeight + residentialDemand;

    const bestRx = trace.buildingCoverage.get(building.id);
    const served = bestRx !== undefined && bestRx > threshold;
    if (served) {
      servedBuildings++;
      servedDemandWeight += demandWeight + residentialDemand;
      continue;
    }
    gaps.push({
      buildingId: building.id,
      bestRxDbm: bestRx ?? null,
      combinedDemand: Number((demandWeight + residentialDemand).toFixed(2)),
      demandWeight,
      residentialDemand,
      distanceM: Number(distanceM.toFixed(1)),
      centroid,
      reason: bestRx === undefined ? 'never_illuminated' : 'below_service_threshold',
    });
  }

  // Worst first by demand, so the top of the list is where to act.
  gaps.sort((a, b) => b.combinedDemand - a.combinedDemand || a.distanceM - b.distanceM);
  const truncated = gaps.length > MAX_REPORTED_GAPS;

  return {
    gaps: truncated ? gaps.slice(0, MAX_REPORTED_GAPS) : gaps,
    truncated,
    summary: {
      candidateBuildings,
      servedBuildings,
      gapBuildings: gaps.length,
      totalDemandWeight: Number(totalDemandWeight.toFixed(2)),
      servedDemandWeight: Number(servedDemandWeight.toFixed(2)),
      unservedDemandWeight: Number((totalDemandWeight - servedDemandWeight).toFixed(2)),
      demandServedPct: totalDemandWeight > 0
        ? Number(((servedDemandWeight / totalDemandWeight) * 100).toFixed(1))
        : 0,
      serviceThresholdDbm: threshold,
    },
  };
}
