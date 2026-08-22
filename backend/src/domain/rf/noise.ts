// Thermal (Johnson-Nyquist) noise floor. Only the base kTB primitive plus
// an optional noise-figure add-on ship here — full SINR (needs modeled
// interference) is out of scope until interference sources exist.

import { EquationRecord } from './rf-types';

// SI-exact per the 2019 SI redefinition.
export const BOLTZMANN_J_PER_K = 1.380649e-23;

export interface ThermalNoiseInput {
  temperatureK: number;
  bandwidthHz: number;
  noiseFigureDb?: number;
}

export function thermalNoiseDbm(input: ThermalNoiseInput): number {
  const noiseWatts = BOLTZMANN_J_PER_K * input.temperatureK * input.bandwidthHz;
  const noiseDbm = 10 * Math.log10(noiseWatts * 1000);
  return noiseDbm + (input.noiseFigureDb ?? 0);
}

export function thermalNoiseEquation(input: ThermalNoiseInput, noiseDbm: number): EquationRecord {
  return {
    name: 'Thermal Noise Floor (Johnson-Nyquist)',
    formula: 'N(dBm) = 10·log10(k·T·B × 1000) + NF',
    variables: {
      k:  { description: 'Boltzmann constant', unit: 'J/K', value: BOLTZMANN_J_PER_K },
      T:  { description: 'Noise temperature', unit: 'K', value: input.temperatureK },
      B:  { description: 'Bandwidth', unit: 'Hz', value: input.bandwidthHz },
      NF: { description: 'Receiver noise figure', unit: 'dB', value: input.noiseFigureDb ?? 0 },
      N:  { description: 'Thermal noise power', unit: 'dBm', value: noiseDbm },
    },
    source: 'Johnson, J.B. (1928), Phys. Rev. 32, 97; Nyquist, H. (1928), Phys. Rev. 32, 110. k per BIPM SI Brochure (9th ed., SI-exact).',
    applicableConditions: 'k is SI-exact; T=290K is the conventional reference noise temperature (Pozar, Microwave Engineering, 4th ed.)',
  };
}
