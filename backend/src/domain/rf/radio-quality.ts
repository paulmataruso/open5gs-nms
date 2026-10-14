import type { EquationRecord } from './rf-types';

// Planning-grade RSRP / SINR / RSRQ / RSSI reconstruction.
//
// Our interference grid already produced SINR (serving minus the summed
// interferers and noise). These are the other three metrics an operator
// actually reads off a handset or a drive test, reconstructed on a consistent
// resource-element basis so they can be compared with real measurements.
//
// All of it is defined per resource element and then scaled by the number of
// occupied subcarriers (12 per resource block), which is what makes RSRQ and
// RSSI mean anything:
//
//   SINR = 10·log10( P_desired / (P_noise + P_interference) )
//   RSSI = 12·N_RB · (P_desired + P_interference + P_noise)
//   RSRQ = 10·log10( N_RB · P_desired / RSSI )
//
// IMPORTANT — the resource-block count depends on SUBCARRIER SPACING, and
// getting this wrong silently corrupts both RSRQ and RSSI. A reference
// implementation we studied hardcoded 120 kHz SCS (an FR2/mmWave numerology)
// for all NR, which for this deployment's CBRS n48 band is simply the wrong
// radio: n48 is FR1 and runs 15 or 30 kHz SCS. At 100 MHz that is the
// difference between 66 RB (120 kHz) and 273 RB (30 kHz) — a ~6 dB error in
// the RSSI term. So SCS is an explicit input here, not an assumption.
//
// Sources: 3GPP TS 36.101 Table 5.6-1 (E-UTRA channel bandwidth / N_RB),
// TS 38.101-1 Table 5.3.2-1 (NR FR1 transmission bandwidth configuration),
// TS 38.101-2 Table 5.3.2-1 (NR FR2). RSRP/RSRQ/RSSI definitions:
// TS 36.214 §5.1.1/5.1.3 and TS 38.215 §5.1.1/5.1.3.
//
// These are PLANNING estimates from a deterministic propagation model, not
// UE measurements: no scheduling, no beam management, no measurement
// averaging or layer-3 filtering is modelled.

export const SUBCARRIERS_PER_RESOURCE_BLOCK = 12;

/** Rounded 290 K thermal noise density convention, dBm/Hz. */
export const THERMAL_NOISE_DENSITY_DBM_PER_HZ = -174.0;
export const REFERENCE_TEMPERATURE_K = 290.0;

export type RadioTechnology = '4g' | '5g';
/** Subcarrier spacing, kHz. 15/30/60 are FR1; 120 is FR2 (mmWave). */
export type SubcarrierSpacingKhz = 15 | 30 | 60 | 120;

/**
 * Sorted, human-readable bandwidth list for error messages.
 *
 * Object.keys() on a numeric-keyed map does NOT preserve insertion order:
 * integer-like keys are enumerated in ascending numeric order first, then
 * string keys. So {1.4:..., 3:..., 20:...} enumerates as
 * ["3","5","10","15","20","1.4"], putting 1.4 last and making the message read
 * as if the list were unordered. Sort numerically instead.
 */
function bandwidthList(table: Record<number, number>): string {
  return Object.keys(table).map(Number).sort((a, b) => a - b).join(', ');
}

/** LTE: TS 36.101 Table 5.6-1. SCS is always 15 kHz. */
const LTE_RESOURCE_BLOCKS: Record<number, number> = {
  1.4: 6, 3: 15, 5: 25, 10: 50, 15: 75, 20: 100,
};

/**
 * NR transmission bandwidth configuration, N_RB by (SCS kHz, channel MHz).
 * FR1 (15/30/60 kHz) from TS 38.101-1; FR2 (120 kHz) from TS 38.101-2.
 */
const NR_RESOURCE_BLOCKS: Record<SubcarrierSpacingKhz, Record<number, number>> = {
  15: { 5: 25, 10: 52, 15: 79, 20: 106, 25: 133, 30: 160, 40: 216, 50: 270 },
  30: { 5: 11, 10: 24, 15: 38, 20: 51, 25: 65, 30: 78, 40: 106, 50: 133, 60: 162, 70: 189, 80: 217, 90: 245, 100: 273 },
  60: { 10: 11, 15: 18, 20: 24, 25: 31, 30: 38, 40: 51, 50: 65, 60: 79, 70: 93, 80: 107, 90: 121, 100: 135 },
  120: { 50: 32, 100: 66, 200: 132, 400: 264 },
};

/** Default SCS per technology. 30 kHz is the realistic FR1/CBRS n48 choice. */
export function defaultSubcarrierSpacingKhz(tech: RadioTechnology): SubcarrierSpacingKhz {
  return tech === '4g' ? 15 : 30;
}

export interface ResourceGrid {
  resourceBlocks: number;
  subcarrierSpacingKhz: SubcarrierSpacingKhz;
  occupiedSubcarriers: number;
  /** Which measurement family the RSRP refers to. */
  measurementFamily: 'lte_crs' | 'nr_ss';
  bandwidthMhz: number;
}

export function resolveResourceGrid(
  tech: RadioTechnology,
  bandwidthMhz: number,
  subcarrierSpacingKhz: SubcarrierSpacingKhz = defaultSubcarrierSpacingKhz(tech),
): ResourceGrid {
  if (tech === '4g') {
    const blocks = LTE_RESOURCE_BLOCKS[bandwidthMhz];
    if (blocks === undefined) {
      throw new Error(
        `LTE channel bandwidth ${bandwidthMhz} MHz is not one of ${bandwidthList(LTE_RESOURCE_BLOCKS)} MHz`,
      );
    }
    return {
      resourceBlocks: blocks,
      subcarrierSpacingKhz: 15,
      occupiedSubcarriers: blocks * SUBCARRIERS_PER_RESOURCE_BLOCK,
      measurementFamily: 'lte_crs',
      bandwidthMhz,
    };
  }
  const table = NR_RESOURCE_BLOCKS[subcarrierSpacingKhz];
  if (!table) throw new Error(`unsupported NR subcarrier spacing ${subcarrierSpacingKhz} kHz`);
  const blocks = table[bandwidthMhz];
  if (blocks === undefined) {
    throw new Error(
      `NR channel bandwidth ${bandwidthMhz} MHz is not valid at ${subcarrierSpacingKhz} kHz SCS ` +
      `(valid: ${bandwidthList(table)} MHz)`,
    );
  }
  return {
    resourceBlocks: blocks,
    subcarrierSpacingKhz,
    occupiedSubcarriers: blocks * SUBCARRIERS_PER_RESOURCE_BLOCK,
    measurementFamily: 'nr_ss',
    bandwidthMhz,
  };
}

export function dbmToMilliwatts(dbm: number): number {
  return 10 ** (dbm / 10);
}

export function milliwattsToDbm(milliwatts: number): number {
  return 10 * Math.log10(milliwatts);
}

/** Sum powers given in dBm, in the linear domain. */
export function sumDbm(...values: number[]): number {
  const total = values.reduce((acc, v) => acc + dbmToMilliwatts(v), 0);
  return total > 0 ? milliwattsToDbm(total) : -Infinity;
}

/** Thermal noise over a bandwidth, with an additive receiver noise figure. */
export function thermalNoiseDbm(bandwidthHz: number, noiseFigureDb = 0, temperatureK = REFERENCE_TEMPERATURE_K): number {
  if (!(bandwidthHz > 0) || !(temperatureK > 0)) return NaN;
  return (
    THERMAL_NOISE_DENSITY_DBM_PER_HZ +
    10 * Math.log10(temperatureK / REFERENCE_TEMPERATURE_K) +
    10 * Math.log10(bandwidthHz) +
    noiseFigureDb
  );
}

/** Per-resource-element noise: the noise in ONE subcarrier's bandwidth. */
export function thermalNoisePerResourceElementDbm(
  subcarrierSpacingKhz: number,
  noiseFigureDb: number,
): number {
  return thermalNoiseDbm(subcarrierSpacingKhz * 1000, noiseFigureDb);
}

export interface RadioQualityInput {
  /** Serving-cell received power per resource element, dBm (this is RSRP). */
  rsrpDbm: number;
  /** Each interferer's per-resource-element received power, dBm. */
  interfererRsrpDbm: number[];
  grid: ResourceGrid;
  /** Receiver noise figure, dB. */
  noiseFigureDb: number;
  /**
   * Per-interferer load factor (0-1), aligned with interfererRsrpDbm. An
   * unloaded neighbour contributes proportionally less interference. Missing
   * entries default to 1 (fully loaded), which is the conservative choice.
   */
  loadFactors?: number[];
}

export interface RadioQualityResult {
  rsrpDbm: number;
  sinrDb: number;
  rsrqDb: number;
  rssiDbm: number;
  noisePerReDbm: number;
  interferencePerReDbm: number | null;
  resourceBlocks: number;
  subcarrierSpacingKhz: number;
  measurementFamily: string;
}

export function computeRadioQuality(input: RadioQualityInput): RadioQualityResult {
  const { rsrpDbm, interfererRsrpDbm, grid, noiseFigureDb } = input;
  const noisePerReDbm = thermalNoisePerResourceElementDbm(grid.subcarrierSpacingKhz, noiseFigureDb);

  const desiredMw = dbmToMilliwatts(rsrpDbm);
  const noiseMw = dbmToMilliwatts(noisePerReDbm);
  let interferenceMw = 0;
  interfererRsrpDbm.forEach((dbm, index) => {
    if (!Number.isFinite(dbm)) return;
    // Load factor scales an interferer's *power* contribution: a cell
    // transmitting on 30% of its resources interferes ~30% as much on average.
    const load = input.loadFactors?.[index];
    const factor = Number.isFinite(load) ? Math.min(Math.max(load as number, 0), 1) : 1;
    interferenceMw += dbmToMilliwatts(dbm) * factor;
  });

  const sinrDb = 10 * Math.log10(desiredMw / (noiseMw + interferenceMw));
  const rssiMw = grid.occupiedSubcarriers * (desiredMw + interferenceMw + noiseMw);
  const rssiDbm = milliwattsToDbm(rssiMw);
  const rsrqDb = 10 * Math.log10((grid.resourceBlocks * desiredMw) / rssiMw);

  return {
    rsrpDbm,
    sinrDb,
    rsrqDb,
    rssiDbm,
    noisePerReDbm,
    interferencePerReDbm: interferenceMw > 0 ? milliwattsToDbm(interferenceMw) : null,
    resourceBlocks: grid.resourceBlocks,
    subcarrierSpacingKhz: grid.subcarrierSpacingKhz,
    measurementFamily: grid.measurementFamily,
  };
}

/**
 * Planning service thresholds. These are OUR policy choices for what counts as
 * usable, not 3GPP conformance limits and not UE behaviour.
 */
export const RSRP_SERVICE_THRESHOLD_DBM = -110;
export const SINR_SERVICE_THRESHOLD_DB = 0;
export const RSRQ_SERVICE_THRESHOLD_DB = -20;

export type QualityClass = 'good' | 'fair' | 'poor' | 'unusable';

export function classifyRadioQuality(result: RadioQualityResult): QualityClass {
  const { rsrpDbm, sinrDb, rsrqDb } = result;
  if (rsrpDbm < RSRP_SERVICE_THRESHOLD_DBM) return 'unusable';
  if (sinrDb < SINR_SERVICE_THRESHOLD_DB || rsrqDb < RSRQ_SERVICE_THRESHOLD_DB) return 'poor';
  if (rsrpDbm >= -85 && sinrDb >= 13) return 'good';
  return 'fair';
}

/**
 * True when coverage is adequate but quality is not — i.e. the problem is
 * other cells, not range. This distinction is what makes an interference map
 * actionable instead of just another coverage map.
 */
export function isInterferenceLimited(result: RadioQualityResult): boolean {
  return (
    result.rsrpDbm >= RSRP_SERVICE_THRESHOLD_DBM &&
    (result.sinrDb < SINR_SERVICE_THRESHOLD_DB || result.rsrqDb < RSRQ_SERVICE_THRESHOLD_DB)
  );
}

export function radioQualityEquation(result: RadioQualityResult): EquationRecord {
  return {
    name: 'Planning RSRP / SINR / RSRQ / RSSI',
    formula:
      'SINR = 10·log10(P_rsrp / (P_noise + P_interf)); RSSI = 12·N_RB·(P_rsrp + P_interf + P_noise); RSRQ = 10·log10(N_RB·P_rsrp / RSSI)',
    variables: {
      RSRP: { description: 'serving reference-signal received power', unit: 'dBm', value: Number(result.rsrpDbm.toFixed(2)) },
      SINR: { description: 'signal to interference plus noise ratio', unit: 'dB', value: Number(result.sinrDb.toFixed(2)) },
      RSRQ: { description: 'reference signal received quality', unit: 'dB', value: Number(result.rsrqDb.toFixed(2)) },
      RSSI: { description: 'received signal strength over occupied subcarriers', unit: 'dBm', value: Number(result.rssiDbm.toFixed(2)) },
      N_RB: { description: 'resource blocks in the channel', unit: 'blocks', value: result.resourceBlocks },
      SCS: { description: 'subcarrier spacing', unit: 'kHz', value: result.subcarrierSpacingKhz },
      N_noise: { description: 'thermal noise per resource element', unit: 'dBm', value: Number(result.noisePerReDbm.toFixed(2)) },
    },
    source: 'TS 36.214 §5.1.1/5.1.3, TS 38.215 §5.1.1/5.1.3; N_RB from TS 36.101 Table 5.6-1 / TS 38.101-1 Table 5.3.2-1',
    applicableConditions: `${result.measurementFamily === 'lte_crs' ? 'LTE CRS' : 'NR SS'} reference signals at ${result.subcarrierSpacingKhz} kHz SCS, ${result.resourceBlocks} RB`,
    limitations:
      'Planning estimate from a deterministic propagation model. No scheduling, beam management, measurement averaging or layer-3 filtering is modelled, so values are not directly comparable to a single instantaneous UE report.',
  };
}
