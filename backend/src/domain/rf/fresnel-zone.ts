// First Fresnel zone radius and clearance-percentage classification.
// Deliberately decoupled from diffraction.ts's existing v<=-1 "clear"
// cutoff: that cutoff answers "is diffraction loss negligible" (it
// corresponds to ~70.7% F1 clearance, since v = sqrt(2)*(h/F1) — a fact,
// not a design choice, verified by direct algebraic substitution), while
// this module answers the distinct engineering-visualization question "how
// much of the first Fresnel zone is actually clear," at a user-chosen
// threshold. Both are legitimate, different questions — see
// diffraction.ts's DiffractionResult for how isLineOfSight and
// losClassification coexist without one redefining the other.

import { EquationRecord, LosClassification } from './rf-types';

export const DEFAULT_FRESNEL_CLEARANCE_THRESHOLD_PERCENT = 60;

export function fresnelZoneRadiusM(d1M: number, d2M: number, wavelengthM: number): number {
  return Math.sqrt((wavelengthM * d1M * d2M) / (d1M + d2M));
}

// obstructionHeightM follows diffraction.ts's sign convention (positive =
// obstruction pokes above the direct TX-RX line, i.e. blocking). Clearance
// is the fraction of F1 that is NOT intruded upon, so a negative
// (below-the-line) obstruction gives positive clearance.
export function fresnelClearancePercent(obstructionHeightM: number, fresnelRadiusM: number): number {
  if (fresnelRadiusM <= 0) return 0;
  return (-obstructionHeightM / fresnelRadiusM) * 100;
}

export function classifyLineOfSight(clearancePercent: number, thresholdPercent: number = DEFAULT_FRESNEL_CLEARANCE_THRESHOLD_PERCENT): LosClassification {
  if (clearancePercent <= 0) return 'nlos';
  if (clearancePercent >= thresholdPercent) return 'los';
  return 'partial';
}

export function fresnelZoneEquation(d1M: number, d2M: number, wavelengthM: number, radiusM: number, clearancePercent: number, thresholdPercent: number): EquationRecord {
  return {
    name: 'First Fresnel Zone Radius and Clearance',
    formula: 'F1(m) = sqrt(λ·d1·d2 / (d1+d2)); clearance% = -h / F1 × 100',
    variables: {
      d1: { description: 'Distance from TX to the point along the path', unit: 'm', value: d1M },
      d2: { description: 'Distance from the point to RX along the path', unit: 'm', value: d2M },
      lambda: { description: 'Wavelength', unit: 'm', value: wavelengthM },
      F1: { description: 'First Fresnel zone radius at this point', unit: 'm', value: radiusM },
      clearancePercent: { description: 'Percentage of F1 that is clear of obstruction', unit: '%', value: clearancePercent },
      thresholdPercent: { description: 'Configured clearance threshold for LOS classification', unit: '%', value: thresholdPercent },
    },
    source: 'ITU-R P.526, "Propagation by diffraction", Annex 1 — first Fresnel zone geometry',
    applicableConditions: 'Single point along a two-ray propagation path',
  };
}
