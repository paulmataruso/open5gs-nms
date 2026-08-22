// Free-Space Path Loss, canonical SI form only. Display-unit variants
// (km/MHz, miles/MHz) are pure algebraic derivations of this same formula,
// computed on demand, never separately implemented — so they can never
// drift out of sync with each other.
//
// NOTE on the constant: FSPL(dB) = 20·log10(d) + 20·log10(f) + 20·log10(4π/c).
// 20·log10(4π/c) evaluates to ≈ −147.55 (NEGATIVE), not +147.55 — verified
// by direct substitution: at d=1000m, f=1e9Hz this must yield ≈92.45 dB
// (the widely-cited reference figure for 1 km @ 1 GHz), which only works
// with the negative constant. A commonly-seen "+147.55" in casual RF
// references is a transcription-error sign flip carried forward from
// source to source; this engine uses the value actually consistent with
// the underlying Friis relation.

import { EquationRecord } from './rf-types';
import { SPEED_OF_LIGHT_M_PER_S } from './wavelength';

export const FSPL_CONSTANT_SI = 20 * Math.log10((4 * Math.PI) / SPEED_OF_LIGHT_M_PER_S); // ≈ -147.55

export function fsplDb(distanceM: number, frequencyHz: number): number {
  return 20 * Math.log10(distanceM) + 20 * Math.log10(frequencyHz) + FSPL_CONSTANT_SI;
}

export function fsplEquation(distanceM: number, frequencyHz: number, pathLossDb: number): EquationRecord {
  return {
    name: 'Free-Space Path Loss (SI form)',
    formula: `FSPL(dB) = 20·log10(d) + 20·log10(f) + ${FSPL_CONSTANT_SI.toFixed(4)}  [d in meters, f in Hz]`,
    variables: {
      d:    { description: 'Distance', unit: 'm', value: distanceM },
      f:    { description: 'Frequency', unit: 'Hz', value: frequencyHz },
      FSPL: { description: 'Free-space path loss', unit: 'dB', value: pathLossDb },
    },
    source: `Friis, H.T. (1946), "A Note on a Simple Transmission Formula," Proc. IRE 34(5); ITU-R P.525. Constant derived using c = ${SPEED_OF_LIGHT_M_PER_S} m/s (SI-exact).`,
    applicableConditions: 'Free space (vacuum/air, no obstruction), far-field (d ≫ wavelength)',
    limitations: 'Does not include terrain, building, or foliage loss — those are separate additive link-budget terms, not part of FSPL itself',
  };
}

// Pure display-layer conversions — algebraically derived from the SI form
// above, never independently implemented.
export function fsplDbKmMhz(distanceKm: number, frequencyMhz: number): number {
  return fsplDb(distanceKm * 1000, frequencyMhz * 1_000_000);
}
export function fsplDbMilesMhz(distanceMiles: number, frequencyMhz: number): number {
  const METERS_PER_MILE = 1609.344;
  return fsplDb(distanceMiles * METERS_PER_MILE, frequencyMhz * 1_000_000);
}
