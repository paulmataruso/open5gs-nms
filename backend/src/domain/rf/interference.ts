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
  PropagationModel, HataEnvironment, Cost231CityType, LosClassification,
} from './rf-types';
import { EARTH_RADIUS_M } from './geometry';
import { antennaPatternEquation, DEFAULT_FRONT_TO_BACK_DB, DEFAULT_VERTICAL_BEAMWIDTH_DEG } from './antenna-pattern';
import { earfcnToFrequencyMhz } from './lte-bands';
import { HATA_FREQ_RANGE_MHZ, HATA_TX_HEIGHT_RANGE_M, HATA_RX_HEIGHT_RANGE_M, COST231_FREQ_RANGE_MHZ } from './hata-model';
import { computeSiteSignalAtPoint, ResolvedSiteParams } from './site-signal';
import { getLandCoverClass, environmentFromWorldCoverClass, WorldCoverClass } from './landcover-provider';
import { sumPowersDbm } from './units';
import { thermalNoiseDbm, thermalNoiseEquation } from './noise';
import { LOG_DISTANCE_ENVIRONMENT_PRESETS } from './log-distance-model';
import {
  WI_FREQ_RANGE_MHZ, WI_BASE_HEIGHT_RANGE_M, WI_MOBILE_HEIGHT_RANGE_M,
  WI_DEFAULT_BUILDING_SEPARATION_M, WI_DEFAULT_STREET_ORIENTATION_DEG, wiDefaultStreetWidthM,
} from './walfisch-ikegami-model';
import {
  ITM_FREQ_RANGE_MHZ, ITM_HEIGHT_RANGE_M, ITM_REFRACTIVITY_RANGE_N0, ITM_VARIABILITY_PERCENT_RANGE,
  ITM_DEFAULT_GROUND_CONDUCTIVITY_S_PER_M, ITM_DEFAULT_GROUND_PERMITTIVITY, ITM_DEFAULT_SURFACE_REFRACTIVITY_N0,
  ITM_DEFAULT_RADIO_CLIMATE, ITM_DEFAULT_POLARIZATION, ITM_DEFAULT_VARIABILITY_MODE,
  ITM_DEFAULT_TIME_PERCENT, ITM_DEFAULT_LOCATION_PERCENT, ITM_DEFAULT_SITUATION_PERCENT,
} from './itm-model';

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
export async function resolveSite(site: InterferenceSiteInput, assumptions: Assumption[], logger?: pino.Logger): Promise<{ params: ResolvedSiteParams } | { error: string }> {
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
  let environment: HataEnvironment = site.environment ?? 'urban';
  let cityType: Cost231CityType = site.cityType ?? 'medium';
  const usesEnvironment = propagationModel === 'hata';
  const usesCityType = propagationModel === 'cost231-hata' || propagationModel === 'walfisch-ikegami';
  if (site.autoDetectEnvironment && site.environment == null && site.cityType == null && (usesEnvironment || usesCityType)) {
    const worldCoverClass = await getLandCoverClass(site.siteLat, site.siteLon, logger);
    if (worldCoverClass != null) {
      const detected = environmentFromWorldCoverClass(worldCoverClass);
      environment = detected.environment;
      cityType = detected.cityType;
      assumptions.push({
        parameter: `${site.name}.${usesEnvironment ? 'environment' : 'cityType'}`,
        assumedValue: usesEnvironment ? environment : cityType,
        reason: `Auto-detected from ESA WorldCover land cover at the site's location (classified as ${WorldCoverClass[worldCoverClass]}) — a coarse built-up-vs-not convention this tool applies (WorldCover doesn't distinguish clutter density beyond that), not a WorldCover- or 3GPP-specified mapping`,
        overridable: true,
      });
    } else {
      assumptions.push({
        parameter: `${site.name}.autoDetectEnvironment`, assumedValue: 'unavailable',
        reason: 'Auto-detect from land cover was requested, but no ESA WorldCover data was available for this location — fell back to the standard default instead',
        overridable: true,
      });
    }
  }
  const logDistanceEnvironment = site.logDistanceEnvironment ?? 'urban';
  if (propagationModel === 'log-distance' && !LOG_DISTANCE_ENVIRONMENT_PRESETS[logDistanceEnvironment].verified && site.pathLossExponent == null) {
    assumptions.push({
      parameter: `${site.name}.logDistanceEnvironment`, assumedValue: logDistanceEnvironment,
      reason: `Unverified preset (n=${LOG_DISTANCE_ENVIRONMENT_PRESETS[logDistanceEnvironment].pathLossExponent}) — no single citable reference was found for it`,
      overridable: true,
    });
  }
  const walfischIkegamiMode = site.walfischIkegamiMode ?? 'nlos';
  let buildingSeparationM = site.buildingSeparationM;
  let streetWidthM = site.streetWidthM;
  const streetOrientationDeg = site.streetOrientationDeg ?? WI_DEFAULT_STREET_ORIENTATION_DEG;
  if (propagationModel === 'walfisch-ikegami') {
    if (walfischIkegamiMode === 'nlos' && site.buildingHeightM == null) {
      return { error: `${site.name}: propagationModel 'walfisch-ikegami' in NLOS mode requires buildingHeightM — no honest default exists for site-specific building geometry` };
    }
    if (buildingSeparationM == null) {
      buildingSeparationM = WI_DEFAULT_BUILDING_SEPARATION_M;
      assumptions.push({
        parameter: `${site.name}.buildingSeparationM`, assumedValue: buildingSeparationM, unit: 'm',
        reason: "COST-231 only specifies a 20-50m range, not a single value; 35m is this tool's own midpoint convention",
        overridable: true,
      });
    }
    if (streetWidthM == null) {
      streetWidthM = wiDefaultStreetWidthM(buildingSeparationM);
      assumptions.push({
        parameter: `${site.name}.streetWidthM`, assumedValue: streetWidthM, unit: 'm',
        reason: "Defaulted to buildingSeparationM/2, the COST-231 standard's own recommended relationship",
        overridable: true,
      });
    }
  }
  if (propagationModel === 'itm' && !site.useTerrainData) {
    return { error: `${site.name}: propagationModel 'itm' requires useTerrainData:true — ITM's entire algorithm operates on a real terrain profile, not an abstract distance` };
  }
  const groundConductivity = site.groundConductivity ?? ITM_DEFAULT_GROUND_CONDUCTIVITY_S_PER_M;
  const groundPermittivity = site.groundPermittivity ?? ITM_DEFAULT_GROUND_PERMITTIVITY;
  const surfaceRefractivityN0 = site.surfaceRefractivityN0 ?? ITM_DEFAULT_SURFACE_REFRACTIVITY_N0;
  const radioClimate = site.radioClimate ?? ITM_DEFAULT_RADIO_CLIMATE;
  const polarization = site.polarization ?? ITM_DEFAULT_POLARIZATION;
  const modeOfVariability = site.modeOfVariability ?? ITM_DEFAULT_VARIABILITY_MODE;
  const timePercent = site.timePercent ?? ITM_DEFAULT_TIME_PERCENT;
  const locationPercent = site.locationPercent ?? ITM_DEFAULT_LOCATION_PERCENT;
  const situationPercent = site.situationPercent ?? ITM_DEFAULT_SITUATION_PERCENT;
  if (propagationModel === 'itm') {
    const itmDefaults: [unknown, string, number | string, string][] = [
      [site.groundConductivity, 'groundConductivity', groundConductivity, 'S/m'],
      [site.groundPermittivity, 'groundPermittivity', groundPermittivity, 'dimensionless'],
      [site.surfaceRefractivityN0, 'surfaceRefractivityN0', surfaceRefractivityN0, 'N-units'],
      [site.radioClimate, 'radioClimate', radioClimate, ''],
      [site.polarization, 'polarization', polarization, ''],
      [site.modeOfVariability, 'modeOfVariability', modeOfVariability, ''],
      [site.timePercent, 'timePercent', timePercent, '%'],
      [site.locationPercent, 'locationPercent', locationPercent, '%'],
      [site.situationPercent, 'situationPercent', situationPercent, '%'],
    ];
    for (const [provided, parameter, assumedValue, unit] of itmDefaults) {
      if (provided == null) {
        assumptions.push({
          parameter: `${site.name}.${parameter}`, assumedValue, ...(unit ? { unit } : {}),
          reason: "Standard \"average ground\"/\"average atmosphere\" reference value (cross-checked against two independent technical sources, not a COST-231-style tool-invented default)",
          overridable: true,
        });
      }
    }
  }

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
  } else if (propagationModel === 'walfisch-ikegami') {
    const [fMin, fMax] = WI_FREQ_RANGE_MHZ, [tMin, tMax] = WI_BASE_HEIGHT_RANGE_M, [rMin, rMax] = WI_MOBILE_HEIGHT_RANGE_M;
    if (frequencyMhz < fMin || frequencyMhz > fMax) return { error: `${site.name}: frequencyMhz ${frequencyMhz} outside Walfisch-Ikegami's valid range [${fMin}, ${fMax}] MHz` };
    if (site.siteHeightM < tMin || site.siteHeightM > tMax) return { error: `${site.name}: siteHeightM ${site.siteHeightM} outside Walfisch-Ikegami's valid range [${tMin}, ${tMax}] m` };
    if (receiverHeightM < rMin || receiverHeightM > rMax) return { error: `${site.name}: receiverHeightM ${receiverHeightM} outside Walfisch-Ikegami's valid range [${rMin}, ${rMax}] m` };
  } else if (propagationModel === 'itm') {
    const [fMin, fMax] = ITM_FREQ_RANGE_MHZ, [hMin, hMax] = ITM_HEIGHT_RANGE_M, [n0Min, n0Max] = ITM_REFRACTIVITY_RANGE_N0, [pMin, pMax] = ITM_VARIABILITY_PERCENT_RANGE;
    if (frequencyMhz < fMin || frequencyMhz > fMax) return { error: `${site.name}: frequencyMhz ${frequencyMhz} outside ITM's valid range [${fMin}, ${fMax}] MHz` };
    if (site.siteHeightM < hMin || site.siteHeightM > hMax) return { error: `${site.name}: siteHeightM ${site.siteHeightM} outside ITM's valid range [${hMin}, ${hMax}] m` };
    if (receiverHeightM < hMin || receiverHeightM > hMax) return { error: `${site.name}: receiverHeightM ${receiverHeightM} outside ITM's valid range [${hMin}, ${hMax}] m` };
    if (surfaceRefractivityN0 < n0Min || surfaceRefractivityN0 > n0Max) return { error: `${site.name}: surfaceRefractivityN0 ${surfaceRefractivityN0} outside ITM's valid range [${n0Min}, ${n0Max}] N-units` };
    if (groundPermittivity < 1) return { error: `${site.name}: groundPermittivity ${groundPermittivity} must be >= 1` };
    if (groundConductivity <= 0) return { error: `${site.name}: groundConductivity ${groundConductivity} must be > 0 S/m` };
    if (timePercent <= pMin || timePercent >= pMax) return { error: `${site.name}: timePercent ${timePercent} outside ITM's valid range (${pMin}, ${pMax})%` };
    if (locationPercent <= pMin || locationPercent >= pMax) return { error: `${site.name}: locationPercent ${locationPercent} outside ITM's valid range (${pMin}, ${pMax})%` };
    if (situationPercent <= pMin || situationPercent >= pMax) return { error: `${site.name}: situationPercent ${situationPercent} outside ITM's valid range (${pMin}, ${pMax})%` };
  }

  return {
    params: {
      siteLat: site.siteLat, siteLon: site.siteLon, siteHeightM: site.siteHeightM,
      azimuthDeg: site.azimuthDeg, horizontalBeamwidthDeg: site.horizontalBeamwidthDeg, verticalBeamwidthDeg,
      totalDowntiltDeg: mechanicalDowntiltDeg + electricalDowntiltDeg, frontToBackDb,
      txPowerDbm: site.txPowerDbm, cableLossDb: site.cableLossDb, connectorLossDb: site.connectorLossDb, filterLossDb,
      antennaGainDbi: site.antennaGainDbi, frequencyMhz, frequencyHz,
      buildingLossDb, foliageLossDb, miscLossDb, ueAntennaGainDbi, receiverHeightM,
      propagationModel, environment, cityType, logDistanceEnvironment,
      useTerrainData: !!site.useTerrainData, terrainSampleCount: site.terrainSampleCount ?? DEFAULT_TERRAIN_SAMPLE_COUNT,
      pathLossExponent: site.pathLossExponent, isLineOfSight: site.isLineOfSight,
      earthCurvatureKFactor: site.earthCurvatureKFactor, fresnelClearanceThresholdPercent: site.fresnelClearanceThresholdPercent,
      walfischIkegamiMode, buildingHeightM: site.buildingHeightM, streetWidthM, buildingSeparationM,
      streetOrientationDeg,
      groundConductivity, groundPermittivity, surfaceRefractivityN0, radioClimate, polarization,
      modeOfVariability, timePercent, locationPercent, situationPercent,
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
    const resolved = await resolveSite(site, assumptions, logger);
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
  const itmModelWarnings = new Set<string>();

  for (let row = 0; row < resolution; row++) {
    const northOffsetM = -input.radiusM + (row + 0.5) * stepM;
    for (let col = 0; col < resolution; col++) {
      const eastOffsetM = -input.radiusM + (col + 0.5) * stepM;
      const cellLat = input.centerLat + northOffsetM / metersPerDegLat;
      const cellLon = input.centerLon + eastOffsetM / metersPerDegLon;

      const signals: {
        site: InterferenceSiteInput; dbm: number; combinedLossDb: number; azimuthOffsetDeg: number; elevationOffsetDeg: number;
        losClassification: LosClassification | undefined; fresnelClearancePercent: number | null | undefined;
      }[] = [];
      for (const { site, params } of resolvedSites) {
        const signal = await computeSiteSignalAtPoint(params, cellLat, cellLon, logger);
        if (signal) {
          signals.push({
            site, dbm: signal.totalReceivedPowerDbm, combinedLossDb: signal.combinedLossDb,
            azimuthOffsetDeg: signal.azimuthOffsetDeg, elevationOffsetDeg: signal.elevationOffsetDeg,
            losClassification: signal.losClassification, fresnelClearancePercent: signal.fresnelClearancePercent,
          });
          if (signal.modelWarnings) for (const w of signal.modelWarnings) itmModelWarnings.add(w);
        }
      }

      if (signals.length === 0) {
        cells.push({ lat: cellLat, lon: cellLon, row, col, servingSiteId: null, servingDbm: null, sinrDb: null, losClassification: undefined, fresnelClearancePercent: undefined });
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
        losClassification: serving.losClassification, fresnelClearancePercent: serving.fresnelClearancePercent,
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
      message: `${noDataCount} grid cell(s) were outside every site's propagation model range (or, for an ITM site, had no resolvable terrain profile) and have no predicted signal.`,
      severity: 'info',
    });
  }
  if (itmModelWarnings.size > 0) {
    warnings.push({
      code: 'ITM_MODEL_WARNING',
      message: `ITM raised the following near-limit warning(s) on at least one site/cell: ${[...itmModelWarnings].join('; ')}.`,
      severity: 'warning',
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
