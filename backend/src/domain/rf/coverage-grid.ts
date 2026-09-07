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
import { logDistanceEquation, LOG_DISTANCE_ENVIRONMENT_PRESETS } from './log-distance-model';
import {
  walfischIkegamiPathLossDb, WI_FREQ_RANGE_MHZ, WI_BASE_HEIGHT_RANGE_M, WI_MOBILE_HEIGHT_RANGE_M,
  WI_DEFAULT_BUILDING_SEPARATION_M, WI_DEFAULT_STREET_ORIENTATION_DEG, wiDefaultStreetWidthM,
} from './walfisch-ikegami-model';
import {
  ITM_FREQ_RANGE_MHZ, ITM_HEIGHT_RANGE_M, ITM_REFRACTIVITY_RANGE_N0, ITM_VARIABILITY_PERCENT_RANGE,
  ITM_DEFAULT_GROUND_CONDUCTIVITY_S_PER_M, ITM_DEFAULT_GROUND_PERMITTIVITY, ITM_DEFAULT_SURFACE_REFRACTIVITY_N0,
  ITM_DEFAULT_RADIO_CLIMATE, ITM_DEFAULT_POLARIZATION, ITM_DEFAULT_VARIABILITY_MODE,
  ITM_DEFAULT_TIME_PERCENT, ITM_DEFAULT_LOCATION_PERCENT, ITM_DEFAULT_SITUATION_PERCENT,
} from './itm-model';
import { computeSiteSignalAtPoint, ResolvedSiteParams, SiteSignalAtPoint } from './site-signal';
import { getLandCoverClass, environmentFromWorldCoverClass, WorldCoverClass } from './landcover-provider';

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
  let environment = input.environment ?? 'urban';
  let cityType = input.cityType ?? 'medium';
  let environmentAutoDetected = false;
  let cityTypeAutoDetected = false;
  const usesEnvironment = propagationModel === 'hata';
  const usesCityType = propagationModel === 'cost231-hata' || propagationModel === 'walfisch-ikegami';
  if (input.autoDetectEnvironment && input.environment == null && input.cityType == null && (usesEnvironment || usesCityType)) {
    const worldCoverClass = await getLandCoverClass(input.siteLat, input.siteLon, logger);
    if (worldCoverClass != null) {
      const detected = environmentFromWorldCoverClass(worldCoverClass);
      environment = detected.environment;
      cityType = detected.cityType;
      environmentAutoDetected = true;
      cityTypeAutoDetected = true;
      assumptions.push({
        parameter: usesEnvironment ? 'environment' : 'cityType',
        assumedValue: usesEnvironment ? environment : cityType,
        reason: `Auto-detected from ESA WorldCover land cover at the site's location (classified as ${WorldCoverClass[worldCoverClass]}) — a coarse built-up-vs-not convention this tool applies (WorldCover doesn't distinguish clutter density beyond that), not a WorldCover- or 3GPP-specified mapping`,
        overridable: true,
      });
    } else {
      warnings.push({
        code: 'LAND_COVER_UNAVAILABLE',
        message: 'Auto-detect environment from land cover was requested, but no ESA WorldCover data was available for this location — fell back to the standard default instead.',
        severity: 'warning',
      });
    }
  }
  if (propagationModel === 'hata' && input.environment == null && !environmentAutoDetected) {
    assumptions.push({ parameter: 'environment', assumedValue: environment, reason: 'Not provided by caller', overridable: true });
  }
  if (propagationModel === 'cost231-hata' && input.cityType == null && !cityTypeAutoDetected) {
    assumptions.push({ parameter: 'cityType', assumedValue: cityType, reason: 'Not provided by caller', overridable: true });
  }
  const logDistanceEnvironment = input.logDistanceEnvironment ?? 'urban';
  if (propagationModel === 'log-distance') {
    if (input.logDistanceEnvironment == null) {
      assumptions.push({ parameter: 'logDistanceEnvironment', assumedValue: logDistanceEnvironment, reason: 'Not provided by caller', overridable: true });
    }
    if (!LOG_DISTANCE_ENVIRONMENT_PRESETS[logDistanceEnvironment].verified && input.pathLossExponent == null) {
      warnings.push({
        code: 'UNVERIFIED_PRESET_VALUE',
        message: `The "${logDistanceEnvironment}" log-distance preset (n=${LOG_DISTANCE_ENVIRONMENT_PRESETS[logDistanceEnvironment].pathLossExponent}) is unverified — no single citable reference was found for it. Provide an explicit pathLossExponent to use a value you trust.`,
        severity: 'warning',
      });
    }
  }
  const walfischIkegamiMode = input.walfischIkegamiMode ?? 'nlos';
  let buildingSeparationM = input.buildingSeparationM;
  let streetWidthM = input.streetWidthM;
  const streetOrientationDeg = input.streetOrientationDeg ?? WI_DEFAULT_STREET_ORIENTATION_DEG;
  if (propagationModel === 'walfisch-ikegami') {
    if (input.walfischIkegamiMode == null) {
      assumptions.push({ parameter: 'walfischIkegamiMode', assumedValue: walfischIkegamiMode, reason: 'Not provided by caller — defaulted to the more conservative NLOS case', overridable: true });
    }
    if (walfischIkegamiMode === 'nlos' && input.buildingHeightM == null) {
      return errResult({
        reason: "propagationModel 'walfisch-ikegami' in NLOS mode requires buildingHeightM (representative rooftop height) — no honest default exists for site-specific building geometry",
        missingInputs: ['buildingHeightM'],
      });
    }
    if (input.cityType == null && !cityTypeAutoDetected) {
      assumptions.push({ parameter: 'cityType', assumedValue: cityType, reason: 'Not provided by caller', overridable: true });
    }
    if (buildingSeparationM == null) {
      buildingSeparationM = WI_DEFAULT_BUILDING_SEPARATION_M;
      assumptions.push({
        parameter: 'buildingSeparationM', assumedValue: buildingSeparationM, unit: 'm',
        reason: "Not provided by caller — COST-231 only specifies a 20-50m range, not a single value; 35m is this tool's own midpoint convention, not a standard-specified default",
        overridable: true,
      });
    }
    if (streetWidthM == null) {
      streetWidthM = wiDefaultStreetWidthM(buildingSeparationM);
      assumptions.push({
        parameter: 'streetWidthM', assumedValue: streetWidthM, unit: 'm',
        reason: "Not provided by caller — defaulted to buildingSeparationM/2, the COST-231 standard's own recommended relationship",
        overridable: true,
      });
    }
    if (input.streetOrientationDeg == null) {
      assumptions.push({
        parameter: 'streetOrientationDeg', assumedValue: streetOrientationDeg, unit: 'deg',
        reason: "Not provided by caller — 90° is the COST-231 standard's own recommended default", overridable: true,
      });
    }
  }

  // ITM has no abstract-distance fallback — its entire algorithm is
  // terrain-profile-shaped (see itm-model.ts's header comment), unlike
  // every other model here. Reject up front rather than silently computing
  // a grid where every cell fell back to null (skippedOutOfModelRange would
  // equal every cell sampled, which is a confusing way to report this).
  if (propagationModel === 'itm' && !input.useTerrainData) {
    return errResult({
      reason: "propagationModel 'itm' requires useTerrainData:true — ITM's entire algorithm operates on a real terrain profile between the site and each point, not an abstract distance",
      missingInputs: ['useTerrainData'],
    });
  }
  const groundConductivity = input.groundConductivity ?? ITM_DEFAULT_GROUND_CONDUCTIVITY_S_PER_M;
  const groundPermittivity = input.groundPermittivity ?? ITM_DEFAULT_GROUND_PERMITTIVITY;
  const surfaceRefractivityN0 = input.surfaceRefractivityN0 ?? ITM_DEFAULT_SURFACE_REFRACTIVITY_N0;
  const radioClimate = input.radioClimate ?? ITM_DEFAULT_RADIO_CLIMATE;
  const polarization = input.polarization ?? ITM_DEFAULT_POLARIZATION;
  const modeOfVariability = input.modeOfVariability ?? ITM_DEFAULT_VARIABILITY_MODE;
  const timePercent = input.timePercent ?? ITM_DEFAULT_TIME_PERCENT;
  const locationPercent = input.locationPercent ?? ITM_DEFAULT_LOCATION_PERCENT;
  const situationPercent = input.situationPercent ?? ITM_DEFAULT_SITUATION_PERCENT;
  if (propagationModel === 'itm') {
    const itmDefaults: [unknown, string, number | string, string][] = [
      [input.groundConductivity, 'groundConductivity', groundConductivity, 'S/m'],
      [input.groundPermittivity, 'groundPermittivity', groundPermittivity, 'dimensionless'],
      [input.surfaceRefractivityN0, 'surfaceRefractivityN0', surfaceRefractivityN0, 'N-units'],
      [input.radioClimate, 'radioClimate', radioClimate, ''],
      [input.polarization, 'polarization', polarization, ''],
      [input.modeOfVariability, 'modeOfVariability', modeOfVariability, ''],
      [input.timePercent, 'timePercent', timePercent, '%'],
      [input.locationPercent, 'locationPercent', locationPercent, '%'],
      [input.situationPercent, 'situationPercent', situationPercent, '%'],
    ];
    for (const [provided, parameter, assumedValue, unit] of itmDefaults) {
      if (provided == null) {
        assumptions.push({
          parameter, assumedValue, ...(unit ? { unit } : {}),
          reason: "Not provided by caller — standard \"average ground\"/\"average atmosphere\" reference value (cross-checked against two independent technical sources, not a COST-231-style tool-invented default)",
          overridable: true,
        });
      }
    }
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
  } else if (propagationModel === 'walfisch-ikegami') {
    const [fMin, fMax] = WI_FREQ_RANGE_MHZ, [tMin, tMax] = WI_BASE_HEIGHT_RANGE_M, [rMin, rMax] = WI_MOBILE_HEIGHT_RANGE_M;
    const problems: string[] = [];
    if (frequencyMhz < fMin || frequencyMhz > fMax) problems.push(`frequencyMhz ${frequencyMhz} outside Walfisch-Ikegami's valid range [${fMin}, ${fMax}] MHz`);
    if (input.siteHeightM < tMin || input.siteHeightM > tMax) problems.push(`siteHeightM ${input.siteHeightM} outside Walfisch-Ikegami's valid range [${tMin}, ${tMax}] m`);
    if (receiverHeightM < rMin || receiverHeightM > rMax) problems.push(`receiverHeightM ${receiverHeightM} outside Walfisch-Ikegami's valid range [${rMin}, ${rMax}] m`);
    if (problems.length > 0) return errResult({ reason: `Walfisch-Ikegami model: ${problems.join('; ')}`, missingInputs: [] });
  } else if (propagationModel === 'itm') {
    const [fMin, fMax] = ITM_FREQ_RANGE_MHZ, [hMin, hMax] = ITM_HEIGHT_RANGE_M, [n0Min, n0Max] = ITM_REFRACTIVITY_RANGE_N0, [pMin, pMax] = ITM_VARIABILITY_PERCENT_RANGE;
    const problems: string[] = [];
    if (frequencyMhz < fMin || frequencyMhz > fMax) problems.push(`frequencyMhz ${frequencyMhz} outside ITM's valid range [${fMin}, ${fMax}] MHz`);
    if (input.siteHeightM < hMin || input.siteHeightM > hMax) problems.push(`siteHeightM ${input.siteHeightM} outside ITM's valid range [${hMin}, ${hMax}] m`);
    if (receiverHeightM < hMin || receiverHeightM > hMax) problems.push(`receiverHeightM ${receiverHeightM} outside ITM's valid range [${hMin}, ${hMax}] m`);
    if (surfaceRefractivityN0 < n0Min || surfaceRefractivityN0 > n0Max) problems.push(`surfaceRefractivityN0 ${surfaceRefractivityN0} outside ITM's valid range [${n0Min}, ${n0Max}] N-units`);
    if (groundPermittivity < 1) problems.push(`groundPermittivity ${groundPermittivity} must be >= 1`);
    if (groundConductivity <= 0) problems.push(`groundConductivity ${groundConductivity} must be > 0 S/m`);
    if (timePercent <= pMin || timePercent >= pMax) problems.push(`timePercent ${timePercent} outside ITM's valid range (${pMin}, ${pMax})%`);
    if (locationPercent <= pMin || locationPercent >= pMax) problems.push(`locationPercent ${locationPercent} outside ITM's valid range (${pMin}, ${pMax})%`);
    if (situationPercent <= pMin || situationPercent >= pMax) problems.push(`situationPercent ${situationPercent} outside ITM's valid range (${pMin}, ${pMax})%`);
    if (problems.length > 0) return errResult({ reason: `ITM model: ${problems.join('; ')}`, missingInputs: [] });
  }

  const siteParams: ResolvedSiteParams = {
    siteLat: input.siteLat, siteLon: input.siteLon, siteHeightM: input.siteHeightM,
    azimuthDeg: input.azimuthDeg, horizontalBeamwidthDeg: input.horizontalBeamwidthDeg, verticalBeamwidthDeg,
    totalDowntiltDeg: mechanicalDowntiltDeg + electricalDowntiltDeg, frontToBackDb,
    txPowerDbm: input.txPowerDbm, cableLossDb: input.cableLossDb, connectorLossDb: input.connectorLossDb, filterLossDb,
    antennaGainDbi: input.antennaGainDbi, frequencyMhz, frequencyHz,
    buildingLossDb, foliageLossDb, miscLossDb, ueAntennaGainDbi, receiverHeightM,
    propagationModel, environment, cityType, logDistanceEnvironment,
    useTerrainData: !!input.useTerrainData, terrainSampleCount: input.terrainSampleCount ?? DEFAULT_TERRAIN_SAMPLE_COUNT,
    pathLossExponent: input.pathLossExponent, isLineOfSight: input.isLineOfSight,
    earthCurvatureKFactor: input.earthCurvatureKFactor, fresnelClearanceThresholdPercent: input.fresnelClearanceThresholdPercent,
    walfischIkegamiMode, buildingHeightM: input.buildingHeightM, streetWidthM, buildingSeparationM, streetOrientationDeg,
    groundConductivity, groundPermittivity, surfaceRefractivityN0, radioClimate, polarization,
    modeOfVariability, timePercent, locationPercent, situationPercent,
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
  const itmModelWarnings = new Set<string>();

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
      if (signal.modelWarnings) for (const w of signal.modelWarnings) itmModelWarnings.add(w);

      const insideTargetPolygon = hasPolygon
        ? pointInPolygon({ lat: cellLat, lon: cellLon }, input.targetPolygon as LatLon[])
        : undefined;

      const cell: CoverageGridCell = {
        lat: cellLat, lon: cellLon, row, col, distanceM: signal.distanceM, totalReceivedPowerDbm: signal.totalReceivedPowerDbm,
        losClassification: signal.losClassification, fresnelClearancePercent: signal.fresnelClearancePercent,
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
    return errResult({ reason: 'No valid grid cells were computed — check radiusM, resolution, and (if using Hata/COST-231-Hata/Walfisch-Ikegami) that the radius stays within the model\'s valid distance range, or (if using ITM) that terrain elevation data is actually resolvable for this location', missingInputs: [] });
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
        : propagationModel === 'log-distance'
          ? `Log-Distance model uses the "${logDistanceEnvironment}" environment preset's path-loss exponent — a general starting point, not a site-specific fit for your exact deployment.`
          : propagationModel === 'walfisch-ikegami'
            ? `Walfisch-Ikegami model (${walfischIkegamiMode.toUpperCase()}) — mean error ±3dB (σ 4-8dB) for base stations above rooftop level; error grows large as base station height approaches or falls below rooftop height, and the model is not physically meaningful for micro-cells.`
            : propagationModel === 'itm'
              ? `NTIA Irregular Terrain Model (Longley-Rice), point-to-point mode, ${radioClimate} climate — a real statistical terrain model (not a fixed clutter-class average like Hata/WI), but still does not model building interiors or channel/waveform behavior.`
              : `${propagationModel === 'hata' ? 'Hata' : 'COST-231-Hata'} empirical model — average clutter loss for the ${propagationModel === 'hata' ? environment : cityType} environment class, not necessarily this exact deployment's real clutter.`,
    severity: 'warning',
  });
  warnings.push({
    code: 'SIMPLIFIED_PATTERN',
    message: 'Directional gain uses a simplified 2D-separable 3GPP sector pattern (horizontal × vertical treated independently), not a measured 3D radiation pattern for a specific antenna model.',
    severity: 'warning',
  });
  if (skippedOutOfModelRange > 0) {
    const modelLabel = propagationModel === 'hata' ? 'Hata' : propagationModel === 'cost231-hata' ? 'COST-231-Hata' : propagationModel === 'walfisch-ikegami' ? 'Walfisch-Ikegami' : propagationModel === 'itm' ? 'ITM' : 'the selected';
    warnings.push({
      code: 'CELLS_SKIPPED_OUT_OF_MODEL_RANGE',
      message: `${skippedOutOfModelRange} grid cell(s) were skipped because they fell outside the ${modelLabel} model's valid range (or, for ITM, had no resolvable terrain profile) — reduce radiusM or switch to the FSPL model to cover those points.`,
      severity: 'warning',
    });
  }
  if (input.useTerrainData) {
    if (terrainAppliedCount > 0) {
      warnings.push({
        code: 'TERRAIN_DIFFRACTION_APPLIED',
        message: propagationModel === 'itm'
          ? `Real terrain profiles were resolved and passed directly into the ITM model for ${terrainAppliedCount} cell(s) — ITM computes diffraction/troposcatter loss internally from this same profile, so the separate ITU-R P.526 Deygout figure is diagnostic only (see each cell's losClassification/fresnelClearancePercent) and is not added on top${terrainUnavailableCount > 0 ? `; ${terrainUnavailableCount} cell(s) had no resolvable terrain profile and were skipped` : ''}.`
          : `Terrain-based diffraction loss (ITU-R P.526 Deygout method) was evaluated on top of the base propagation model for ${terrainAppliedCount} cell(s)${terrainUnavailableCount > 0 ? `; ${terrainUnavailableCount} cell(s) fell back to no terrain adjustment (elevation data unavailable for part of that path)` : ''}.`,
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
  if (itmModelWarnings.size > 0) {
    warnings.push({
      code: 'ITM_MODEL_WARNING',
      message: `ITM raised the following near-limit warning(s) on at least one cell: ${[...itmModelWarnings].join('; ')}.`,
      severity: 'warning',
    });
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
  } else if (propagationModel === 'log-distance') {
    const n = input.pathLossExponent ?? LOG_DISTANCE_ENVIRONMENT_PRESETS[logDistanceEnvironment].pathLossExponent;
    pathLossEquation = logDistanceEquation(bestCell.distanceM, frequencyHz, n, logDistanceEnvironment, bestCell.basePathLossDb);
  } else if (propagationModel === 'walfisch-ikegami') {
    const distanceKm = bestCell.distanceM / 1000;
    const r = walfischIkegamiPathLossDb(
      frequencyMhz, input.siteHeightM, receiverHeightM, distanceKm, walfischIkegamiMode,
      input.buildingHeightM ?? 0, streetWidthM as number, buildingSeparationM as number, streetOrientationDeg, cityType,
    );
    // bestCell was only ever selected from cells that already passed this
    // exact model/range check, so this is always ok:true here.
    pathLossEquation = r.ok ? r.equation : fsplEquation(bestCell.distanceM, frequencyHz, bestCell.basePathLossDb);
  } else if (propagationModel === 'itm') {
    // bestCell.equation was threaded all the way back from the actual WASM
    // call made for this exact cell (see BasePathLossResult's comment) —
    // recomputing it here would mean a second, redundant WASM invocation
    // AND would need the cell's full terrain profile, which isn't retained.
    pathLossEquation = bestCell.equation ?? fsplEquation(bestCell.distanceM, frequencyHz, bestCell.basePathLossDb);
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
      model: `Directional ${propagationModel === 'fspl' ? 'Free-Space' : propagationModel === 'hata' ? 'Hata' : propagationModel === 'cost231-hata' ? 'COST-231-Hata' : propagationModel === 'log-distance' ? 'Log-Distance' : propagationModel === 'walfisch-ikegami' ? 'Walfisch-Ikegami' : propagationModel === 'itm' ? 'ITM (Longley-Rice)' : 'Close-In'} Coverage Grid${input.useTerrainData ? ' (terrain-aware)' : ''}`,
    },
  );
}
