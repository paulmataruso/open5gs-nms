// Generic, configurable log-distance path-loss model with named environment
// presets — the classic PL(d) = PL(d0) + 10*n*log10(d/d0) + X_sigma form,
// using the same 1m free-space reference distance and the same underlying
// math as close-in-model.ts (fspl1mDb/closeInPathLossDb are reused
// directly, not reimplemented — see this engine's standing rule against
// duplicating a formula in more than one place).
//
// This is a DIFFERENT PropagationModel member from 'close-in', not a
// replacement for it: close-in is deliberately narrow (only the two real,
// measured UMi Street Canyon exponents, cited to a specific paper) and
// stays exactly as-is. This model exists for the general case — a
// configurable exponent with named, general-purpose environment presets.
//
// Preset honesty: every entry below is either a real, checked citation
// (verified: true) or an explicitly flagged provisional value
// (verified: false) that fires a warning when selected — see
// site-signal.ts/coverage-grid.ts's UNVERIFIED_PRESET_VALUE warning. No
// preset value is invented and presented as equally trustworthy as a cited
// one; a dedicated citation pass for rural/suburban is a known follow-up
// (see the RF Planning plan's "Open Questions").

import { EquationRecord, LogDistanceEnvironment } from './rf-types';
import { fspl1mDb, closeInPathLossDb } from './close-in-model';

export interface LogDistancePreset {
  pathLossExponent: number;
  rangeNote: string;
  source: string;
  verified: boolean;
}

// Rappaport, T.S. (2002), Wireless Communications: Principles and
// Practice, 2nd ed., Table 4.2 — a single representative point is taken
// from each cited range (not the range midpoint, and not curve-fit; a
// plain, documented choice within the cited range).
const RAPPAPORT_TABLE_4_2 = 'Rappaport, T.S. (2002), Wireless Communications: Principles and Practice, 2nd ed., Table 4.2';

export const LOG_DISTANCE_ENVIRONMENT_PRESETS: Record<LogDistanceEnvironment, LogDistancePreset> = {
  'free-space': {
    pathLossExponent: 2.0,
    rangeNote: 'n=2.0 exactly — the physical free-space exponent (this preset reduces the model to plain FSPL)',
    source: 'Physical definition of free-space path loss',
    verified: true,
  },
  urban: {
    pathLossExponent: 3.0,
    rangeNote: '"Urban area cellular radio," cited range 2.7-3.5',
    source: RAPPAPORT_TABLE_4_2,
    verified: true,
  },
  'dense-urban': {
    pathLossExponent: 4.0,
    rangeNote: '"Shadowed urban cellular radio," cited range 3-5',
    source: RAPPAPORT_TABLE_4_2,
    verified: true,
  },
  indoor: {
    pathLossExponent: 1.7,
    rangeNote: '"In-building line-of-sight," cited range 1.6-1.8 (obstructed/NLOS indoor is a separate 4-6 row in the same table, not used here)',
    source: RAPPAPORT_TABLE_4_2,
    verified: true,
  },
  // No single citable source was found for a fixed "rural" or "suburban"
  // exponent during this feature's verification pass — these two values
  // are provisional placeholders, not measurements, and are flagged as
  // such at every call site that selects them.
  rural: {
    pathLossExponent: 3.5,
    rangeNote: 'UNVERIFIED — no single citable source found for a fixed rural exponent; provisional placeholder only',
    source: 'Not independently verified',
    verified: false,
  },
  suburban: {
    pathLossExponent: 3.0,
    rangeNote: 'UNVERIFIED — no single citable source found for a fixed suburban exponent; provisional placeholder only',
    source: 'Not independently verified',
    verified: false,
  },
};

export function logDistancePathLossDb(distanceM: number, frequencyHz: number, pathLossExponent: number): number {
  return closeInPathLossDb(distanceM, frequencyHz, pathLossExponent);
}

export function logDistanceEquation(
  distanceM: number, frequencyHz: number, pathLossExponent: number,
  environment: LogDistanceEnvironment | undefined, pathLossDb: number,
): EquationRecord {
  const preset = environment ? LOG_DISTANCE_ENVIRONMENT_PRESETS[environment] : undefined;
  return {
    name: 'Log-Distance Path Loss',
    formula: 'PL(dB) = FSPL(f, 1m) + 10·n·log10(d)  [n = path-loss exponent]',
    variables: {
      FSPL_1m: { description: 'Free-space path loss at 1m reference distance', unit: 'dB', value: fspl1mDb(frequencyHz) },
      n: {
        description: preset ? `Path-loss exponent (${environment} preset: ${preset.rangeNote})` : 'Path-loss exponent (explicit override)',
        unit: 'dimensionless', value: pathLossExponent,
      },
      d:  { description: 'Distance', unit: 'm', value: distanceM },
      PL: { description: 'Path loss', unit: 'dB', value: pathLossDb },
    },
    source: preset ? preset.source : 'Explicit user-supplied path-loss exponent',
    applicableConditions: 'General-purpose log-distance model — valid at any frequency/height; environment presets are general starting points, not universal physical constants for that environment',
    limitations: preset && !preset.verified
      ? 'This preset value is UNVERIFIED — no single citable reference was found for it; treat as a provisional placeholder, not a measured value'
      : 'A single-parameter statistical model — real path loss at any given location varies around this prediction (shadow fading, X_sigma, is not modeled as a distribution here)',
  };
}
