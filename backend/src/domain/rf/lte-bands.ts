// General 3GPP TS 36.101 Table 5.7.3-1 EARFCN<->frequency relationship,
// seeded only with the bands already confirmed live elsewhere in this repo
// (frontend/src/components/autoconfig/BaicellsAcsTab.tsx lines 212-292, and
// a 4th private duplicate in backend/src/domain/sas/sas-service.ts).
// Deliberately does NOT ship additional bands (1, 2, 3, 4, 5, 7, ...) from
// memory — those must be transcribed directly from the real 3GPP spec text
// before being added as data, not guessed, per this project's own
// non-negotiable "no unverified numeric claims" rule.

import { CalculationError, EquationRecord } from './rf-types';

export interface LteBandDefinition {
  band: number;
  duplex: 'FDD' | 'TDD';
  dlFreqLowMhz: number;
  dlEarfcnOffset: number;
  dlEarfcnMin: number;
  dlEarfcnMax: number;
}

// Confirmed live against real hardware this project manages (see
// BaicellsAcsTab.tsx's BAND42/43/48_EARFCN_OPTIONS).
export const LTE_BANDS: LteBandDefinition[] = [
  { band: 42, duplex: 'TDD', dlFreqLowMhz: 3400, dlEarfcnOffset: 41590, dlEarfcnMin: 41590, dlEarfcnMax: 43589 },
  { band: 43, duplex: 'TDD', dlFreqLowMhz: 3600, dlEarfcnOffset: 43590, dlEarfcnMin: 43590, dlEarfcnMax: 45589 },
  { band: 48, duplex: 'TDD', dlFreqLowMhz: 3550, dlEarfcnOffset: 55240, dlEarfcnMin: 55240, dlEarfcnMax: 56739 },
];

export function getBandDefinition(band: number): LteBandDefinition | undefined {
  return LTE_BANDS.find(b => b.band === band);
}

type BandResult<K extends string, V> =
  | ({ ok: true; equation: EquationRecord } & Record<K, V>)
  | { ok: false; error: CalculationError };

export function earfcnToFrequencyMhz(band: number, earfcn: number): BandResult<'frequencyMhz', number> {
  const def = getBandDefinition(band);
  if (!def) {
    return { ok: false, error: { reason: `Band ${band} is not in this engine's verified band table`, missingInputs: [], availableInputs: { band } } };
  }
  if (earfcn < def.dlEarfcnMin || earfcn > def.dlEarfcnMax) {
    return {
      ok: false,
      error: {
        reason: `EARFCN ${earfcn} is outside Band ${band}'s valid downlink range [${def.dlEarfcnMin}, ${def.dlEarfcnMax}]`,
        missingInputs: [],
        availableInputs: { band, earfcn },
      },
    };
  }
  const frequencyMhz = def.dlFreqLowMhz + 0.1 * (earfcn - def.dlEarfcnOffset);
  return {
    ok: true,
    frequencyMhz,
    equation: {
      name: 'LTE EARFCN to Frequency (Downlink)',
      formula: 'F_DL(MHz) = F_DL_low + 0.1 × (N_DL − N_Offs-DL)',
      variables: {
        F_DL_low:  { description: 'Band downlink low-edge frequency', unit: 'MHz', value: def.dlFreqLowMhz },
        N_DL:      { description: 'EARFCN', unit: 'channel number', value: earfcn },
        N_Offs_DL: { description: 'Band EARFCN offset', unit: 'channel number', value: def.dlEarfcnOffset },
        F_DL:      { description: 'Downlink frequency', unit: 'MHz', value: frequencyMhz },
      },
      source: '3GPP TS 36.101 Table 5.7.3-1',
      applicableConditions: `Band ${band} downlink, EARFCN in [${def.dlEarfcnMin}, ${def.dlEarfcnMax}]`,
    },
  };
}

export function frequencyMhzToEarfcn(band: number, frequencyMhz: number): BandResult<'earfcn', number> {
  const def = getBandDefinition(band);
  if (!def) {
    return { ok: false, error: { reason: `Band ${band} is not in this engine's verified band table`, missingInputs: [], availableInputs: { band } } };
  }
  const earfcn = Math.round(def.dlEarfcnOffset + (frequencyMhz - def.dlFreqLowMhz) * 10);
  if (earfcn < def.dlEarfcnMin || earfcn > def.dlEarfcnMax) {
    return {
      ok: false,
      error: {
        reason: `Frequency ${frequencyMhz} MHz maps to EARFCN ${earfcn}, outside Band ${band}'s valid range [${def.dlEarfcnMin}, ${def.dlEarfcnMax}]`,
        missingInputs: [],
        availableInputs: { band, frequencyMhz },
      },
    };
  }
  return {
    ok: true,
    earfcn,
    equation: {
      name: 'LTE Frequency to EARFCN (Downlink, inverse)',
      formula: 'N_DL = round(N_Offs-DL + (F_DL − F_DL_low) × 10)',
      variables: {
        F_DL:      { description: 'Downlink frequency', unit: 'MHz', value: frequencyMhz },
        F_DL_low:  { description: 'Band downlink low-edge frequency', unit: 'MHz', value: def.dlFreqLowMhz },
        N_Offs_DL: { description: 'Band EARFCN offset', unit: 'channel number', value: def.dlEarfcnOffset },
        N_DL:      { description: 'EARFCN', unit: 'channel number', value: earfcn },
      },
      source: '3GPP TS 36.101 Table 5.7.3-1 (inverse of the forward relation)',
      applicableConditions: `Band ${band} downlink`,
    },
  };
}
