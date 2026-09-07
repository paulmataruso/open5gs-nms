// Effective-Earth-radius curvature model. Standard technique for folding
// atmospheric refraction into terrain-obstruction geometry: treat the Earth
// as a sphere with radius k times its true radius instead of separately
// modeling a curved microwave ray over a true-radius sphere — the two are
// geometrically equivalent for this purpose. k=4/3 (the "4/3 Earth" model)
// is the standard reference value for a well-mixed troposphere and is the
// default nomogram value used by ITU-R P.526 ("Propagation by diffraction").
//
// This only affects obstruction-height geometry (see diffraction.ts) — it
// is a path-wide correction, not a per-obstruction one, and is unrelated to
// elevation-downtilt.ts's antenna-pointing-angle calculation (a different,
// already explicitly out-of-scope concern noted in that file's own comment).

import { EquationRecord } from './rf-types';
import { EARTH_RADIUS_M } from './geometry';

export const EARTH_CURVATURE_K_FACTOR_STANDARD = 4 / 3;

export function effectiveEarthRadiusM(kFactor: number = EARTH_CURVATURE_K_FACTOR_STANDARD, baseRadiusM: number = EARTH_RADIUS_M): number {
  return kFactor * baseRadiusM;
}

// Height (m) by which the Earth's surface "falls away" below a straight
// chord between two points d1/d2 apart from an obstruction, due to
// curvature — subtracted from a terrain point's raw elevation when
// computing its height above the direct TX-RX line (see diffraction.ts's
// findWorstEdge). Both distances in meters, same units as effectiveEarthRadiusM.
export function earthCurvatureBulgeM(d1M: number, d2M: number, effectiveRadiusM: number): number {
  return (d1M * d2M) / (2 * effectiveRadiusM);
}

export function earthCurvatureBulgeEquation(d1M: number, d2M: number, kFactor: number, bulgeM: number): EquationRecord {
  return {
    name: 'Effective-Earth Curvature Bulge',
    formula: 'h(m) = d1·d2 / (2·k·a), a = true Earth radius (IUGG mean)',
    variables: {
      d1: { description: 'Distance from TX to the point along the path', unit: 'm', value: d1M },
      d2: { description: 'Distance from the point to RX along the path', unit: 'm', value: d2M },
      k: { description: 'Effective-Earth k-factor', unit: 'dimensionless', value: kFactor },
      h: { description: 'Curvature bulge height, subtracted from terrain elevation', unit: 'm', value: bulgeM },
    },
    source: 'ITU-R P.526, "Propagation by diffraction" — effective-Earth-radius method; k=4/3 is the standard reference value for a well-mixed troposphere',
    applicableConditions: 'Standard/average tropospheric refraction; extreme ducting or sub-refraction conditions need a different, situational k-factor',
  };
}
