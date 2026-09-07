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

import { EquationRecord, LosClassification } from './rf-types';
import { SPEED_OF_LIGHT_M_PER_S } from './wavelength';
import { EARTH_CURVATURE_K_FACTOR_STANDARD, earthCurvatureBulgeM, effectiveEarthRadiusM as computeEffectiveEarthRadiusM } from './earth-curvature';
import { DEFAULT_FRESNEL_CLEARANCE_THRESHOLD_PERCENT, classifyLineOfSight, fresnelClearancePercent, fresnelZoneRadiusM } from './fresnel-zone';

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
  // Unchanged meaning: true iff the worst obstruction's Fresnel-Kirchhoff
  // parameter is <= -1 (diffraction loss is negligible), NOT the same
  // question as losClassification below — see this file's header comment.
  isLineOfSight: boolean;
  dominantEdgeIndex: number | null;
  // Distinct, additive classification against a configurable Fresnel
  // clearance threshold. null when there was no candidate obstruction
  // point at all (e.g. a 2-point profile) — clearance is undefined, not
  // zero, when there's nothing to measure it against.
  losClassification: LosClassification;
  fresnelClearancePercent: number | null;
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

export interface WorstEdge {
  index: number;
  v: number;
  d1M: number;
  d2M: number;
  obstructionHeightM: number;
}

function findWorstEdge(
  profile: TerrainProfilePoint[], startIdx: number, endIdx: number,
  txAbsHeightM: number, txDistanceM: number, rxAbsHeightM: number, rxDistanceM: number, wavelengthM: number,
  effectiveEarthRadiusM: number,
): WorstEdge | null {
  const spanM = rxDistanceM - txDistanceM;
  if (spanM <= 0) return null;
  let worst: WorstEdge | null = null;
  for (let i = startIdx + 1; i < endIdx; i++) {
    const p = profile[i];
    const d1 = p.distanceM - txDistanceM;
    const d2 = rxDistanceM - p.distanceM;
    if (d1 <= 0 || d2 <= 0) continue;
    const lineHeightM = txAbsHeightM + (rxAbsHeightM - txAbsHeightM) * (d1 / spanM);
    const bulgeM = earthCurvatureBulgeM(d1, d2, effectiveEarthRadiusM);
    const obstructionHeightM = p.elevationM - lineHeightM - bulgeM;
    const v = fresnelKirchhoffParameter(obstructionHeightM, d1, d2, wavelengthM);
    if (!worst || v > worst.v) worst = { index: i, v, d1M: d1, d2M: d2, obstructionHeightM };
  }
  return worst;
}

function deygoutRecursive(
  profile: TerrainProfilePoint[], startIdx: number, endIdx: number,
  txAbsHeightM: number, txDistanceM: number, rxAbsHeightM: number, rxDistanceM: number, wavelengthM: number,
  effectiveEarthRadiusM: number,
): { lossDb: number; dominantEdgeIndex: number | null; topEdge: WorstEdge | null } {
  const worst = findWorstEdge(profile, startIdx, endIdx, txAbsHeightM, txDistanceM, rxAbsHeightM, rxDistanceM, wavelengthM, effectiveEarthRadiusM);
  // topEdge is this invocation's own worst-found edge, captured
  // unconditionally — including when v<=-1 — so a top-level caller can
  // still compute a real Fresnel clearance percentage for an otherwise
  // "clear" path (see computeDiffractionLossDb). Only the single top-level
  // call's topEdge is ever read by a caller; nested recursive calls'
  // topEdge values are intentionally unused (each sub-path's own dominant
  // edge is a different, narrower question than the whole-path clearance
  // this exists to answer).
  if (!worst || worst.v <= -1) {
    return { lossDb: 0, dominantEdgeIndex: null, topEdge: worst };
  }
  const edge = profile[worst.index];
  const edgeLossDb = knifeEdgeDiffractionLossDb(worst.v);

  const left = deygoutRecursive(profile, startIdx, worst.index, txAbsHeightM, txDistanceM, edge.elevationM, edge.distanceM, wavelengthM, effectiveEarthRadiusM);
  const right = deygoutRecursive(profile, worst.index, endIdx, edge.elevationM, edge.distanceM, rxAbsHeightM, rxDistanceM, wavelengthM, effectiveEarthRadiusM);

  return { lossDb: edgeLossDb + left.lossDb + right.lossDb, dominantEdgeIndex: worst.index, topEdge: worst };
}

// txHeightM/rxHeightM are heights ABOVE GROUND at each end; profile[0]/
// profile[last] supply the real ground elevation at the TX/RX locations.
// kFactor and fresnelClearanceThresholdPercent both default to this
// engine's standard values (4/3 Earth, 60% clearance) when omitted — every
// existing caller that doesn't pass them gets identical behavior to before
// these parameters existed, aside from the (physically correct) addition
// of curvature to the obstruction-height geometry itself.
export function computeDiffractionLossDb(
  profile: TerrainProfilePoint[], txHeightM: number, rxHeightM: number, frequencyHz: number,
  kFactor: number = EARTH_CURVATURE_K_FACTOR_STANDARD,
  fresnelClearanceThresholdPercent: number = DEFAULT_FRESNEL_CLEARANCE_THRESHOLD_PERCENT,
): DiffractionResult {
  if (profile.length < 2) {
    return { totalLossDb: 0, isLineOfSight: true, dominantEdgeIndex: null, losClassification: 'los', fresnelClearancePercent: null };
  }
  const wavelengthM = SPEED_OF_LIGHT_M_PER_S / frequencyHz;
  const first = profile[0];
  const last = profile[profile.length - 1];
  const txAbsHeightM = first.elevationM + txHeightM;
  const rxAbsHeightM = last.elevationM + rxHeightM;
  const effectiveRadiusM = computeEffectiveEarthRadiusM(kFactor);

  const { lossDb, dominantEdgeIndex, topEdge } = deygoutRecursive(
    profile, 0, profile.length - 1,
    txAbsHeightM, first.distanceM, rxAbsHeightM, last.distanceM, wavelengthM,
    effectiveRadiusM,
  );

  let losClassification: LosClassification = 'los';
  let clearancePercent: number | null = null;
  if (topEdge) {
    const f1RadiusM = fresnelZoneRadiusM(topEdge.d1M, topEdge.d2M, wavelengthM);
    clearancePercent = fresnelClearancePercent(topEdge.obstructionHeightM, f1RadiusM);
    losClassification = classifyLineOfSight(clearancePercent, fresnelClearanceThresholdPercent);
  }

  return {
    totalLossDb: Math.max(lossDb, 0),
    isLineOfSight: dominantEdgeIndex === null,
    dominantEdgeIndex,
    losClassification,
    fresnelClearancePercent: clearancePercent,
  };
}
