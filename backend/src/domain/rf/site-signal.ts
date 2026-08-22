// Single-cell directional signal computation for one site at one point —
// the shared core used by both coverage-grid.ts (a grid of cells around
// ONE site) and interference.ts (multiple sites evaluated at the SAME
// shared grid of points, for SINR). Defined exactly once here so the two
// callers can never drift out of sync with each other, matching this
// engine's existing rule against re-implementing a formula in more than
// one place (see pathloss-fspl.ts's km/miles wrappers, lte-bands.ts's
// inverse EARFCN formula, etc.).

import pino from 'pino';
import { PropagationModel, HataEnvironment, Cost231CityType } from './rf-types';
import { haversineDistanceM, initialBearingDeg } from './geometry';
import { elevationAngleDeg } from './elevation-downtilt';
import { fsplDb } from './pathloss-fspl';
import {
  hataPathLossDb, cost231HataPathLossDb, HATA_DISTANCE_RANGE_KM, COST231_DISTANCE_RANGE_KM,
} from './hata-model';
import { closeInPathLossDb, UMI_SC_LOS_PLE, UMI_SC_NLOS_PLE } from './close-in-model';
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
export function computeBasePathLossDb(
  propagationModel: PropagationModel, distanceM: number, frequencyHz: number, frequencyMhz: number,
  txHeightM: number, rxHeightM: number, environment: HataEnvironment, cityType: Cost231CityType,
  pathLossExponent?: number, isLineOfSight?: boolean,
): number | null {
  if (propagationModel === 'fspl') {
    return fsplDb(distanceM, frequencyHz);
  }
  if (propagationModel === 'close-in') {
    const n = pathLossExponent ?? (isLineOfSight ? UMI_SC_LOS_PLE : UMI_SC_NLOS_PLE);
    return closeInPathLossDb(distanceM, frequencyHz, n);
  }
  const distanceKm = distanceM / 1000;
  if (propagationModel === 'hata') {
    if (distanceKm < HATA_DISTANCE_RANGE_KM[0] || distanceKm > HATA_DISTANCE_RANGE_KM[1]) return null;
    const r = hataPathLossDb(frequencyMhz, txHeightM, rxHeightM, distanceKm, environment);
    return r.ok ? r.pathLossDb : null;
  }
  if (distanceKm < COST231_DISTANCE_RANGE_KM[0] || distanceKm > COST231_DISTANCE_RANGE_KM[1]) return null;
  const r = cost231HataPathLossDb(frequencyMhz, txHeightM, rxHeightM, distanceKm, cityType);
  return r.ok ? r.pathLossDb : null;
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
  // 'close-in' only.
  pathLossExponent?: number;
  isLineOfSight?: boolean;
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
  combinedLossDb: number;
  directionalGainDbi: number;
  eirpDbm: number;
  totalReceivedPowerDbm: number;
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
  if (params.useTerrainData) {
    const profile = await getTerrainProfile(params.siteLat, params.siteLon, pointLat, pointLon, params.terrainSampleCount, logger);
    const resolved: TerrainProfilePoint[] = profile
      .filter((p): p is { distanceM: number; elevationM: number } => p.elevationM != null)
      .map(p => ({ distanceM: p.distanceM, elevationM: p.elevationM }));
    if (resolved.length === profile.length && resolved.length >= 2) {
      const diffraction = computeDiffractionLossDb(resolved, params.siteHeightM, params.receiverHeightM, params.frequencyHz);
      diffractionLossDb = diffraction.totalLossDb;
      isLineOfSight = diffraction.isLineOfSight;
      terrainDataResolved = true;
    } else {
      terrainDataResolved = false;
    }
  }

  const basePathLossDb = computeBasePathLossDb(
    params.propagationModel, distanceM, params.frequencyHz, params.frequencyMhz,
    params.siteHeightM, params.receiverHeightM, params.environment, params.cityType,
    params.pathLossExponent, isLineOfSight,
  );
  if (basePathLossDb == null) return null;

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
    isLineOfSight, combinedLossDb, directionalGainDbi, eirpDbm, totalReceivedPowerDbm,
  };
}
