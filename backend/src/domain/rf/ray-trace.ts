import {
  BuildingIndex, BuildingFootprint, Point,
  destinationPoint, groundDistanceM,
} from './building-index';
import { type UmaLosState } from './uma-model';
import {
  simulationPathLossDb, DEFAULT_SIMULATION_MODEL,
  type SimulationModel, type SimulationModelParams,
} from './propagation-select';
import { horizontalPatternLossDb, verticalPatternLossDb, combinedPatternLossDb, DEFAULT_FRONT_TO_BACK_DB, DEFAULT_VERTICAL_BEAMWIDTH_DEG } from './antenna-pattern';

// Segmented beam ray tracing.
//
// Casts N rays across the sector beam and marches each one outward in fixed
// steps, recomputing received power at every step and charging penetration
// loss at each building wall it crosses. The output is a set of coloured line
// segments — not a smooth heatmap — and that is the point: you can see exactly
// where a ray died, which building killed it, and how much each wall cost.
//
// Why segments rather than a raster: a raster tells you the answer, a ray tells
// you the reason. For planning work "why is this street dark" matters more than
// a prettier gradient, and the segment carries its own evidence (wall loss,
// LOS state, obstructing building id) for inspection.
//
// Performance shape: with a 25 m step and a 400 m radius that is 16 steps per
// ray, so 120 rays is ~1,900 steps. Each step does a bbox-filtered wall
// intersection test against a grid index. This stays well inside a request
// budget on one thread, which is why it needs no worker pool here. The feature
// cap exists to protect the RESPONSE size, not the CPU.

/** March step along each ray, metres. Matches the segment granularity we emit. */
export const SEGMENT_STEP_M = 25;

/** Hard cap on emitted segments, to bound the response payload. */
export const MAX_RAY_FEATURES = 25000;

/** Frequency-dependent per-wall penetration loss, dB. */
export function penetrationLossDb(frequencyGhz: number): number {
  if (frequencyGhz < 6) return 8;    // sub-6: ordinary exterior wall
  if (frequencyGhz < 30) return 30;  // cm-wave
  return 80;                          // mm-wave and above
}

/**
 * Model-specific inputs. The geometric arguments (distance, frequency,
 * heights, LOS state) come from the profile and the march itself, so this
 * carries only the knobs the operator chooses.
 */
export type RayTraceModelOptions =
  Omit<SimulationModelParams, 'distanceM' | 'frequencyGhz' | 'txHeightM' | 'rxHeightM' | 'lineOfSight'>;

export interface RayTraceProfile {
  /** Propagation model. Defaults to UMa, the right choice for CBRS mid-band. */
  model?: SimulationModel;
  modelOptions?: RayTraceModelOptions;
  frequencyGhz: number;
  /** Conducted transmit power at the antenna port, dBm. */
  txPowerDbm: number;
  txAntennaGainDbi: number;
  rxAntennaGainDbi: number;
  systemLossDb: number;
  polarizationLossDb: number;
  antennaHeightM: number;
  receiverHeightM: number;
  /** Horizontal 3 dB beamwidth, degrees. */
  beamWidthDeg: number;
  verticalBeamwidthDeg?: number;
  frontToBackDb?: number;
  mechanicalDowntiltDeg?: number;
  /** Receiver usability threshold, dBm. */
  receiverSensitivityDbm: number;
  calibrationOffsetDb?: number;
}

export interface RayTraceOptions {
  origin: Point;
  /** Sector centre bearing, degrees from north. */
  azimuthDeg: number;
  rays: number;
  radiusM: number;
  profile: RayTraceProfile;
  buildings?: BuildingIndex;
  /** Emit per-segment features. False computes stats only, much cheaper. */
  collectSegments?: boolean;
}

export interface RaySegment {
  rayIndex: number;
  segmentIndex: number;
  angleDeg: number;
  start: Point;
  end: Point;
  startDistanceM: number;
  endDistanceM: number;
  startSignalDbm: number;
  endSignalDbm: number;
  pathLossDb: number;
  wallLossDb: number;
  losState: UmaLosState | 'unknown';
  /** Building whose wall terminates this segment, when it was a wall crossing. */
  obstructingBuildingId?: string;
  /** True when the receiver threshold is crossed at this segment's end. */
  isTerminal: boolean;
}

export interface RayTerminal {
  rayIndex: number;
  angleDeg: number;
  /** Where the ray stopped being usable, metres from origin. */
  reachM: number;
  endSignalDbm: number;
  blocked: boolean;
  wallsCrossed: number;
}

export interface RayTraceResult {
  segments: RaySegment[];
  terminals: RayTerminal[];
  /** Best received power seen on each building, keyed by footprint id. */
  buildingCoverage: Map<string, number>;
  stats: {
    rays: number;
    segmentCount: number;
    truncated: boolean;
    blockedRayPct: number;
    avgReachM: number;
    minReachM: number;
    maxReachM: number;
    avgEndSignalDbm: number;
    wallEventTotal: number;
    /** Model actually used, echoed so a result can never be read as another model's. */
    model: SimulationModel;
    /** Samples the model declined (outside its published validity). */
    declinedSamples: number;
    /** Rays on which EVERY sample was declined, so they have no reach at all. */
    declinedRays: number;
    /** Rays that produced at least one real sample — the denominator for the averages below. */
    raysEvaluated: number;
  };
}

/**
 * Ray bearings across the beam, using MIDPOINT sampling:
 *
 *   angle_i = azimuth − beamwidth/2 + (i + 0.5)·(beamwidth/rays)
 *
 * This deliberately differs from the edge-anchored convention
 * (`start + i·step`) used by the implementation we studied. That form has two
 * real defects: with rays = 1 the single ray sits on the beam EDGE rather than
 * boresight, and for any N the samples are asymmetric about the azimuth
 * because the last ray stops one step short of the far edge. Both are
 * surprising in exactly the situation an operator reaches for first — "just
 * shoot one ray down the middle and tell me the range".
 *
 * Midpoint sampling gives boresight for rays = 1, stays symmetric about the
 * azimuth for every N, and distributes the rays evenly across the beam with
 * each one representing an equal angular slice.
 */
export function beamAngleForIndex(azimuthDeg: number, beamWidthDeg: number, rayCount: number, index: number): number {
  if (rayCount <= 0) return normalizeDeg(azimuthDeg);
  const step = beamWidthDeg / rayCount;
  return normalizeDeg(azimuthDeg - beamWidthDeg / 2 + (index + 0.5) * step);
}

export function normalizeDeg(value: number): number {
  const wrapped = value % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Signed smallest angle between two bearings, −180..180. */
export function signedAngleDelta(from: number, to: number): number {
  let delta = (to - from) % 360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

/**
 * Lean received-power computation for the inner loop. Deliberately separate
 * from calculateLinkBudget(), which builds EquationRecords for explainability
 * and is far too heavy to call thousands of times per request.
 *
 * Exported because the coverage heatmap has to agree with the rays EXACTLY —
 * both layers are drawn on the same map at the same time, so any divergence
 * in antenna pattern, wall loss or model dispatch shows up as a raster that
 * contradicts the rays crossing it. One function, one answer.
 */
export function receivedPowerAtPoint(
  profile: RayTraceProfile,
  groundDistance: number,
  losState: UmaLosState,
  cumulativeWallLossDb: number,
  horizontalOffsetDeg: number,
): { rxDbm: number; pathLossDb: number } | null {
  // null propagates the model's own refusal (e.g. Hata below 1 km) all the way
  // out as a GAP. Substituting another model here would silently relabel one
  // model's output as another's, which is the single most misleading thing a
  // planning tool can do.
  const pathLoss = simulationPathLossDb(profile.model ?? DEFAULT_SIMULATION_MODEL, {
    ...(profile.modelOptions ?? {}),
    distanceM: groundDistance,
    frequencyGhz: profile.frequencyGhz,
    txHeightM: profile.antennaHeightM,
    rxHeightM: profile.receiverHeightM,
    lineOfSight: losState === 'los',
  });
  if (pathLoss === null) return null;
  const horizontalLoss = horizontalPatternLossDb(
    horizontalOffsetDeg, profile.beamWidthDeg, profile.frontToBackDb ?? DEFAULT_FRONT_TO_BACK_DB,
  );
  // Elevation offset: the depression angle to the receiver versus any downtilt.
  const heightDelta = profile.antennaHeightM - profile.receiverHeightM;
  const depressionDeg = groundDistance > 0 ? (Math.atan2(heightDelta, groundDistance) * 180) / Math.PI : 0;
  const elevationOffset = depressionDeg - (profile.mechanicalDowntiltDeg ?? 0);
  const verticalLoss = verticalPatternLossDb(
    elevationOffset, profile.verticalBeamwidthDeg ?? DEFAULT_VERTICAL_BEAMWIDTH_DEG, profile.frontToBackDb ?? DEFAULT_FRONT_TO_BACK_DB,
  );
  const patternLoss = combinedPatternLossDb(horizontalLoss, verticalLoss, profile.frontToBackDb ?? DEFAULT_FRONT_TO_BACK_DB);

  const rxDbm =
    profile.txPowerDbm +
    profile.txAntennaGainDbi +
    profile.rxAntennaGainDbi +
    (profile.calibrationOffsetDb ?? 0) -
    pathLoss -
    patternLoss -
    cumulativeWallLossDb -
    profile.systemLossDb -
    profile.polarizationLossDb;

  return { rxDbm, pathLossDb: pathLoss + patternLoss + cumulativeWallLossDb };
}

export function traceBeam(options: RayTraceOptions): RayTraceResult {
  const { origin, azimuthDeg, profile, buildings } = options;
  const rays = Math.max(1, Math.floor(options.rays));
  const radiusM = Math.max(0, options.radiusM);
  const collect = options.collectSegments !== false;
  const wallLossPerCrossing = penetrationLossDb(profile.frequencyGhz);

  const segments: RaySegment[] = [];
  const terminals: RayTerminal[] = [];
  const buildingCoverage = new Map<string, number>();
  let truncated = false;
  let wallEventTotal = 0;
  let declinedSamples = 0;
  let declinedRays = 0;

  const recordBuilding = (building: BuildingFootprint, rxDbm: number) => {
    const best = buildingCoverage.get(building.id);
    if (best === undefined || rxDbm > best) buildingCoverage.set(building.id, rxDbm);
  };

  for (let rayIndex = 0; rayIndex < rays; rayIndex++) {
    const angleDeg = beamAngleForIndex(azimuthDeg, profile.beamWidthDeg, rays, rayIndex);
    const horizontalOffsetDeg = signedAngleDelta(azimuthDeg, angleDeg);

    let cumulativeWallLossDb = 0;
    let wallsCrossed = 0;
    let segmentIndex = 0;
    let terminated = false;
    let cursorDistance = 0;
    let cursorPoint = origin;
    let lastRxDbm = profile.txPowerDbm;
    let lastLos: UmaTraceState = 'los';
    let computedSamples = 0;
    // Attempted vs computed is the distinction that keeps "the model refused
    // this distance" separate from "there was nothing here to evaluate" (a
    // zero radius marches no steps at all). Only the former is a decline.
    let attemptedSamples = 0;

    while (cursorDistance < radiusM && !terminated) {
      const stepEnd = Math.min(cursorDistance + SEGMENT_STEP_M, radiusM);
      const stepEndPoint = destinationPoint(origin, angleDeg, stepEnd);

      // Wall crossings within this step, in order.
      const crossings = buildings ? buildings.segmentIntersections(cursorPoint, stepEndPoint) : [];

      // Walk each crossing, then finish the step.
      let subStart = cursorPoint;
      let subStartDistance = cursorDistance;
      let subStartRx = lastRxDbm;

      for (const crossing of crossings) {
        const hitDistance = subStartDistance + crossing.distanceM;
        cumulativeWallLossDb += wallLossPerCrossing;
        wallsCrossed++;
        wallEventTotal++;
        // Any wall crossing means the path is no longer line-of-sight.
        lastLos = 'nlos';
        attemptedSamples++;
        const power = receivedPowerAtPoint(profile, hitDistance, 'nlos', cumulativeWallLossDb, horizontalOffsetDeg);
        if (power === null) {
          // The model has nothing to say at this distance. The wall crossing
          // still physically happened and is already charged above, so keep
          // marching — just emit no segment and record no building coverage,
          // so the gap stays visible instead of being filled in.
          declinedSamples++;
          subStart = crossing.point;
          subStartDistance = hitDistance;
          continue;
        }
        const { rxDbm, pathLossDb } = power;
        recordBuilding(crossing.building, rxDbm);
        computedSamples++;
        const isTerminal = rxDbm <= profile.receiverSensitivityDbm;

        if (collect && groundDistanceM(subStart, crossing.point) > 0.01) {
          if (segments.length >= MAX_RAY_FEATURES) { truncated = true; break; }
          segments.push({
            rayIndex, segmentIndex: segmentIndex++, angleDeg,
            start: subStart, end: crossing.point,
            startDistanceM: subStartDistance, endDistanceM: hitDistance,
            startSignalDbm: subStartRx, endSignalDbm: rxDbm,
            pathLossDb, wallLossDb: cumulativeWallLossDb,
            losState: 'nlos',
            obstructingBuildingId: crossing.building.id,
            isTerminal,
          });
        }
        subStart = crossing.point;
        subStartDistance = hitDistance;
        subStartRx = rxDbm;
        lastRxDbm = rxDbm;
        if (isTerminal) {
          terminated = true;
          terminals.push({ rayIndex, angleDeg, reachM: hitDistance, endSignalDbm: rxDbm, blocked: true, wallsCrossed });
          break;
        }
      }
      if (terminated || truncated) break;

      // Remainder of the step past the last crossing.
      attemptedSamples++;
      const stepPower = receivedPowerAtPoint(profile, stepEnd, lastLos, cumulativeWallLossDb, horizontalOffsetDeg);
      if (stepPower === null) {
        declinedSamples++;
        cursorPoint = stepEndPoint;
        cursorDistance = stepEnd;
        continue;
      }
      const { rxDbm, pathLossDb } = stepPower;
      computedSamples++;
      const isTerminal = rxDbm <= profile.receiverSensitivityDbm;
      if (collect && groundDistanceM(subStart, stepEndPoint) > 0.01) {
        if (segments.length >= MAX_RAY_FEATURES) { truncated = true; break; }
        segments.push({
          rayIndex, segmentIndex: segmentIndex++, angleDeg,
          start: subStart, end: stepEndPoint,
          startDistanceM: subStartDistance, endDistanceM: stepEnd,
          startSignalDbm: subStartRx, endSignalDbm: rxDbm,
          pathLossDb, wallLossDb: cumulativeWallLossDb,
          losState: lastLos,
          isTerminal,
        });
      }
      cursorPoint = stepEndPoint;
      cursorDistance = stepEnd;
      lastRxDbm = rxDbm;

      if (isTerminal) {
        terminated = true;
        terminals.push({ rayIndex, angleDeg, reachM: stepEnd, endSignalDbm: rxDbm, blocked: cumulativeWallLossDb > 0, wallsCrossed });
      }
    }

    if (!terminated && (computedSamples > 0 || attemptedSamples === 0)) {
      // Ray ran the full radius without dropping below sensitivity — or had
      // no distance to cover at all, which is still a real reach of zero.
      terminals.push({ rayIndex, angleDeg, reachM: cursorDistance, endSignalDbm: lastRxDbm, blocked: false, wallsCrossed });
    } else if (attemptedSamples > 0 && computedSamples === 0) {
      // Every sample on this ray was declined by the model, so there is no
      // reach to report. Emitting a terminal here would put a fabricated
      // number into the per-cell averages; counting it separately keeps the
      // statistics honest and lets the caller say how much was unevaluated.
      declinedRays++;
    }
    if (truncated) break;
  }

  const reaches = terminals.map(t => t.reachM);
  const blocked = terminals.filter(t => t.blocked).length;
  return {
    segments, terminals, buildingCoverage,
    stats: {
      rays,
      segmentCount: segments.length,
      truncated,
      blockedRayPct: terminals.length ? Number(((blocked / terminals.length) * 100).toFixed(1)) : 0,
      avgReachM: reaches.length ? Number((reaches.reduce((a, b) => a + b, 0) / reaches.length).toFixed(1)) : 0,
      minReachM: reaches.length ? Number(Math.min(...reaches).toFixed(1)) : 0,
      maxReachM: reaches.length ? Number(Math.max(...reaches).toFixed(1)) : 0,
      avgEndSignalDbm: terminals.length
        ? Number((terminals.reduce((a, t) => a + t.endSignalDbm, 0) / terminals.length).toFixed(1))
        : 0,
      wallEventTotal,
      model: options.profile.model ?? DEFAULT_SIMULATION_MODEL,
      declinedSamples,
      declinedRays,
      raysEvaluated: terminals.length,
    },
  };
}

type UmaTraceState = UmaLosState;

/**
 * Signal colour ramp for received power, matching the convention operators
 * read quickly: green good, amber marginal, red poor, violet unusable.
 */
export function signalColorRgb(rxDbm: number): [number, number, number] {
  if (rxDbm >= -80) return [5, 150, 105];
  if (rxDbm >= -90) return [34, 197, 94];
  if (rxDbm >= -100) return [245, 158, 11];
  if (rxDbm >= -110) return [225, 29, 72];
  return [126, 34, 206];
}

/** Ray segments as a GeoJSON FeatureCollection, ready for Leaflet. */
export function raySegmentsToGeoJson(result: RayTraceResult): Record<string, unknown> {
  return {
    type: 'FeatureCollection',
    features: result.segments.map(segment => {
      const [r, g, b] = signalColorRgb(segment.endSignalDbm);
      return {
        type: 'Feature',
        properties: {
          ray_index: segment.rayIndex,
          segment_index: segment.segmentIndex,
          angle_deg: Number(segment.angleDeg.toFixed(2)),
          signal_dbm: Number(segment.endSignalDbm.toFixed(1)),
          signal_start_dbm: Number(segment.startSignalDbm.toFixed(1)),
          path_loss_db: Number(segment.pathLossDb.toFixed(1)),
          wall_loss_db: Number(segment.wallLossDb.toFixed(1)),
          distance_m: Number(segment.endDistanceM.toFixed(1)),
          los_state: segment.losState,
          obstructing_building_id: segment.obstructingBuildingId ?? null,
          is_terminal: segment.isTerminal,
          color: `rgb(${r} ${g} ${b})`,
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [segment.start.lon, segment.start.lat],
            [segment.end.lon, segment.end.lat],
          ],
        },
      };
    }),
  };
}
