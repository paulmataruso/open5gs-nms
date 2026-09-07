// Single-cell directional signal computation for one site at one point —
// the shared core used by both coverage-grid.ts (a grid of cells around
// ONE site) and interference.ts (multiple sites evaluated at the SAME
// shared grid of points, for SINR). Defined exactly once here so the two
// callers can never drift out of sync with each other, matching this
// engine's existing rule against re-implementing a formula in more than
// one place (see pathloss-fspl.ts's km/miles wrappers, lte-bands.ts's
// inverse EARFCN formula, etc.).

import pino from 'pino';
import {
  PropagationModel, HataEnvironment, Cost231CityType, LogDistanceEnvironment, LosClassification,
  FresnelClearanceThresholdPercent, WalfischIkegamiMode, EquationRecord,
  ItmRadioClimate, ItmPolarization, ItmVariabilityMode,
} from './rf-types';
import { logDistancePathLossDb, LOG_DISTANCE_ENVIRONMENT_PRESETS } from './log-distance-model';
import { haversineDistanceM, initialBearingDeg } from './geometry';
import { elevationAngleDeg } from './elevation-downtilt';
import { fsplDb } from './pathloss-fspl';
import {
  hataPathLossDb, cost231HataPathLossDb, HATA_DISTANCE_RANGE_KM, COST231_DISTANCE_RANGE_KM,
} from './hata-model';
import { closeInPathLossDb, UMI_SC_LOS_PLE, UMI_SC_NLOS_PLE } from './close-in-model';
import {
  walfischIkegamiPathLossDb, WI_DISTANCE_RANGE_KM, WI_DEFAULT_BUILDING_SEPARATION_M,
  WI_DEFAULT_STREET_ORIENTATION_DEG, wiDefaultStreetWidthM,
} from './walfisch-ikegami-model';
import {
  itmPathLossDb, ITM_DEFAULT_GROUND_CONDUCTIVITY_S_PER_M, ITM_DEFAULT_GROUND_PERMITTIVITY,
  ITM_DEFAULT_SURFACE_REFRACTIVITY_N0, ITM_DEFAULT_RADIO_CLIMATE, ITM_DEFAULT_POLARIZATION,
  ITM_DEFAULT_VARIABILITY_MODE, ITM_DEFAULT_TIME_PERCENT, ITM_DEFAULT_LOCATION_PERCENT,
  ITM_DEFAULT_SITUATION_PERCENT,
} from './itm-model';
import {
  horizontalPatternLossDb, verticalPatternLossDb, combinedPatternLossDb, directionalAntennaGainDb,
} from './antenna-pattern';
import { getTerrainProfile } from './terrain-profile';
import { computeDiffractionLossDb, TerrainProfilePoint } from './diffraction';

function normalizeAngleDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

// Distance-range validation (per-model) returns null so callers can skip a
// point (e.g. too close for Hata's minimum) rather than fail outright.
// 'close-in' has no such restriction — isLineOfSight (from real terrain
// when available, else the caller's own override) selects the measured
// UMi Street Canyon exponent unless pathLossExponent is given directly.
export interface BasePathLossResult {
  pathLossDb: number;
  // Only populated for 'itm' — every other model is cheap to recompute from
  // a handful of retained scalars after the grid loop finishes (see
  // coverage-grid.ts/interference.ts's "representative worked example"
  // step), but ITM's equation depends on the full terrain profile, so it's
  // threaded back here instead of recomputed a second time (this file's own
  // header comment already rules out re-implementing a formula twice).
  equation?: EquationRecord;
  modelWarnings?: string[];
}

export async function computeBasePathLossDb(
  propagationModel: PropagationModel, distanceM: number, frequencyHz: number, frequencyMhz: number,
  txHeightM: number, rxHeightM: number, environment: HataEnvironment, cityType: Cost231CityType,
  pathLossExponent?: number, isLineOfSight?: boolean, logDistanceEnvironment?: LogDistanceEnvironment,
  walfischIkegamiMode?: WalfischIkegamiMode, buildingHeightM?: number, streetWidthM?: number,
  buildingSeparationM?: number, streetOrientationDeg?: number,
  itmTerrainProfile?: TerrainProfilePoint[], groundConductivity?: number, groundPermittivity?: number,
  surfaceRefractivityN0?: number, radioClimate?: ItmRadioClimate, polarization?: ItmPolarization,
  modeOfVariability?: ItmVariabilityMode, timePercent?: number, locationPercent?: number, situationPercent?: number,
): Promise<BasePathLossResult | null> {
  if (propagationModel === 'fspl') {
    return { pathLossDb: fsplDb(distanceM, frequencyHz) };
  }
  if (propagationModel === 'close-in') {
    const n = pathLossExponent ?? (isLineOfSight ? UMI_SC_LOS_PLE : UMI_SC_NLOS_PLE);
    return { pathLossDb: closeInPathLossDb(distanceM, frequencyHz, n) };
  }
  if (propagationModel === 'log-distance') {
    const n = pathLossExponent ?? LOG_DISTANCE_ENVIRONMENT_PRESETS[logDistanceEnvironment ?? 'urban'].pathLossExponent;
    return { pathLossDb: logDistancePathLossDb(distanceM, frequencyHz, n) };
  }
  if (propagationModel === 'itm') {
    // Unlike every other model here, ITM has no abstract-distance fallback
    // — its whole algorithm is profile-shaped (see itm-model.ts's header
    // comment). No profile (terrain data off, or unresolvable for this
    // point) means this point simply can't be computed with this model —
    // same "skip this point" contract as Hata's distance-range check below.
    if (!itmTerrainProfile || itmTerrainProfile.length < 2) return null;
    const r = await itmPathLossDb(
      itmTerrainProfile, txHeightM, rxHeightM, frequencyMhz,
      groundConductivity ?? ITM_DEFAULT_GROUND_CONDUCTIVITY_S_PER_M,
      groundPermittivity ?? ITM_DEFAULT_GROUND_PERMITTIVITY,
      surfaceRefractivityN0 ?? ITM_DEFAULT_SURFACE_REFRACTIVITY_N0,
      radioClimate ?? ITM_DEFAULT_RADIO_CLIMATE,
      polarization ?? ITM_DEFAULT_POLARIZATION,
      modeOfVariability ?? ITM_DEFAULT_VARIABILITY_MODE,
      timePercent ?? ITM_DEFAULT_TIME_PERCENT,
      locationPercent ?? ITM_DEFAULT_LOCATION_PERCENT,
      situationPercent ?? ITM_DEFAULT_SITUATION_PERCENT,
    );
    // A real ITM input-validation failure (e.g. a height/frequency/percent
    // out of its own documented range) is treated the same as Hata's
    // distance-range miss above — skip this point rather than fail the
    // whole grid, since frequency/height are already fail-fast-checked
    // upfront by the caller when they're constant across the grid.
    if (!r.ok) return null;
    return { pathLossDb: r.pathLossDb, equation: r.equation, modelWarnings: r.warnings };
  }
  const distanceKm = distanceM / 1000;
  if (propagationModel === 'hata') {
    if (distanceKm < HATA_DISTANCE_RANGE_KM[0] || distanceKm > HATA_DISTANCE_RANGE_KM[1]) return null;
    const r = hataPathLossDb(frequencyMhz, txHeightM, rxHeightM, distanceKm, environment);
    return r.ok ? { pathLossDb: r.pathLossDb } : null;
  }
  if (propagationModel === 'cost231-hata') {
    if (distanceKm < COST231_DISTANCE_RANGE_KM[0] || distanceKm > COST231_DISTANCE_RANGE_KM[1]) return null;
    const r = cost231HataPathLossDb(frequencyMhz, txHeightM, rxHeightM, distanceKm, cityType);
    return r.ok ? { pathLossDb: r.pathLossDb } : null;
  }
  // walfisch-ikegami — see walfisch-ikegami-model.ts for the full equation set.
  // Defaults mirrored here match linkbudget.ts's own resolution exactly, but
  // without Assumption-pushing (this function is a pure per-point primitive with
  // no assumptions array; callers push their own Assumption when they resolve
  // these same defaults at the request level, same pattern already used for
  // close-in's isLineOfSight and log-distance's environment above).
  if (distanceKm < WI_DISTANCE_RANGE_KM[0] || distanceKm > WI_DISTANCE_RANGE_KM[1]) return null;
  const wiMode = walfischIkegamiMode ?? 'nlos';
  if (wiMode === 'nlos' && buildingHeightM == null) return null;
  const wiB = buildingSeparationM ?? WI_DEFAULT_BUILDING_SEPARATION_M;
  const wiW = streetWidthM ?? wiDefaultStreetWidthM(wiB);
  const wiPhi = streetOrientationDeg ?? WI_DEFAULT_STREET_ORIENTATION_DEG;
  const wiResult = walfischIkegamiPathLossDb(frequencyMhz, txHeightM, rxHeightM, distanceKm, wiMode, buildingHeightM ?? 0, wiW, wiB, wiPhi, cityType);
  return wiResult.ok ? { pathLossDb: wiResult.pathLossDb } : null;
}

export interface ResolvedSiteParams {
  siteLat: number; siteLon: number; siteHeightM: number;
  azimuthDeg: number; horizontalBeamwidthDeg: number; verticalBeamwidthDeg: number;
  totalDowntiltDeg: number; frontToBackDb: number;
  txPowerDbm: number; cableLossDb: number; connectorLossDb: number; filterLossDb: number;
  antennaGainDbi: number; frequencyMhz: number; frequencyHz: number;
  buildingLossDb: number; foliageLossDb: number; miscLossDb: number; ueAntennaGainDbi: number;
  receiverHeightM: number;
  propagationModel: PropagationModel; environment: HataEnvironment; cityType: Cost231CityType;
  useTerrainData: boolean; terrainSampleCount: number;
  // 'close-in'/'log-distance' only.
  pathLossExponent?: number;
  isLineOfSight?: boolean;
  // 'log-distance' only.
  logDistanceEnvironment?: LogDistanceEnvironment;
  // Only meaningful when useTerrainData is set — both default inside
  // computeDiffractionLossDb when omitted (4/3 Earth, 60% clearance).
  earthCurvatureKFactor?: number;
  fresnelClearanceThresholdPercent?: FresnelClearanceThresholdPercent;
  // 'walfisch-ikegami' only.
  walfischIkegamiMode?: WalfischIkegamiMode;
  buildingHeightM?: number;
  streetWidthM?: number;
  buildingSeparationM?: number;
  streetOrientationDeg?: number;
  // 'itm' only — see the matching comment on CoverageGridInput in rf-types.ts.
  groundConductivity?: number;
  groundPermittivity?: number;
  surfaceRefractivityN0?: number;
  radioClimate?: ItmRadioClimate;
  polarization?: ItmPolarization;
  modeOfVariability?: ItmVariabilityMode;
  timePercent?: number;
  locationPercent?: number;
  situationPercent?: number;
}

export interface SiteSignalAtPoint {
  distanceM: number;
  azimuthOffsetDeg: number;
  elevationOffsetDeg: number;
  basePathLossDb: number;
  diffractionLossDb: number;
  // Only meaningful when useTerrainData was requested: true if a full
  // terrain profile was resolved for this point (diffractionLossDb is a
  // real computed value, possibly genuinely 0 for a clear line of sight),
  // false if terrain data was requested but unavailable for this point
  // (diffractionLossDb was left at 0 as a fallback, not because the path
  // is actually clear) — callers need this distinction to report accurate
  // "N cells used real terrain, M cells fell back" warnings.
  terrainDataResolved: boolean | undefined;
  // The LOS/NLOS determination actually used to pick the 'close-in' model's
  // exponent (from real terrain when available, else the caller's own
  // override) — undefined when not applicable (a different model, or no
  // terrain/override available).
  isLineOfSight: boolean | undefined;
  // Distinct from isLineOfSight above — see fresnel-zone.ts/diffraction.ts's
  // header comments. Only defined when useTerrainData resolved a real
  // profile; undefined otherwise (matches isLineOfSight's own convention).
  losClassification: LosClassification | undefined;
  fresnelClearancePercent: number | null | undefined;
  combinedLossDb: number;
  directionalGainDbi: number;
  eirpDbm: number;
  totalReceivedPowerDbm: number;
  // 'itm' only — a real per-call equation trace (depends on the full
  // terrain profile, so it can't be cheaply recomputed afterward from
  // scalars the way every other model's "representative worked example" is
  // — see BasePathLossResult's comment) and ITM's own human-readable
  // near-limit warnings (distinct from rf-types.ts's Warning shape, which
  // callers wrap these strings into at the request level).
  equation?: EquationRecord;
  modelWarnings?: string[];
}

// Returns null when the point falls outside the base propagation model's
// valid distance range (e.g. inside Hata's 1km minimum) — callers skip
// that point for that site, same treatment as a point outside a grid's
// radius.
export async function computeSiteSignalAtPoint(
  params: ResolvedSiteParams, pointLat: number, pointLon: number, logger?: pino.Logger,
): Promise<SiteSignalAtPoint | null> {
  const distanceM = Math.max(haversineDistanceM(params.siteLat, params.siteLon, pointLat, pointLon), 1);

  // Terrain is fetched first (when requested) so its real LOS/NLOS
  // determination can inform the 'close-in' model's exponent choice below,
  // not just add diffraction loss on top afterward.
  let diffractionLossDb = 0;
  let terrainDataResolved: boolean | undefined;
  let isLineOfSight = params.isLineOfSight;
  let losClassification: LosClassification | undefined;
  let fresnelClearancePercentResult: number | null | undefined;
  let resolvedTerrainProfile: TerrainProfilePoint[] | undefined;
  if (params.useTerrainData) {
    const profile = await getTerrainProfile(params.siteLat, params.siteLon, pointLat, pointLon, params.terrainSampleCount, logger);
    const resolved: TerrainProfilePoint[] = profile
      .filter((p): p is { distanceM: number; elevationM: number } => p.elevationM != null)
      .map(p => ({ distanceM: p.distanceM, elevationM: p.elevationM }));
    if (resolved.length === profile.length && resolved.length >= 2) {
      resolvedTerrainProfile = resolved;
      const diffraction = computeDiffractionLossDb(
        resolved, params.siteHeightM, params.receiverHeightM, params.frequencyHz,
        params.earthCurvatureKFactor, params.fresnelClearanceThresholdPercent,
      );
      // ITM's own algorithm already models diffraction/troposcatter
      // internally (itm-model.ts) — adding this separately-computed
      // Deygout figure on top of ITM's own basePathLossDb would double
      // count it. The LOS classification/Fresnel-clearance numbers are
      // still genuinely independent diagnostic information either way, so
      // those stay populated regardless of which model is active.
      if (params.propagationModel !== 'itm') {
        diffractionLossDb = diffraction.totalLossDb;
      }
      isLineOfSight = diffraction.isLineOfSight;
      losClassification = diffraction.losClassification;
      fresnelClearancePercentResult = diffraction.fresnelClearancePercent;
      terrainDataResolved = true;
    } else {
      terrainDataResolved = false;
    }
  }

  const base = await computeBasePathLossDb(
    params.propagationModel, distanceM, params.frequencyHz, params.frequencyMhz,
    params.siteHeightM, params.receiverHeightM, params.environment, params.cityType,
    params.pathLossExponent, isLineOfSight, params.logDistanceEnvironment,
    params.walfischIkegamiMode, params.buildingHeightM, params.streetWidthM,
    params.buildingSeparationM, params.streetOrientationDeg,
    resolvedTerrainProfile, params.groundConductivity, params.groundPermittivity,
    params.surfaceRefractivityN0, params.radioClimate, params.polarization,
    params.modeOfVariability, params.timePercent, params.locationPercent, params.situationPercent,
  );
  if (base == null) return null;
  const basePathLossDb = base.pathLossDb;

  const bearingDeg = initialBearingDeg(params.siteLat, params.siteLon, pointLat, pointLon);
  const azimuthOffsetDeg = normalizeAngleDeg(bearingDeg - params.azimuthDeg);
  const elevationToPointDeg = elevationAngleDeg(params.receiverHeightM - params.siteHeightM, distanceM);
  const elevationOffsetDeg = elevationToPointDeg + params.totalDowntiltDeg;

  const horizontalLossDb = horizontalPatternLossDb(azimuthOffsetDeg, params.horizontalBeamwidthDeg, params.frontToBackDb);
  const verticalLossDb = verticalPatternLossDb(elevationOffsetDeg, params.verticalBeamwidthDeg, params.frontToBackDb);
  const combinedLossDb = combinedPatternLossDb(horizontalLossDb, verticalLossDb, params.frontToBackDb);
  const directionalGainDbi = directionalAntennaGainDb(params.antennaGainDbi, combinedLossDb);

  const eirpDbm = params.txPowerDbm - params.cableLossDb - params.connectorLossDb - params.filterLossDb + directionalGainDbi;
  const totalReceivedPowerDbm = eirpDbm - basePathLossDb - diffractionLossDb
    - params.buildingLossDb - params.foliageLossDb - params.miscLossDb + params.ueAntennaGainDbi;

  return {
    distanceM, azimuthOffsetDeg, elevationOffsetDeg, basePathLossDb, diffractionLossDb, terrainDataResolved,
    isLineOfSight, losClassification, fresnelClearancePercent: fresnelClearancePercentResult,
    combinedLossDb, directionalGainDbi, eirpDbm, totalReceivedPowerDbm,
    equation: base.equation, modelWarnings: base.modelWarnings,
  };
}
