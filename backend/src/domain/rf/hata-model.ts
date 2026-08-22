// Hata and COST-231-Hata empirical path-loss models — alternatives to FSPL
// for cluttered/urban conditions, where average clutter loss matters more
// than pure geometric spreading. Each is validated against its own
// documented range and returns a structured CalculationError (never
// silent extrapolation) outside it, same pattern lte-bands.ts already
// uses for out-of-range EARFCN.
//
// Formulas verified directly against source text (Wikipedia's "Hata
// model" article, cross-checked against HandWiki's mirror and RF Wireless
// World's COST-231 page) rather than recalled from memory and shipped as
// fact, per this project's standing rule against unverified numeric
// claims. The COST-231 a(hm) term reuses the Hata model's own well-
// established "small/medium city" mobile-height correction — flagged
// explicitly in its EquationRecord.source rather than presented as an
// independently-derived COST-231 constant.

import { CalculationError, EquationRecord, HataEnvironment, Cost231CityType } from './rf-types';

export const HATA_FREQ_RANGE_MHZ: [number, number] = [150, 1500];
export const HATA_TX_HEIGHT_RANGE_M: [number, number] = [30, 200];
export const HATA_RX_HEIGHT_RANGE_M: [number, number] = [1, 10];
export const HATA_DISTANCE_RANGE_KM: [number, number] = [1, 10];

export const COST231_FREQ_RANGE_MHZ: [number, number] = [1500, 2000];
export const COST231_DISTANCE_RANGE_KM: [number, number] = [1, 20];

type ModelResult =
  | { ok: true; pathLossDb: number; equation: EquationRecord }
  | { ok: false; error: CalculationError };

function rangeCheck(value: number, range: [number, number], label: string, unit: string, problems: string[]): void {
  if (value < range[0] || value > range[1]) {
    problems.push(`${label} ${value}${unit} is outside the model's valid range [${range[0]}, ${range[1]}]${unit}`);
  }
}

function hataMobileHeightCorrectionDb(freqMhz: number, rxHeightM: number): number {
  if (freqMhz <= 200) {
    return 8.29 * Math.log10(1.54 * rxHeightM) ** 2 - 1.1;
  }
  return 3.2 * Math.log10(11.75 * rxHeightM) ** 2 - 4.97;
}

export function hataPathLossDb(
  freqMhz: number, txHeightM: number, rxHeightM: number, distanceKm: number, environment: HataEnvironment,
): ModelResult {
  const problems: string[] = [];
  rangeCheck(freqMhz, HATA_FREQ_RANGE_MHZ, 'frequencyMhz', 'MHz', problems);
  rangeCheck(txHeightM, HATA_TX_HEIGHT_RANGE_M, 'txHeightM', 'm', problems);
  rangeCheck(rxHeightM, HATA_RX_HEIGHT_RANGE_M, 'rxHeightM', 'm', problems);
  rangeCheck(distanceKm, HATA_DISTANCE_RANGE_KM, 'distanceKm', 'km', problems);
  if (problems.length > 0) {
    return { ok: false, error: { reason: `Hata model: ${problems.join('; ')}`, missingInputs: [] } };
  }

  const CH = hataMobileHeightCorrectionDb(freqMhz, rxHeightM);
  const urbanDb = 69.55 + 26.16 * Math.log10(freqMhz) - 13.82 * Math.log10(txHeightM) - CH
    + (44.9 - 6.55 * Math.log10(txHeightM)) * Math.log10(distanceKm);

  let pathLossDb = urbanDb;
  if (environment === 'suburban') {
    pathLossDb = urbanDb - 2 * Math.log10(freqMhz / 28) ** 2 - 5.4;
  } else if (environment === 'open') {
    pathLossDb = urbanDb - 4.78 * Math.log10(freqMhz) ** 2 + 18.33 * Math.log10(freqMhz) - 40.94;
  }

  return {
    ok: true,
    pathLossDb,
    equation: {
      name: `Hata Model (${environment})`,
      formula: environment === 'urban'
        ? 'L = 69.55 + 26.16·log10(f) − 13.82·log10(hb) − a(hm) + (44.9 − 6.55·log10(hb))·log10(d)'
        : environment === 'suburban'
          ? 'L = L(urban) − 2·[log10(f/28)]² − 5.4'
          : 'L = L(urban) − 4.78·[log10(f)]² + 18.33·log10(f) − 40.94',
      variables: {
        f:  { description: 'Frequency', unit: 'MHz', value: freqMhz },
        hb: { description: 'Base station (TX) height', unit: 'm', value: txHeightM },
        hm: { description: 'Mobile (RX) height', unit: 'm', value: rxHeightM },
        d:  { description: 'Distance', unit: 'km', value: distanceKm },
        L:  { description: 'Path loss', unit: 'dB', value: pathLossDb },
      },
      source: 'Hata, M. (1980), "Empirical Formula for Propagation Loss in Land Mobile Radio Services," IEEE Trans. Vehicular Technology 29(3)',
      applicableConditions: `Valid for f∈[150,1500]MHz, hb∈[30,200]m, hm∈[1,10]m, d∈[1,10]km, ${environment} environment`,
      limitations: 'Empirical/statistical model — average clutter loss for the environment class, not this specific path\'s real obstructions (combine with terrain diffraction for path-specific accuracy)',
    },
  };
}

export function cost231HataPathLossDb(
  freqMhz: number, txHeightM: number, rxHeightM: number, distanceKm: number, cityType: Cost231CityType,
): ModelResult {
  const problems: string[] = [];
  rangeCheck(freqMhz, COST231_FREQ_RANGE_MHZ, 'frequencyMhz', 'MHz', problems);
  rangeCheck(txHeightM, HATA_TX_HEIGHT_RANGE_M, 'txHeightM', 'm', problems);
  rangeCheck(rxHeightM, HATA_RX_HEIGHT_RANGE_M, 'rxHeightM', 'm', problems);
  rangeCheck(distanceKm, COST231_DISTANCE_RANGE_KM, 'distanceKm', 'km', problems);
  if (problems.length > 0) {
    return { ok: false, error: { reason: `COST-231-Hata model: ${problems.join('; ')}`, missingInputs: [] } };
  }

  const aHm = (1.1 * Math.log10(freqMhz) - 0.7) * rxHeightM - (1.56 * Math.log10(freqMhz) - 0.8);
  const Cm = cityType === 'metropolitan' ? 3 : 0;
  const pathLossDb = 46.3 + 33.9 * Math.log10(freqMhz) - 13.82 * Math.log10(txHeightM) - aHm
    + (44.9 - 6.55 * Math.log10(txHeightM)) * Math.log10(distanceKm) + Cm;

  return {
    ok: true,
    pathLossDb,
    equation: {
      name: `COST-231-Hata Model (${cityType})`,
      formula: 'L = 46.3 + 33.9·log10(f) − 13.82·log10(hb) − a(hm) + (44.9 − 6.55·log10(hb))·log10(d) + Cm',
      variables: {
        f:  { description: 'Frequency', unit: 'MHz', value: freqMhz },
        hb: { description: 'Base station (TX) height', unit: 'm', value: txHeightM },
        hm: { description: 'Mobile (RX) height', unit: 'm', value: rxHeightM },
        d:  { description: 'Distance', unit: 'km', value: distanceKm },
        aHm: { description: 'Mobile height correction (Hata\'s small/medium-city form, reused by COST-231)', unit: 'dB', value: aHm },
        Cm: { description: 'City-type constant (0 medium/suburban, 3 metropolitan)', unit: 'dB', value: Cm },
        L:  { description: 'Path loss', unit: 'dB', value: pathLossDb },
      },
      source: 'COST 231 (EURO-COST), extension of Hata, M. (1980) to 1500-2000 MHz; a(hm) term is Hata\'s own small/medium-city mobile-height correction, reused rather than independently re-derived',
      applicableConditions: `Valid for f∈[1500,2000]MHz, hb∈[30,200]m, hm∈[1,10]m, d∈[1,20]km, ${cityType} city type`,
      limitations: 'Empirical/statistical model — average clutter loss for the environment class, not this specific path\'s real obstructions (combine with terrain diffraction for path-specific accuracy)',
    },
  };
}
