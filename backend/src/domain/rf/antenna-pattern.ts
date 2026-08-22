// Directional antenna gain as a function of pointing angle, using the
// well-established 3GPP TR 36.814 sectorized-antenna-pattern shape (a
// quadratic dB roll-off away from boresight, capped at a front-to-back/
// sidelobe attenuation limit). The roll-off SHAPE is a standard, widely
// cited model. The cutoff constants (front-to-back attenuation, default
// vertical beamwidth) are NOT asserted as verified exact spec numbers for
// any specific antenna — they're shipped as configurable, overridable
// defaults (see coverage-grid.ts's Assumption entries), consistent with
// this project's standing rule against unverified numeric claims.
//
// This is a simplified 2D-separable pattern (horizontal and vertical
// planes computed independently, then capped together) — a real antenna
// has a full 3D radiation pattern that a manufacturer's pattern file would
// model more precisely.

import { EquationRecord } from './rf-types';

export const DEFAULT_FRONT_TO_BACK_DB = 20;
export const DEFAULT_VERTICAL_BEAMWIDTH_DEG = 10;

function normalizeAngleDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

export function horizontalPatternLossDb(azimuthOffsetDeg: number, horizontalBeamwidthDeg: number, frontToBackDb: number): number {
  const offset = normalizeAngleDeg(azimuthOffsetDeg);
  return Math.min(12 * (offset / horizontalBeamwidthDeg) ** 2, frontToBackDb);
}

export function verticalPatternLossDb(elevationOffsetDeg: number, verticalBeamwidthDeg: number, sidelobeAttenuationDb: number): number {
  return Math.min(12 * (elevationOffsetDeg / verticalBeamwidthDeg) ** 2, sidelobeAttenuationDb);
}

export function combinedPatternLossDb(horizontalLossDb: number, verticalLossDb: number, frontToBackDb: number): number {
  return Math.min(horizontalLossDb + verticalLossDb, frontToBackDb);
}

export function directionalAntennaGainDb(peakGainDbi: number, patternLossDb: number): number {
  return peakGainDbi - patternLossDb;
}

export function antennaPatternEquation(
  azimuthOffsetDeg: number, horizontalBeamwidthDeg: number,
  elevationOffsetDeg: number, verticalBeamwidthDeg: number,
  frontToBackDb: number, patternLossDb: number,
): EquationRecord {
  return {
    name: '3GPP Sectorized Antenna Pattern',
    formula: 'A(φ,θ) = min(min(12·(φ/φ3dB)², Am) + min(12·(θ/θ3dB)², SLAv), Am)',
    variables: {
      phi:      { description: 'Azimuth offset from antenna boresight', unit: 'deg', value: azimuthOffsetDeg },
      phi3dB:   { description: 'Horizontal (azimuth) 3dB beamwidth', unit: 'deg', value: horizontalBeamwidthDeg },
      theta:    { description: 'Elevation offset from configured tilt', unit: 'deg', value: elevationOffsetDeg },
      theta3dB: { description: 'Vertical (elevation) 3dB beamwidth', unit: 'deg', value: verticalBeamwidthDeg },
      Am:       { description: 'Front-to-back / max attenuation cap', unit: 'dB', value: frontToBackDb },
      A:        { description: 'Combined directional pattern loss', unit: 'dB', value: patternLossDb },
    },
    source: '3GPP TR 36.814 V9.0.0 (2010), Annex A.2.1.1, sectorized antenna pattern model (quadratic roll-off shape). The Am/SLAv cutoff values are configurable defaults supplied per-request, not asserted as fixed spec constants for a specific antenna model.',
    applicableConditions: 'Directional sector antenna with a single main lobe; angles measured relative to boresight',
    limitations: 'Simplified 2D-separable pattern (horizontal and vertical planes computed independently, then capped together) — not a full 3D measured radiation pattern',
  };
}
