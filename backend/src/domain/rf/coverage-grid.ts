// Directional coverage heatmap grid + optional "how much TX power would I
// need to cover this drawn area" solve. Per-cell signal math is delegated
// to site-signal.ts's computeSiteSignalAtPoint — the exact same primitive
// interference.ts uses for multi-site SINR, so the two can never drift out
// of sync with each other.
//
// Performance/payload note: a full EquationRecord per grid cell would be
// wasteful at up to MAX_GRID_CELLS cells — the model is documented ONCE in
// the response's top-level `calculation` array (using the
// strongest-predicted cell as a representative worked example), and each
// cell in `result.cells` carries numeric values only. Terrain lookups are
// similarly kept cheap: a reduced sample count per cell (vs. Point
// Analysis's single-path budget) and an in-memory tile cache shared across
// the whole request (see elevation-provider.ts) keep a full-resolution
// grid's ~10,000 x ~8-sample terrain profile tractable.

import pino from 'pino';
import {
  CoverageGridInput, CoverageGridResult, CoverageGridCell, CoverageRequirement, LatLon,
  CalculationResult, Assumption, Warning, EquationRecord, okResult, errResult,
} from './rf-types';
import { haversineDistanceM, EARTH_RADIUS_M } from './geometry';
import { fsplEquation } from './pathloss-fspl';
import { antennaPatternEquation, DEFAULT_FRONT_TO_BACK_DB, DEFAULT_VERTICAL_BEAMWIDTH_DEG } from './antenna-pattern';
import { earfcnToFrequencyMhz } from './lte-bands';
import { pointInPolygon } from './polygon';
import { hataPathLossDb, cost231HataPathLossDb, HATA_FREQ_RANGE_MHZ, HATA_TX_HEIGHT_RANGE_M, HATA_RX_HEIGHT_RANGE_M, COST231_FREQ_RANGE_MHZ } from './hata-model';
import { closeInEquation, UMI_SC_LOS_PLE, UMI_SC_NLOS_PLE } from './close-in-model';
import { computeSiteSignalAtPoint, ResolvedSiteParams, SiteSignalAtPoint } from './site-signal';

export const MAX_GRID_CELLS = 10_000;
const MAX_RESOLUTION = Math.floor(Math.sqrt(MAX_GRID_CELLS));
const MIN_RESOLUTION = 2;
const DEFAULT_RECEIVER_HEIGHT_M = 1.5;
const DEFAULT_TERRAIN_SAMPLE_COUNT = 8;

function resolveWithDefault(
  value: number | undefined, parameter: string, unit: string,
  defaultValue: number, reason: string, assumptions: Assumption[],
): number {
  if (value != null) return value;
  assumptions.push({ parameter, assumedValue: defaultValue, unit, reason, overridable: true });
  return defaultValue;
}

interface BestCell extends CoverageGridCell, SiteSignalAtPoint {}

export async function calculateCoverageGrid(input: CoverageGridInput, logger?: pino.Logger): Promise<CalculationResult<CoverageGridResult>> {
  const assumptions: Assumption[] = [];
  const warnings: Warning[] = [];

  if (!(input.radiusM > 0)) {
    return errResult({ reason: 'radiusM must be a positive number', missingInputs: ['radiusM'] });
  }

  let frequencyMhz = input.frequencyMhz;
  if (frequencyMhz == null) {
    if (input.band != null && input.earfcn != null) {
      const r = earfcnToFrequencyMhz(input.band, input.earfcn);
      if (!r.ok) {
        return errResult({
          reason: r.error.reason,
          missingInputs: ['frequencyMhz (could not be derived from band+earfcn)'],
          availableInputs: { band: input.band, earfcn: input.earfcn },
        });
      }
      frequencyMhz = r.frequencyMhz;
    } else {
      return errResult({
        reason: 'No frequency available — provide frequencyMhz directly, or both band and earfcn',
        missingInputs: ['frequencyMhz (or band and earfcn together)'],
      });
    }
  }
  const frequencyHz = frequencyMhz * 1_000_000;

  let resolution = Math.round(input.resolution);
  if (resolution < MIN_RESOLUTION) resolution = MIN_RESOLUTION;
  if (resolution > MAX_RESOLUTION) {
    warnings.push({
      code: 'RESOLUTION_CLAMPED',
      message: `Requested resolution ${input.resolution} would exceed the ${MAX_GRID_CELLS}-cell cap — clamped to ${MAX_RESOLUTION}×${MAX_RESOLUTION}.`,
      severity: 'warning',
    });
    resolution = MAX_RESOLUTION;
  }

  const filterLossDb = resolveWithDefault(input.filterLossDb, 'filterLossDb', 'dB', 0, 'Not provided by caller', assumptions);
  const buildingLossDb = resolveWithDefault(input.buildingLossDb, 'buildingLossDb', 'dB', 0, 'Not provided by caller', assumptions);
  const foliageLossDb = resolveWithDefault(input.foliageLossDb, 'foliageLossDb', 'dB', 0, 'Not provided by caller', assumptions);
  const miscLossDb = resolveWithDefault(input.miscLossDb, 'miscLossDb', 'dB', 0, 'Not provided by caller', assumptions);
  const ueAntennaGainDbi = resolveWithDefault(input.ueAntennaGainDbi, 'ueAntennaGainDbi', 'dBi', 0, 'Not provided by caller', assumptions);
  const receiverHeightM = resolveWithDefault(input.receiverHeightM, 'receiverHeightM', 'm', DEFAULT_RECEIVER_HEIGHT_M, 'Typical handset/UE height above ground — not provided by caller', assumptions);
  const mechanicalDowntiltDeg = resolveWithDefault(input.mechanicalDowntiltDeg, 'mechanicalDowntiltDeg', 'deg', 0, 'Not provided by caller', assumptions);
  const electricalDowntiltDeg = resolveWithDefault(input.electricalDowntiltDeg, 'electricalDowntiltDeg', 'deg', 0, 'Not provided by caller', assumptions);
  const verticalBeamwidthDeg = resolveWithDefault(input.verticalBeamwidthDeg, 'verticalBeamwidthDeg', 'deg', DEFAULT_VERTICAL_BEAMWIDTH_DEG, 'Typical macro/small-cell vertical beamwidth — not a verified spec constant for your specific antenna', assumptions);
  const frontToBackDb = resolveWithDefault(input.frontToBackDb, 'frontToBackDb', 'dB', DEFAULT_FRONT_TO_BACK_DB, 'Typical sector-antenna front-to-back/sidelobe attenuation — not a verified spec constant for your specific antenna', assumptions);

  const propagationModel = input.propagationModel ?? 'fspl';
  const environment = input.environment ?? 'urban';
  const cityType = input.cityType ?? 'medium';
  if (propagationModel === 'hata' && input.environment == null) {
    assumptions.push({ parameter: 'environment', assumedValue: environment, reason: 'Not provided by caller', overridable: true });
  }
  if (propagationModel === 'cost231-hata' && input.cityType == null) {
    assumptions.push({ parameter: 'cityType', assumedValue: cityType, reason: 'Not provided by caller', overridable: true });
  }

  // Fail fast on frequency/height ranges (constant across the whole grid) —
  // distance range is checked per cell inside computeSiteSignalAtPoint,
  // since that varies per cell.
  if (propagationModel === 'hata') {
    const [fMin, fMax] = HATA_FREQ_RANGE_MHZ, [tMin, tMax] = HATA_TX_HEIGHT_RANGE_M, [rMin, rMax] = HATA_RX_HEIGHT_RANGE_M;
    const problems: string[] = [];
    if (frequencyMhz < fMin || frequencyMhz > fMax) problems.push(`frequencyMhz ${frequencyMhz} outside Hata's valid range [${fMin}, ${fMax}] MHz`);
    if (input.siteHeightM < tMin || input.siteHeightM > tMax) problems.push(`siteHeightM ${input.siteHeightM} outside Hata's valid range [${tMin}, ${tMax}] m`);
    if (receiverHeightM < rMin || receiverHeightM > rMax) problems.push(`receiverHeightM ${receiverHeightM} outside Hata's valid range [${rMin}, ${rMax}] m`);
    if (problems.length > 0) return errResult({ reason: `Hata model: ${problems.join('; ')}`, missingInputs: [] });
  } else if (propagationModel === 'cost231-hata') {
    const [fMin, fMax] = COST231_FREQ_RANGE_MHZ, [tMin, tMax] = HATA_TX_HEIGHT_RANGE_M, [rMin, rMax] = HATA_RX_HEIGHT_RANGE_M;
    const problems: string[] = [];
    if (frequencyMhz < fMin || frequencyMhz > fMax) problems.push(`frequencyMhz ${frequencyMhz} outside COST-231-Hata's valid range [${fMin}, ${fMax}] MHz`);
    if (input.siteHeightM < tMin || input.siteHeightM > tMax) problems.push(`siteHeightM ${input.siteHeightM} outside COST-231-Hata's valid range [${tMin}, ${tMax}] m`);
    if (receiverHeightM < rMin || receiverHeightM > rMax) problems.push(`receiverHeightM ${receiverHeightM} outside COST-231-Hata's valid range [${rMin}, ${rMax}] m`);
    if (problems.length > 0) return errResult({ reason: `COST-231-Hata model: ${problems.join('; ')}`, missingInputs: [] });
  }

  const siteParams: ResolvedSiteParams = {
    siteLat: input.siteLat, siteLon: input.siteLon, siteHeightM: input.siteHeightM,
    azimuthDeg: input.azimuthDeg, horizontalBeamwidthDeg: input.horizontalBeamwidthDeg, verticalBeamwidthDeg,
    totalDowntiltDeg: mechanicalDowntiltDeg + electricalDowntiltDeg, frontToBackDb,
    txPowerDbm: input.txPowerDbm, cableLossDb: input.cableLossDb, connectorLossDb: input.connectorLossDb, filterLossDb,
    antennaGainDbi: input.antennaGainDbi, frequencyMhz, frequencyHz,
    buildingLossDb, foliageLossDb, miscLossDb, ueAntennaGainDbi, receiverHeightM,
    propagationModel, environment, cityType,
    useTerrainData: !!input.useTerrainData, terrainSampleCount: input.terrainSampleCount ?? DEFAULT_TERRAIN_SAMPLE_COUNT,
    pathLossExponent: input.pathLossExponent, isLineOfSight: input.isLineOfSight,
  };

  const metersPerDegLat = (2 * Math.PI * EARTH_RADIUS_M) / 360;
  const metersPerDegLon = metersPerDegLat * Math.cos((input.siteLat * Math.PI) / 180);
  const stepM = (2 * input.radiusM) / resolution;

  const cells: CoverageGridCell[] = [];
  let bestCell: BestCell | null = null;
  const inPolygonCells: { cell: CoverageGridCell; effectivePathLossDb: number; directionalGainDbi: number }[] = [];

  const hasPolygon = !!(input.targetPolygon && input.targetPolygon.length >= 3);
  let skippedOutOfModelRange = 0;
  let terrainUnavailableCount = 0;
  let terrainAppliedCount = 0;

  for (let row = 0; row < resolution; row++) {
    const northOffsetM = -input.radiusM + (row + 0.5) * stepM;
    for (let col = 0; col < resolution; col++) {
      const eastOffsetM = -input.radiusM + (col + 0.5) * stepM;

      const cellLat = input.siteLat + northOffsetM / metersPerDegLat;
      const cellLon = input.siteLon + eastOffsetM / metersPerDegLon;

      const distanceM = Math.max(haversineDistanceM(input.siteLat, input.siteLon, cellLat, cellLon), 1);
      if (distanceM > input.radiusM) continue;

      const signal = await computeSiteSignalAtPoint(siteParams, cellLat, cellLon, logger);
      if (!signal) { skippedOutOfModelRange++; continue; }
      if (signal.terrainDataResolved === true) terrainAppliedCount++;
      else if (signal.terrainDataResolved === false) terrainUnavailableCount++;

      const insideTargetPolygon = hasPolygon
        ? pointInPolygon({ lat: cellLat, lon: cellLon }, input.targetPolygon as LatLon[])
        : undefined;

      const cell: CoverageGridCell = {
        lat: cellLat, lon: cellLon, row, col, distanceM: signal.distanceM, totalReceivedPowerDbm: signal.totalReceivedPowerDbm,
        ...(insideTargetPolygon !== undefined ? { insideTargetPolygon } : {}),
      };
      cells.push(cell);

      if (!bestCell || signal.totalReceivedPowerDbm > bestCell.totalReceivedPowerDbm) {
        bestCell = { ...cell, ...signal };
      }

      if (insideTargetPolygon) {
        inPolygonCells.push({ cell, effectivePathLossDb: signal.basePathLossDb + signal.diffractionLossDb, directionalGainDbi: signal.directionalGainDbi });
      }
    }
  }

  if (!bestCell) {
    return errResult({ reason: 'No valid grid cells were computed — check radiusM, resolution, and (if using Hata/COST-231-Hata) that the radius stays within the model\'s valid distance range', missingInputs: [] });
  }

  warnings.push({
    code: 'NOT_RSRP',
    message: 'Each cell\'s totalReceivedPowerDbm is total wideband received power, not LTE RSRP (3GPP TS 36.214 RSRP needs resource-block/reference-signal power-boosting data not modeled here).',
    severity: 'info',
  });
  warnings.push({
    code: 'ASSUMPTION_USED',
    message: propagationModel === 'fspl'
      ? 'Free-space propagation model only — no terrain, shadowing margin, clutter, or interference modeled beyond the loss values you supplied.'
      : propagationModel === 'close-in'
        ? 'Close-In model uses a measured UMi Street Canyon path-loss exponent — a real average for low-height small-cell deployments, not a site-specific fit for your exact deployment.'
        : `${propagationModel === 'hata' ? 'Hata' : 'COST-231-Hata'} empirical model — average clutter loss for the ${propagationModel === 'hata' ? environment : cityType} environment class, not necessarily this exact deployment's real clutter.`,
    severity: 'warning',
  });
  warnings.push({
    code: 'SIMPLIFIED_PATTERN',
    message: 'Directional gain uses a simplified 2D-separable 3GPP sector pattern (horizontal × vertical treated independently), not a measured 3D radiation pattern for a specific antenna model.',
    severity: 'warning',
  });
  if (skippedOutOfModelRange > 0) {
    warnings.push({
      code: 'CELLS_SKIPPED_OUT_OF_MODEL_RANGE',
      message: `${skippedOutOfModelRange} grid cell(s) were skipped because their distance fell outside the ${propagationModel === 'hata' ? 'Hata' : 'COST-231-Hata'} model's valid range — reduce radiusM or switch to the FSPL model to cover those points.`,
      severity: 'warning',
    });
  }
  if (input.useTerrainData) {
    if (terrainAppliedCount > 0) {
      warnings.push({
        code: 'TERRAIN_DIFFRACTION_APPLIED',
        message: `Terrain-based diffraction loss (ITU-R P.526 Deygout method) was evaluated on top of the base propagation model for ${terrainAppliedCount} cell(s)${terrainUnavailableCount > 0 ? `; ${terrainUnavailableCount} cell(s) fell back to no terrain adjustment (elevation data unavailable for part of that path)` : ''}.`,
        severity: 'info',
      });
    } else {
      warnings.push({
        code: 'TERRAIN_DATA_UNAVAILABLE',
        message: 'Terrain data was requested but could not be resolved for any cell (unreachable elevation tiles) — every cell fell back to the base propagation model with no terrain adjustment.',
        severity: 'warning',
      });
    }
  }

  let coverageRequirement: CoverageRequirement | undefined;
  if (hasPolygon && input.minAcceptableSignalDbm != null) {
    if (inPolygonCells.length === 0) {
      warnings.push({
        code: 'NO_CELLS_IN_POLYGON',
        message: 'No sampled grid cells fell inside the drawn target area — increase resolution or radius to get a coverage-requirement estimate.',
        severity: 'error',
      });
    } else {
      let limiting = inPolygonCells[0];
      let maxRequiredTxPowerDbm = -Infinity;
      for (const c of inPolygonCells) {
        const requiredEirpDbm = input.minAcceptableSignalDbm + c.effectivePathLossDb + buildingLossDb + foliageLossDb + miscLossDb - ueAntennaGainDbi;
        const requiredTxPowerDbm = requiredEirpDbm + input.cableLossDb + input.connectorLossDb + filterLossDb - c.directionalGainDbi;
        if (requiredTxPowerDbm > maxRequiredTxPowerDbm) {
          maxRequiredTxPowerDbm = requiredTxPowerDbm;
          limiting = c;
        }
      }
      coverageRequirement = {
        requiredTxPowerDbm: maxRequiredTxPowerDbm,
        limitingPoint: { lat: limiting.cell.lat, lon: limiting.cell.lon },
        limitingDistanceM: limiting.cell.distanceM,
        thresholdDbm: input.minAcceptableSignalDbm,
        pointsSampled: inPolygonCells.length,
      };
      warnings.push({
        code: 'GRID_RESOLUTION_BOUND',
        message: `Coverage-requirement precision is bounded by grid resolution (${resolution}×${resolution}, ${inPolygonCells.length} points sampled inside the drawn area) — increase resolution for a tighter estimate.`,
        severity: 'info',
      });
    }
  }

  const bounds = {
    minLat: input.siteLat - input.radiusM / metersPerDegLat,
    maxLat: input.siteLat + input.radiusM / metersPerDegLat,
    minLon: input.siteLon - input.radiusM / metersPerDegLon,
    maxLon: input.siteLon + input.radiusM / metersPerDegLon,
  };

  let pathLossEquation: EquationRecord;
  if (propagationModel === 'fspl') {
    pathLossEquation = fsplEquation(bestCell.distanceM, frequencyHz, bestCell.basePathLossDb);
  } else if (propagationModel === 'close-in') {
    const n = input.pathLossExponent ?? (bestCell.isLineOfSight ? UMI_SC_LOS_PLE : UMI_SC_NLOS_PLE);
    pathLossEquation = closeInEquation(bestCell.distanceM, frequencyHz, n, bestCell.isLineOfSight, bestCell.basePathLossDb);
  } else {
    const distanceKm = bestCell.distanceM / 1000;
    const r = propagationModel === 'hata'
      ? hataPathLossDb(frequencyMhz, input.siteHeightM, receiverHeightM, distanceKm, environment)
      : cost231HataPathLossDb(frequencyMhz, input.siteHeightM, receiverHeightM, distanceKm, cityType);
    // bestCell was only ever selected from cells that already passed this
    // exact model/range check, so this is always ok:true here.
    pathLossEquation = r.ok ? r.equation : fsplEquation(bestCell.distanceM, frequencyHz, bestCell.basePathLossDb);
  }

  const calculation: EquationRecord[] = [
    antennaPatternEquation(bestCell.azimuthOffsetDeg, input.horizontalBeamwidthDeg, bestCell.elevationOffsetDeg, verticalBeamwidthDeg, frontToBackDb, bestCell.combinedLossDb),
    pathLossEquation,
    {
      name: 'Link Budget Summation (strongest-predicted cell, shown as a representative example)',
      formula: input.useTerrainData
        ? 'Prx(dBm) = EIRP − pathLoss − diffractionLoss − buildingLoss − foliageLoss − miscLoss + ueAntennaGain'
        : 'Prx(dBm) = EIRP − pathLoss − buildingLoss − foliageLoss − miscLoss + ueAntennaGain',
      variables: {
        EIRP:          { description: 'Directional EIRP toward this cell', unit: 'dBm', value: bestCell.eirpDbm },
        pathLoss:      { description: 'Base propagation path loss', unit: 'dB', value: bestCell.basePathLossDb },
        ...(input.useTerrainData ? { diffractionLoss: { description: 'Terrain diffraction loss (Deygout)', unit: 'dB', value: bestCell.diffractionLossDb } } : {}),
        buildingLoss:  { description: 'Building penetration loss', unit: 'dB', value: buildingLossDb },
        foliageLoss:   { description: 'Foliage loss', unit: 'dB', value: foliageLossDb },
        miscLoss:      { description: 'Miscellaneous/margin loss', unit: 'dB', value: miscLossDb },
        ueAntennaGain: { description: 'UE/receiver antenna gain', unit: 'dBi', value: ueAntennaGainDbi },
        Prx:           { description: 'Total received power', unit: 'dBm', value: bestCell.totalReceivedPowerDbm },
      },
      source: 'Standard link-budget cascade arithmetic (dB-domain, single signal path) — cf. 3GPP TR 25.942',
      applicableConditions: 'Single-path link budget; every term modifies the same signal path',
    },
  ];

  return okResult(
    { cells, rows: resolution, cols: resolution, bounds, coverageRequirement },
    calculation,
    {
      assumptions, warnings,
      model: `Directional ${propagationModel === 'fspl' ? 'Free-Space' : propagationModel === 'hata' ? 'Hata' : propagationModel === 'cost231-hata' ? 'COST-231-Hata' : 'Close-In'} Coverage Grid${input.useTerrainData ? ' (terrain-aware)' : ''}`,
    },
  );
}
