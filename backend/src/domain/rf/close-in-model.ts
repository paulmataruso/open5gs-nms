// Close-In (CI) Free-Space Reference-Distance path loss model — a
// single-parameter (path-loss exponent, PLE) generalization of FSPL that,
// unlike Hata/COST-231-Hata, has NO antenna-height or frequency-range
// restriction — it's valid from sub-1 GHz through mmWave and at any
// mounting height, making it the right tool for low-height small-cell/
// CBRS-style deployments that Hata/COST-231-Hata's 1980s macrocell-era
// validity ranges (30-200m towers, <=2000MHz) explicitly exclude.
//
// The default path-loss exponents are real MEASURED values for the Urban
// Micro (UMi) Street Canyon scenario — a low-height small-cell environment
// closely matching a short-tower CBRS deployment — from real propagation
// measurement campaigns (Nokia/AAU, Qualcomm, NYU, Aalto University)
// spanning 2-73.5 GHz, which fully covers CBRS's 3.55-3.7 GHz band. These
// are cited, measured numbers, not a guess:
//
//   LOS:  n = 2.0, sigma = 2.9 dB  (2-73.5 GHz, 5-121 m)
//   NLOS: n = 3.1, sigma = 8.1 dB  (2-73.5 GHz, 19-272 m)
//
// Source: Sun, S., Rappaport, T.S., Rangan, S., Thomas, T.A., Ghosh, A.,
// Kovacs, I.Z., Rodriguez, I., Koymen, O., Partyka, A., Jarvelainen, J.
// (2016), "Propagation Path Loss Models for 5G Urban Micro- and
// Macro-Cellular Scenarios," IEEE 83rd Vehicular Technology Conference
// (VTC Spring 2016), Table I / Table II (UMi Street Canyon NLOS,
// 2-73.5 GHz combined row).
//
// When terrain data is available (useTerrainData), LOS/NLOS is resolved
// automatically from the real Deygout line-of-sight determination — see
// site-signal.ts. Without terrain data, the caller must say which applies
// (isLineOfSight), defaulting to the more conservative NLOS exponent.

import { EquationRecord } from './rf-types';
import { SPEED_OF_LIGHT_M_PER_S } from './wavelength';

export const UMI_SC_LOS_PLE = 2.0;
export const UMI_SC_NLOS_PLE = 3.1;
export const UMI_SC_FREQ_RANGE_GHZ: [number, number] = [2, 73.5];

export function fspl1mDb(frequencyHz: number): number {
  return 20 * Math.log10((4 * Math.PI * frequencyHz) / SPEED_OF_LIGHT_M_PER_S);
}

export function closeInPathLossDb(distanceM: number, frequencyHz: number, pathLossExponent: number): number {
  return fspl1mDb(frequencyHz) + 10 * pathLossExponent * Math.log10(distanceM);
}

export function closeInEquation(
  distanceM: number, frequencyHz: number, pathLossExponent: number,
  isLineOfSight: boolean | undefined, pathLossDb: number,
): EquationRecord {
  return {
    name: 'Close-In (CI) Free-Space Reference-Distance Path Loss',
    formula: 'PL(dB) = FSPL(f, 1m) + 10·n·log10(d)  [n = path-loss exponent]',
    variables: {
      FSPL_1m: { description: 'Free-space path loss at 1m reference distance', unit: 'dB', value: fspl1mDb(frequencyHz) },
      n: {
        description: `Path-loss exponent${isLineOfSight === true ? ' (measured UMi Street Canyon LOS value)' : isLineOfSight === false ? ' (measured UMi Street Canyon NLOS value)' : ''}`,
        unit: 'dimensionless', value: pathLossExponent,
      },
      d:  { description: 'Distance', unit: 'm', value: distanceM },
      PL: { description: 'Path loss', unit: 'dB', value: pathLossDb },
    },
    source: 'Sun, S., Rappaport, T.S., Rangan, S., et al. (2016), "Propagation Path Loss Models for 5G Urban Micro- and Macro-Cellular Scenarios," IEEE 83rd VTC Spring 2016, Table I/II — measured Urban Micro Street Canyon path-loss exponents, 2-73.5 GHz',
    applicableConditions: 'Valid at any frequency and any mounting height (no macrocell restriction, unlike Hata/COST-231-Hata) — default exponents measured for low-height urban micro/small-cell deployments, 2-73.5 GHz',
    limitations: 'A single-parameter model using a real measured average for the UMi Street Canyon environment — not a site-specific fit for your exact deployment; override the exponent directly if you have your own measured value',
  };
}
