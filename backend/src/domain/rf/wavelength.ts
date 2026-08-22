import { EquationRecord } from './rf-types';

// SI-exact since the 1983 redefinition of the metre; unaffected by the
// 2019 SI base-unit redefinition.
export const SPEED_OF_LIGHT_M_PER_S = 299_792_458;

export function wavelengthMeters(frequencyHz: number): number {
  return SPEED_OF_LIGHT_M_PER_S / frequencyHz;
}

export function wavelengthEquation(frequencyHz: number, wavelengthM: number): EquationRecord {
  return {
    name: 'Wavelength',
    formula: 'λ(m) = c / f',
    variables: {
      c: { description: 'Speed of light in vacuum', unit: 'm/s', value: SPEED_OF_LIGHT_M_PER_S },
      f: { description: 'Frequency', unit: 'Hz', value: frequencyHz },
      lambda: { description: 'Wavelength', unit: 'm', value: wavelengthM },
    },
    source: 'SI Brochure (BIPM, 9th ed.) — c is an exact defined constant',
    applicableConditions: 'Free-space/air propagation (refractive index ≈ 1)',
  };
}
