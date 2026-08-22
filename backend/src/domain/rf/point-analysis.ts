import pino from 'pino';
import { PointAnalysisInput, PointAnalysisResult, CalculationResult, Warning, okResult } from './rf-types';
import { haversineDistanceM, initialBearingDeg, geometryEquations } from './geometry';
import {
  elevationAngleDeg, geometricDowntiltDeg, elevationEquation,
  geometricDowntiltEquation, totalConfiguredDowntiltEquation,
} from './elevation-downtilt';
import { getTerrainProfile } from './terrain-profile';
import { computeDiffractionLossDb, TerrainProfilePoint } from './diffraction';

const DEFAULT_TERRAIN_SAMPLE_COUNT = 16;

export async function calculatePointAnalysis(input: PointAnalysisInput, logger?: pino.Logger): Promise<CalculationResult<PointAnalysisResult>> {
  const distanceM = haversineDistanceM(input.siteLat, input.siteLon, input.targetLat, input.targetLon);
  const bearingDeg = initialBearingDeg(input.siteLat, input.siteLon, input.targetLat, input.targetLon);

  const warnings: Warning[] = [];
  let siteGroundElevationM: number | undefined;
  let targetGroundElevationM: number | undefined;
  let isLineOfSight: boolean | undefined;
  let diffractionLossDb: number | undefined;

  // Real ground elevation, when requested, replaces the flat-earth
  // assumption that both ends sit at the same ground level — siteHeightM/
  // targetHeightM are treated as height-above-ground (AGL), added to the
  // real ground elevation at each end.
  let effectiveSiteHeightM = input.siteHeightM;
  let effectiveTargetHeightM = input.targetHeightM;

  if (input.useTerrainData) {
    const profile = await getTerrainProfile(
      input.siteLat, input.siteLon, input.targetLat, input.targetLon,
      input.terrainSampleCount ?? DEFAULT_TERRAIN_SAMPLE_COUNT, logger,
    );
    const resolved: TerrainProfilePoint[] = profile
      .filter((p): p is { distanceM: number; elevationM: number } => p.elevationM != null)
      .map(p => ({ distanceM: p.distanceM, elevationM: p.elevationM }));

    if (resolved.length === profile.length && resolved.length >= 2) {
      siteGroundElevationM = resolved[0].elevationM;
      targetGroundElevationM = resolved[resolved.length - 1].elevationM;
      effectiveSiteHeightM = siteGroundElevationM + input.siteHeightM;
      effectiveTargetHeightM = targetGroundElevationM + input.targetHeightM;

      // Point Analysis has no propagation frequency of its own (it's pure
      // geometry, not a link budget) — diffraction geometry (the Fresnel
      // parameter) depends only weakly on frequency choice relative to the
      // terrain profile itself, so a representative mid-band reference
      // (2 GHz) is used here purely to derive isLineOfSight/diffractionLossDb
      // as an informational preview; the real, frequency-accurate diffraction
      // number for an actual link comes from coverage-grid.ts/linkbudget.ts.
      const referenceFrequencyHz = 2_000_000_000;
      const diffraction = computeDiffractionLossDb(resolved, input.siteHeightM, input.targetHeightM, referenceFrequencyHz);
      isLineOfSight = diffraction.isLineOfSight;
      diffractionLossDb = diffraction.totalLossDb;
    } else {
      warnings.push({
        code: 'TERRAIN_DATA_UNAVAILABLE',
        message: 'Terrain data was requested but elevation could not be resolved for part of this path (unreachable tile or void/ocean data) — falling back to flat-earth heights.',
        severity: 'warning',
      });
    }
  }

  const heightDiffM = effectiveTargetHeightM - effectiveSiteHeightM;
  const elevDeg = elevationAngleDeg(heightDiffM, distanceM);
  const geoDowntiltDeg = geometricDowntiltDeg(effectiveSiteHeightM, effectiveTargetHeightM, distanceM);

  const calculation = [
    ...geometryEquations(input.siteLat, input.siteLon, input.targetLat, input.targetLon, distanceM, bearingDeg),
    elevationEquation(heightDiffM, distanceM, elevDeg),
    geometricDowntiltEquation(effectiveSiteHeightM, effectiveTargetHeightM, distanceM, geoDowntiltDeg),
  ];

  if (!input.useTerrainData) {
    warnings.push({
      code: 'ASSUMPTION_USED',
      message: 'Flat-earth geometry — no Earth curvature correction applied, and both ends assumed at the same ground level. Set useTerrainData to resolve real ground elevation and line-of-sight.',
      severity: 'warning',
    });
  } else if (siteGroundElevationM != null) {
    warnings.push({
      code: 'ASSUMPTION_USED',
      message: 'Earth curvature still not modeled (flat-plane geometry beyond real point-to-point ground elevation) — true curvature correction is a further-out limitation.',
      severity: 'info',
    });
    warnings.push({
      code: 'REFERENCE_FREQUENCY_USED',
      message: 'isLineOfSight/diffractionLossDb here use a representative 2 GHz reference (Point Analysis has no frequency input of its own) — for a frequency-accurate diffraction number, use the Coverage Map or Link Budget tab with useTerrainData enabled.',
      severity: 'info',
    });
  }

  const result: PointAnalysisResult = {
    distanceM, bearingDeg, elevationAngleDeg: elevDeg, geometricDowntiltDeg: geoDowntiltDeg,
    siteGroundElevationM, targetGroundElevationM, isLineOfSight, diffractionLossDb,
  };

  if (input.mechanicalDowntiltDeg != null && input.electricalDowntiltDeg != null) {
    const total = input.mechanicalDowntiltDeg + input.electricalDowntiltDeg;
    result.totalConfiguredDowntiltDeg = total;
    calculation.push(totalConfiguredDowntiltEquation(input.mechanicalDowntiltDeg, input.electricalDowntiltDeg, total));
  }

  return okResult(result, calculation, { warnings, model: 'Point Analysis (Geometry)' });
}
