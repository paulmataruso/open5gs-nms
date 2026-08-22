// ITU-R P.526 knife-edge diffraction, generalized to multiple obstructions
// via the Deygout method: find the single worst-obstructing terrain point
// over the whole path, compute its knife-edge loss, then recurse
// independently on the TX->edge and edge->RX sub-paths (each using its own
// local d1/d2, with the main edge's own elevation as that sub-path's far
// endpoint), summing all three losses.
//
// NOT applied: ITU-R P.526's own empirical correction term for
// closely-spaced multiple edges. Its exact coefficients were not
// independently verified during this feature's design pass, so it is
// deliberately omitted rather than guessed at — a real, stated
// simplification, not a hidden gap.

import { EquationRecord } from './rf-types';
import { SPEED_OF_LIGHT_M_PER_S } from './wavelength';

// A resolved (no voids/unfetchable gaps) elevation profile along a path,
// distance from the TX end, at even sampling intervals. Handling of raw
// fetched data that MAY contain gaps (a tile couldn't be fetched, an
// ocean void, etc.) is the caller's responsibility — see terrain-profile.ts
// and coverage-grid.ts's degrade-gracefully-to-flat-earth logic. Diffraction
// math itself assumes a complete profile.
export interface TerrainProfilePoint {
  distanceM: number;
  elevationM: number;
}

export interface DiffractionResult {
  totalLossDb: number;
  isLineOfSight: boolean;
  dominantEdgeIndex: number | null;
}

export function fresnelKirchhoffParameter(obstructionHeightM: number, d1M: number, d2M: number, wavelengthM: number): number {
  return obstructionHeightM * Math.sqrt((2 * (d1M + d2M)) / (wavelengthM * d1M * d2M));
}

// Lee, W.C.Y. (1985), Mobile Communications Engineering — closed-form fit
// to the ITU-R P.526 knife-edge diffraction curve. Verified reference
// point: v=0 (grazing incidence) -> -20*log10(0.5) ~= +6.02 dB, the
// standard textbook value for a path that just grazes an obstruction.
//
// Sign note: Lee's own formula is conventionally stated as a GAIN
// adjustment G(v) (negative, added to a free-space received-power figure).
// This function instead returns the POSITIVE loss magnitude (-G(v)), to
// match every other `*LossDb` quantity in this engine (pathLossDb,
// buildingLossDb, ...), which are always positive numbers subtracted in
// the link-budget cascade — sign-flipped from the source formula, not a
// different formula.
export function knifeEdgeDiffractionLossDb(v: number): number {
  if (v <= -1) return 0;
  if (v <= 0) return -20 * Math.log10(0.5 - 0.62 * v);
  if (v <= 1) return -20 * Math.log10(0.5 * Math.exp(-0.95 * v));
  if (v <= 2.4) return -20 * Math.log10(0.4 - Math.sqrt(0.1184 - (0.38 - 0.1 * v) ** 2));
  return -20 * Math.log10(0.225 / v);
}

export function fresnelKirchhoffEquation(v: number, lossDb: number): EquationRecord {
  return {
    name: 'Fresnel-Kirchhoff Knife-Edge Diffraction Loss',
    formula: 'ν = h·√(2(d1+d2)/(λ·d1·d2)); loss = J(ν), Lee\'s closed-form fit to the ITU-R P.526 curve',
    variables: {
      v:      { description: 'Fresnel-Kirchhoff diffraction parameter', unit: 'dimensionless', value: v },
      lossDb: { description: 'Knife-edge diffraction loss', unit: 'dB', value: lossDb },
    },
    source: 'Lee, W.C.Y. (1985), Mobile Communications Engineering — closed-form fit to the ITU-R P.526 knife-edge diffraction curve',
    applicableConditions: 'Single dominant knife-edge obstruction between transmitter and receiver',
    limitations: 'A single geometric knife edge approximates a real terrain ridge — finite ridge width/rounding is not modeled',
  };
}

function findWorstEdge(
  profile: TerrainProfilePoint[], startIdx: number, endIdx: number,
  txAbsHeightM: number, txDistanceM: number, rxAbsHeightM: number, rxDistanceM: number, wavelengthM: number,
): { index: number; v: number } | null {
  const spanM = rxDistanceM - txDistanceM;
  if (spanM <= 0) return null;
  let worst: { index: number; v: number } | null = null;
  for (let i = startIdx + 1; i < endIdx; i++) {
    const p = profile[i];
    const d1 = p.distanceM - txDistanceM;
    const d2 = rxDistanceM - p.distanceM;
    if (d1 <= 0 || d2 <= 0) continue;
    const lineHeightM = txAbsHeightM + (rxAbsHeightM - txAbsHeightM) * (d1 / spanM);
    const obstructionHeightM = p.elevationM - lineHeightM;
    const v = fresnelKirchhoffParameter(obstructionHeightM, d1, d2, wavelengthM);
    if (!worst || v > worst.v) worst = { index: i, v };
  }
  return worst;
}

function deygoutRecursive(
  profile: TerrainProfilePoint[], startIdx: number, endIdx: number,
  txAbsHeightM: number, txDistanceM: number, rxAbsHeightM: number, rxDistanceM: number, wavelengthM: number,
): { lossDb: number; dominantEdgeIndex: number | null } {
  const worst = findWorstEdge(profile, startIdx, endIdx, txAbsHeightM, txDistanceM, rxAbsHeightM, rxDistanceM, wavelengthM);
  if (!worst || worst.v <= -1) {
    return { lossDb: 0, dominantEdgeIndex: null };
  }
  const edge = profile[worst.index];
  const edgeLossDb = knifeEdgeDiffractionLossDb(worst.v);

  const left = deygoutRecursive(profile, startIdx, worst.index, txAbsHeightM, txDistanceM, edge.elevationM, edge.distanceM, wavelengthM);
  const right = deygoutRecursive(profile, worst.index, endIdx, edge.elevationM, edge.distanceM, rxAbsHeightM, rxDistanceM, wavelengthM);

  return { lossDb: edgeLossDb + left.lossDb + right.lossDb, dominantEdgeIndex: worst.index };
}

// txHeightM/rxHeightM are heights ABOVE GROUND at each end; profile[0]/
// profile[last] supply the real ground elevation at the TX/RX locations.
export function computeDiffractionLossDb(
  profile: TerrainProfilePoint[], txHeightM: number, rxHeightM: number, frequencyHz: number,
): DiffractionResult {
  if (profile.length < 2) {
    return { totalLossDb: 0, isLineOfSight: true, dominantEdgeIndex: null };
  }
  const wavelengthM = SPEED_OF_LIGHT_M_PER_S / frequencyHz;
  const first = profile[0];
  const last = profile[profile.length - 1];
  const txAbsHeightM = first.elevationM + txHeightM;
  const rxAbsHeightM = last.elevationM + rxHeightM;

  const { lossDb, dominantEdgeIndex } = deygoutRecursive(
    profile, 0, profile.length - 1,
    txAbsHeightM, first.distanceM, rxAbsHeightM, last.distanceM, wavelengthM,
  );

  return { totalLossDb: Math.max(lossDb, 0), isLineOfSight: dominantEdgeIndex === null, dominantEdgeIndex };
}
