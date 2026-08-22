// Multi-sector interference/SINR grid. Reuses site-signal.ts's
// computeSiteSignalAtPoint (the same per-cell primitive coverage-grid.ts
// uses) for every site at every point of ONE SHARED grid centered on
// `centerLat`/`centerLon` — deliberately not each site's own grid, since
// sites at different locations need a common coordinate system before
// their signals can be compared cell-by-cell. At each cell: the strongest
// site is the "serving" site, every other site's signal is combined as
// interference via the already-built sumPowersDbm (linear-domain power
// summation, units.ts), and the already-built thermalNoiseDbm (noise.ts)
// supplies the noise floor — SINR = servingDbm − sumPowersDbm(interferers,
// noiseFloorDbm).
//
// Works over sites explicitly passed in by the caller (typically a
// project's saved candidate sites, see rf-planning-projects-controller.ts)
// — not a live pull from registered radios, consistent with this tool's
// "manual entry only" posture established for the Coverage Map.

import pino from 'pino';
import {
  InterferenceGridInput, InterferenceGridResult, InterferenceCell, InterferenceSiteInput,
  CalculationResult, Assumption, Warning, EquationRecord, okResult, errResult,
  PropagationModel, HataEnvironment, Cost231CityType,
} from './rf-types';
import { EARTH_RADIUS_M } from './geometry';
import { antennaPatternEquation, DEFAULT_FRONT_TO_BACK_DB, DEFAULT_VERTICAL_BEAMWIDTH_DEG } from './antenna-pattern';
import { earfcnToFrequencyMhz } from './lte-bands';
import { HATA_FREQ_RANGE_MHZ, HATA_TX_HEIGHT_RANGE_M, HATA_RX_HEIGHT_RANGE_M, COST231_FREQ_RANGE_MHZ } from './hata-model';
import { computeSiteSignalAtPoint, ResolvedSiteParams } from './site-signal';
import { sumPowersDbm } from './units';
import { thermalNoiseDbm, thermalNoiseEquation } from './noise';

const MAX_GRID_CELLS = 4_000; // lower than coverage-grid.ts's — cost multiplies by site count here
const MAX_RESOLUTION = Math.floor(Math.sqrt(MAX_GRID_CELLS));
const MIN_RESOLUTION = 2;
const DEFAULT_RECEIVER_HEIGHT_M = 1.5;
const DEFAULT_TERRAIN_SAMPLE_COUNT = 8;
const DEFAULT_TEMPERATURE_K = 290; // conventional reference noise temperature

function resolveWithDefault(
  value: number | undefined, parameter: string, unit: string,
  defaultValue: number, reason: string, assumptions: Assumption[],
): number {
  if (value != null) return value;
  assumptions.push({ parameter, assumedValue: defaultValue, unit, reason, overridable: true });
  return defaultValue;
}

// Exported for reuse by calibration.ts / rf-planning-projects-controller.ts,
// which need the exact same frequency-resolution + defaulting + Hata/
// COST-231 range validation this module already does per site.
export function resolveSite(site: InterferenceSiteInput, assumptions: Assumption[]): { params: ResolvedSiteParams } | { error: string } {
  let frequencyMhz = site.frequencyMhz;
  if (frequencyMhz == null) {
    if (site.band != null && site.earfcn != null) {
      const r = earfcnToFrequencyMhz(site.band, site.earfcn);
      if (!r.ok) return { error: `${site.name}: ${r.error.reason}` };
      frequencyMhz = r.frequencyMhz;
    } else {
      return { error: `${site.name}: no frequency available — provide frequencyMhz, or both band and earfcn` };
    }
  }
  const frequencyHz = frequencyMhz * 1_000_000;

  const filterLossDb = resolveWithDefault(site.filterLossDb, `${site.name}.filterLossDb`, 'dB', 0, 'Not provided by caller', assumptions);
  const buildingLossDb = resolveWithDefault(site.buildingLossDb, `${site.name}.buildingLossDb`, 'dB', 0, 'Not provided by caller', assumptions);
  const foliageLossDb = resolveWithDefault(site.foliageLossDb, `${site.name}.foliageLossDb`, 'dB', 0, 'Not provided by caller', assumptions);
  const miscLossDb = resolveWithDefault(site.miscLossDb, `${site.name}.miscLossDb`, 'dB', 0, 'Not provided by caller', assumptions);
  const ueAntennaGainDbi = resolveWithDefault(site.ueAntennaGainDbi, `${site.name}.ueAntennaGainDbi`, 'dBi', 0, 'Not provided by caller', assumptions);
  const receiverHeightM = resolveWithDefault(site.receiverHeightM, `${site.name}.receiverHeightM`, 'm', DEFAULT_RECEIVER_HEIGHT_M, 'Typical handset/UE height above ground', assumptions);
  const mechanicalDowntiltDeg = resolveWithDefault(site.mechanicalDowntiltDeg, `${site.name}.mechanicalDowntiltDeg`, 'deg', 0, 'Not provided by caller', assumptions);
  const electricalDowntiltDeg = resolveWithDefault(site.electricalDowntiltDeg, `${site.name}.electricalDowntiltDeg`, 'deg', 0, 'Not provided by caller', assumptions);
  const verticalBeamwidthDeg = resolveWithDefault(site.verticalBeamwidthDeg, `${site.name}.verticalBeamwidthDeg`, 'deg', DEFAULT_VERTICAL_BEAMWIDTH_DEG, 'Typical macro/small-cell vertical beamwidth', assumptions);
  const frontToBackDb = resolveWithDefault(site.frontToBackDb, `${site.name}.frontToBackDb`, 'dB', DEFAULT_FRONT_TO_BACK_DB, 'Typical sector-antenna front-to-back/sidelobe attenuation', assumptions);

  const propagationModel: PropagationModel = site.propagationModel ?? 'fspl';
  const environment: HataEnvironment = site.environment ?? 'urban';
  const cityType: Cost231CityType = site.cityType ?? 'medium';

  if (propagationModel === 'hata') {
    const [fMin, fMax] = HATA_FREQ_RANGE_MHZ, [tMin, tMax] = HATA_TX_HEIGHT_RANGE_M, [rMin, rMax] = HATA_RX_HEIGHT_RANGE_M;
    if (frequencyMhz < fMin || frequencyMhz > fMax) return { error: `${site.name}: frequencyMhz ${frequencyMhz} outside Hata's valid range [${fMin}, ${fMax}] MHz` };
    if (site.siteHeightM < tMin || site.siteHeightM > tMax) return { error: `${site.name}: siteHeightM ${site.siteHeightM} outside Hata's valid range [${tMin}, ${tMax}] m` };
    if (receiverHeightM < rMin || receiverHeightM > rMax) return { error: `${site.name}: receiverHeightM ${receiverHeightM} outside Hata's valid range [${rMin}, ${rMax}] m` };
  } else if (propagationModel === 'cost231-hata') {
    const [fMin, fMax] = COST231_FREQ_RANGE_MHZ, [tMin, tMax] = HATA_TX_HEIGHT_RANGE_M, [rMin, rMax] = HATA_RX_HEIGHT_RANGE_M;
    if (frequencyMhz < fMin || frequencyMhz > fMax) return { error: `${site.name}: frequencyMhz ${frequencyMhz} outside COST-231-Hata's valid range [${fMin}, ${fMax}] MHz` };
    if (site.siteHeightM < tMin || site.siteHeightM > tMax) return { error: `${site.name}: siteHeightM ${site.siteHeightM} outside COST-231-Hata's valid range [${tMin}, ${tMax}] m` };
    if (receiverHeightM < rMin || receiverHeightM > rMax) return { error: `${site.name}: receiverHeightM ${receiverHeightM} outside COST-231-Hata's valid range [${rMin}, ${rMax}] m` };
  }

  return {
    params: {
      siteLat: site.siteLat, siteLon: site.siteLon, siteHeightM: site.siteHeightM,
      azimuthDeg: site.azimuthDeg, horizontalBeamwidthDeg: site.horizontalBeamwidthDeg, verticalBeamwidthDeg,
      totalDowntiltDeg: mechanicalDowntiltDeg + electricalDowntiltDeg, frontToBackDb,
      txPowerDbm: site.txPowerDbm, cableLossDb: site.cableLossDb, connectorLossDb: site.connectorLossDb, filterLossDb,
      antennaGainDbi: site.antennaGainDbi, frequencyMhz, frequencyHz,
      buildingLossDb, foliageLossDb, miscLossDb, ueAntennaGainDbi, receiverHeightM,
      propagationModel, environment, cityType,
      useTerrainData: !!site.useTerrainData, terrainSampleCount: site.terrainSampleCount ?? DEFAULT_TERRAIN_SAMPLE_COUNT,
      pathLossExponent: site.pathLossExponent, isLineOfSight: site.isLineOfSight,
    },
  };
}

export async function calculateMultiSiteInterference(input: InterferenceGridInput, logger?: pino.Logger): Promise<CalculationResult<InterferenceGridResult>> {
  const assumptions: Assumption[] = [];
  const warnings: Warning[] = [];

  if (input.sites.length === 0) {
    return errResult({ reason: 'At least one site is required', missingInputs: ['sites'] });
  }
  if (!(input.radiusM > 0)) {
    return errResult({ reason: 'radiusM must be a positive number', missingInputs: ['radiusM'] });
  }
  if (!(input.bandwidthHz > 0)) {
    return errResult({ reason: 'bandwidthHz must be a positive number', missingInputs: ['bandwidthHz'] });
  }

  const temperatureK = resolveWithDefault(input.temperatureK, 'temperatureK', 'K', DEFAULT_TEMPERATURE_K, 'Conventional reference noise temperature', assumptions);
  const noiseFigureDb = resolveWithDefault(input.noiseFigureDb, 'noiseFigureDb', 'dB', 0, 'Not provided by caller', assumptions);
  const noiseFloorDbm = thermalNoiseDbm({ temperatureK, bandwidthHz: input.bandwidthHz, noiseFigureDb });

  const resolvedSites: { site: InterferenceSiteInput; params: ResolvedSiteParams }[] = [];
  for (const site of input.sites) {
    const resolved = resolveSite(site, assumptions);
    if ('error' in resolved) {
      return errResult({ reason: resolved.error, missingInputs: [] });
    }
    resolvedSites.push({ site, params: resolved.params });
  }

  let resolution = Math.round(input.resolution);
  if (resolution < MIN_RESOLUTION) resolution = MIN_RESOLUTION;
  if (resolution > MAX_RESOLUTION) {
    warnings.push({
      code: 'RESOLUTION_CLAMPED',
      message: `Requested resolution ${input.resolution} would exceed the ${MAX_GRID_CELLS}-cell cap (lower than the single-site Coverage Map cap, since cost multiplies by ${input.sites.length} site(s) here) — clamped to ${MAX_RESOLUTION}×${MAX_RESOLUTION}.`,
      severity: 'warning',
    });
    resolution = MAX_RESOLUTION;
  }

  const metersPerDegLat = (2 * Math.PI * EARTH_RADIUS_M) / 360;
  const metersPerDegLon = metersPerDegLat * Math.cos((input.centerLat * Math.PI) / 180);
  const stepM = (2 * input.radiusM) / resolution;

  const cells: InterferenceCell[] = [];
  let noDataCount = 0;
  let bestForDoc: { cell: InterferenceCell; servingSiteName: string; combinedLossDb: number; azimuthOffsetDeg: number; elevationOffsetDeg: number } | null = null;

  for (let row = 0; row < resolution; row++) {
    const northOffsetM = -input.radiusM + (row + 0.5) * stepM;
    for (let col = 0; col < resolution; col++) {
      const eastOffsetM = -input.radiusM + (col + 0.5) * stepM;
      const cellLat = input.centerLat + northOffsetM / metersPerDegLat;
      const cellLon = input.centerLon + eastOffsetM / metersPerDegLon;

      const signals: { site: InterferenceSiteInput; dbm: number; combinedLossDb: number; azimuthOffsetDeg: number; elevationOffsetDeg: number }[] = [];
      for (const { site, params } of resolvedSites) {
        const signal = await computeSiteSignalAtPoint(params, cellLat, cellLon, logger);
        if (signal) signals.push({ site, dbm: signal.totalReceivedPowerDbm, combinedLossDb: signal.combinedLossDb, azimuthOffsetDeg: signal.azimuthOffsetDeg, elevationOffsetDeg: signal.elevationOffsetDeg });
      }

      if (signals.length === 0) {
        cells.push({ lat: cellLat, lon: cellLon, row, col, servingSiteId: null, servingDbm: null, sinrDb: null });
        noDataCount++;
        continue;
      }

      let serving = signals[0];
      for (const s of signals) if (s.dbm > serving.dbm) serving = s;
      const interferers = signals.filter(s => s.site.id !== serving.site.id).map(s => s.dbm);
      const sinrDb = serving.dbm - sumPowersDbm(...interferers, noiseFloorDbm);

      const cell: InterferenceCell = {
        lat: cellLat, lon: cellLon, row, col,
        servingSiteId: serving.site.id, servingDbm: serving.dbm, sinrDb,
      };
      cells.push(cell);

      if (!bestForDoc || sinrDb > (bestForDoc.cell.sinrDb ?? -Infinity)) {
        bestForDoc = { cell, servingSiteName: serving.site.name, combinedLossDb: serving.combinedLossDb, azimuthOffsetDeg: serving.azimuthOffsetDeg, elevationOffsetDeg: serving.elevationOffsetDeg };
      }
    }
  }

  if (!bestForDoc) {
    return errResult({ reason: 'No cell in the grid was covered by any site — check radiusM, resolution, and each site\'s propagation model range', missingInputs: [] });
  }

  warnings.push({
    code: 'ASSUMPTION_USED',
    message: 'SINR uses each site\'s directional predicted signal (same model as the Coverage Map) — real interference also depends on scheduling/frequency-reuse, not modeled here.',
    severity: 'warning',
  });
  if (noDataCount > 0) {
    warnings.push({
      code: 'CELLS_WITH_NO_SERVING_SITE',
      message: `${noDataCount} grid cell(s) were outside every site's propagation model range and have no predicted signal.`,
      severity: 'info',
    });
  }

  const bounds = {
    minLat: input.centerLat - input.radiusM / metersPerDegLat,
    maxLat: input.centerLat + input.radiusM / metersPerDegLat,
    minLon: input.centerLon - input.radiusM / metersPerDegLon,
    maxLon: input.centerLon + input.radiusM / metersPerDegLon,
  };

  const calculation: EquationRecord[] = [
    antennaPatternEquation(bestForDoc.azimuthOffsetDeg, resolvedSites[0].params.horizontalBeamwidthDeg, bestForDoc.elevationOffsetDeg, resolvedSites[0].params.verticalBeamwidthDeg, resolvedSites[0].params.frontToBackDb, bestForDoc.combinedLossDb),
    thermalNoiseEquation({ temperatureK, bandwidthHz: input.bandwidthHz, noiseFigureDb }, noiseFloorDbm),
    {
      name: 'SINR (best-predicted cell, shown as a representative example)',
      formula: 'SINR(dB) = servingDbm − sumPowersDbm(interferer1Dbm, interferer2Dbm, ..., noiseFloorDbm)',
      variables: {
        servingSite: { description: `Serving site at this cell (${bestForDoc.servingSiteName})`, unit: 'dBm', value: bestForDoc.cell.servingDbm ?? 0 },
        noiseFloor:  { description: 'Thermal noise floor', unit: 'dBm', value: noiseFloorDbm },
        SINR:        { description: 'Signal-to-Interference-plus-Noise Ratio', unit: 'dB', value: bestForDoc.cell.sinrDb ?? 0 },
      },
      source: 'sumPowersDbm (linear-domain power summation, units.ts) applied to every non-serving site\'s predicted signal plus the thermal noise floor',
      applicableConditions: 'Every site modeled with the same directional/propagation math as the Coverage Map tool',
      limitations: 'Does not model real scheduler behavior, frequency reuse, or fast fading — a static, worst-case-style co-channel interference estimate',
    },
  ];

  return okResult(
    { cells, rows: resolution, cols: resolution, bounds, siteIds: input.sites.map(s => s.id) },
    calculation,
    { assumptions, warnings, model: `Multi-Site Interference/SINR Grid (${input.sites.length} sites)` },
  );
}
