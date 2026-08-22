// Elevation angle and downtilt. Keeps three genuinely different concepts
// distinct, per this project's own explicit requirement never to conflate
// them:
//   - geometricDowntilt: the angle REQUIRED to point at a target, a pure
//     output of geometry (height difference + horizontal distance).
//   - mechanicalDowntilt / electricalDowntilt: configured INPUTS on the
//     physical antenna that, when on-boresight, combine by simple addition.
// Earth curvature is NOT applied here (flat-plane approximation) — this is
// a stated, flagged assumption; true curvature/LOS correction is Phase 5.

import { EquationRecord } from './rf-types';

function toDeg(rad: number): number { return (rad * 180) / Math.PI; }

export function elevationAngleDeg(heightDiffM: number, horizontalDistanceM: number): number {
  return toDeg(Math.atan2(heightDiffM, horizontalDistanceM));
}

export function geometricDowntiltDeg(siteHeightM: number, targetHeightM: number, horizontalDistanceM: number): number {
  return toDeg(Math.atan2(siteHeightM - targetHeightM, horizontalDistanceM));
}

export function elevationEquation(heightDiffM: number, horizontalDistanceM: number, angleDeg: number): EquationRecord {
  return {
    name: 'Elevation Angle',
    formula: 'elevationAngle(deg) = atan2(Δheight, horizontalDistance) × (180/π)',
    variables: {
      deltaHeight:        { description: 'Target height minus site height', unit: 'm', value: heightDiffM },
      horizontalDistance: { description: 'Horizontal (great-circle) distance', unit: 'm', value: horizontalDistanceM },
      elevationAngle:     { description: 'Elevation angle (+ above, − below site plane)', unit: 'deg', value: angleDeg },
    },
    source: 'Elementary right-triangle trigonometry (standard antenna-alignment engineering practice)',
    applicableConditions: 'Flat-plane approximation between site and target heights',
    limitations: 'Does not account for Earth curvature — true line-of-sight/curvature correction requires terrain data (not modeled in this calculation)',
  };
}

export function geometricDowntiltEquation(
  siteHeightM: number, targetHeightM: number, horizontalDistanceM: number, downtiltDeg: number,
): EquationRecord {
  return {
    name: 'Geometric Downtilt',
    formula: 'geometricDowntilt(deg) = atan2(siteHeight − targetHeight, horizontalDistance) × (180/π)',
    variables: {
      siteHeight:         { description: 'Antenna height above ground', unit: 'm', value: siteHeightM },
      targetHeight:       { description: 'Target height above ground', unit: 'm', value: targetHeightM },
      horizontalDistance: { description: 'Horizontal distance to target', unit: 'm', value: horizontalDistanceM },
      geometricDowntilt:  { description: 'Downtilt angle required to point boresight at the target', unit: 'deg', value: downtiltDeg },
    },
    source: 'Elementary right-triangle trigonometry (standard antenna-alignment engineering practice)',
    applicableConditions: 'Flat-plane approximation; assumes on-boresight (azimuth already pointed at target)',
  };
}

export function totalConfiguredDowntiltEquation(mechanicalDeg: number, electricalDeg: number, totalDeg: number): EquationRecord {
  return {
    name: 'Total Configured Downtilt',
    formula: 'totalConfiguredDowntilt(deg) = mechanicalDowntilt + electricalDowntilt',
    variables: {
      mechanicalDowntilt:      { description: 'Physical/mechanical tilt of the antenna mount', unit: 'deg', value: mechanicalDeg },
      electricalDowntilt:      { description: 'Electrical beam tilt (antenna internal)', unit: 'deg', value: electricalDeg },
      totalConfiguredDowntilt: { description: 'Combined effective downtilt', unit: 'deg', value: totalDeg },
    },
    source: 'Standard antenna engineering practice',
    applicableConditions: 'On-boresight only',
    limitations: 'Linear addition is a standard approximation valid only when both tilt axes are coplanar with the target azimuth (on-boresight) — off-boresight combination requires full 3D antenna-pattern math (not modeled in Phase 1)',
  };
}
