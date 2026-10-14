import type { EquationRecord } from './rf-types';

// Outdoor-to-indoor (O2I) building entry loss, just inside the facade.
//
// Reference: 3GPP TR 38.901 §7.4.3.1 and Table 7.4.3-1. Per-material
// penetration loss is linear in frequency and specified over 0.6-100 GHz, so
// CBRS 3.5 GHz is comfortably inside the model.
//
// Scope, stated plainly because it is easy to oversell: this is the loss to a
// point immediately inside the exterior wall. It is NOT indoor coverage and
// not a whole-building claim — no indoor depth, no floor penetration, no
// in-building distribution. Reporting it as "indoor coverage" would be wrong.
//
// It is also deterministic: the reference shadow-fading sigmas are reported
// for context but never sampled, so the same inputs always give the same
// answer and two runs can be diffed.

export const BUILDING_ENTRY_MIN_FREQ_GHZ = 0.6;
export const BUILDING_ENTRY_MAX_FREQ_GHZ = 100;

/** TR 38.901 Table 7.4.3-1: L_material(f) = intercept + slope·f_GHz. */
const MATERIALS = {
  standardGlass: { intercept: 2.0, slope: 0.2, label: 'standard multi-pane glass' },
  irrGlass: { intercept: 23.0, slope: 0.3, label: 'IRR glass' },
  concrete: { intercept: 5.0, slope: 4.0, label: 'concrete' },
} as const;

/** Non-penetrating-incidence term, dB (TR 38.901 §7.4.3.1). */
const PL_NPI_DB = 5.0;

/** Composition mixes from TR 38.901 Table 7.4.3-2. */
export const BUILDING_ENTRY_PROFILES = {
  low_loss: { glass: MATERIALS.standardGlass, glassFraction: 0.3, concreteFraction: 0.7, shadowSigmaDb: 4.4 },
  high_loss: { glass: MATERIALS.irrGlass, glassFraction: 0.7, concreteFraction: 0.3, shadowSigmaDb: 6.5 },
} as const;

export type BuildingEntryProfileId = keyof typeof BUILDING_ENTRY_PROFILES;

export function materialLossDb(material: { intercept: number; slope: number }, frequencyGhz: number): number {
  return material.intercept + material.slope * frequencyGhz;
}

export interface BuildingEntryResult {
  profileId: BuildingEntryProfileId;
  frequencyGhz: number;
  /** Median external wall loss, dB. */
  externalWallLossDb: number;
  /** Indoor propagation term; zero at the facade by definition. */
  indoorLossDb: number;
  /** Total median entry loss, dB. */
  medianEntryLossDb: number;
  /** Reported, never sampled. */
  referenceShadowSigmaDb: number;
  applicable: boolean;
  applicabilityDetail: string;
}

export function buildingEntryLoss(
  frequencyGhz: number,
  profileId: BuildingEntryProfileId = 'low_loss',
  indoorDepthM = 0,
): BuildingEntryResult {
  const profile = BUILDING_ENTRY_PROFILES[profileId];
  const applicable =
    frequencyGhz >= BUILDING_ENTRY_MIN_FREQ_GHZ && frequencyGhz <= BUILDING_ENTRY_MAX_FREQ_GHZ;

  if (!applicable) {
    return {
      profileId, frequencyGhz,
      externalWallLossDb: 0, indoorLossDb: 0, medianEntryLossDb: 0,
      referenceShadowSigmaDb: profile.shadowSigmaDb,
      applicable: false,
      applicabilityDetail:
        `TR 38.901 Table 7.4.3-1 material losses are specified over ` +
        `${BUILDING_ENTRY_MIN_FREQ_GHZ}-${BUILDING_ENTRY_MAX_FREQ_GHZ} GHz; ${frequencyGhz} GHz is outside that range`,
    };
  }

  const glassLoss = materialLossDb(profile.glass, frequencyGhz);
  const concreteLoss = materialLossDb(MATERIALS.concrete, frequencyGhz);
  // Power-domain mix: a facade is a parallel combination of materials, so the
  // transmissions add, not the dB losses.
  const transmission =
    profile.glassFraction * 10 ** (-glassLoss / 10) +
    profile.concreteFraction * 10 ** (-concreteLoss / 10);
  const externalWallLossDb = PL_NPI_DB - 10 * Math.log10(transmission);
  const indoorLossDb = 0.5 * Math.max(indoorDepthM, 0);

  return {
    profileId, frequencyGhz,
    externalWallLossDb,
    indoorLossDb,
    medianEntryLossDb: externalWallLossDb + indoorLossDb,
    referenceShadowSigmaDb: profile.shadowSigmaDb,
    applicable: true,
    applicabilityDetail:
      indoorDepthM > 0
        ? `median O2I loss at ${indoorDepthM} m indoor depth; not a whole-building or per-floor claim`
        : 'median O2I loss just inside the facade; no indoor depth, floor penetration or in-building distribution is modelled',
  };
}

/**
 * Pick a composition from OSM material tags when they are present. Returns
 * null when there is no evidence, so the caller can decide rather than having
 * a guess silently baked in.
 */
export function buildingEntryProfileFromTags(tags?: Record<string, string>): BuildingEntryProfileId | null {
  const material = `${tags?.['building:material'] ?? ''} ${tags?.['facade:material'] ?? ''} ${tags?.material ?? ''}`.toLowerCase();
  if (!material.trim()) return null;
  // IRR/low-emissivity glazing and metal cladding are the high-loss cases.
  if (/metal|steel|aluminium|aluminum|irr|low-e|coated_glass/.test(material)) return 'high_loss';
  if (/glass|wood|brick|concrete|plaster|stone/.test(material)) return 'low_loss';
  return null;
}

export function buildingEntryEquation(result: BuildingEntryResult): EquationRecord {
  const profile = BUILDING_ENTRY_PROFILES[result.profileId];
  return {
    name: `TR 38.901 O2I building entry loss (${result.profileId.replace('_', '-')})`,
    formula: 'PL_tw = PL_npi − 10·log10( p_glass·10^(−L_glass/10) + p_concrete·10^(−L_concrete/10) ); PL_in = 0.5·d_2D-in',
    variables: {
      f_GHz: { description: 'carrier frequency', unit: 'GHz', value: result.frequencyGhz },
      PL_npi: { description: 'non-penetrating-incidence term', unit: 'dB', value: PL_NPI_DB },
      L_glass: { description: `${profile.glass.label} penetration loss`, unit: 'dB', value: Number(materialLossDb(profile.glass, result.frequencyGhz).toFixed(2)) },
      L_concrete: { description: 'concrete penetration loss', unit: 'dB', value: Number(materialLossDb(MATERIALS.concrete, result.frequencyGhz).toFixed(2)) },
      p_glass: { description: 'glass fraction of the facade', unit: 'fraction', value: profile.glassFraction },
      p_concrete: { description: 'concrete fraction of the facade', unit: 'fraction', value: profile.concreteFraction },
      PL_tw: { description: 'external wall loss', unit: 'dB', value: Number(result.externalWallLossDb.toFixed(2)) },
      L_building: { description: 'total median entry loss', unit: 'dB', value: Number(result.medianEntryLossDb.toFixed(2)) },
      sigma_ref: { description: 'reference shadow sigma (reported, not sampled)', unit: 'dB', value: result.referenceShadowSigmaDb },
    },
    source: '3GPP TR 38.901 §7.4.3.1, Tables 7.4.3-1 and 7.4.3-2',
    applicableConditions: `${BUILDING_ENTRY_MIN_FREQ_GHZ}-${BUILDING_ENTRY_MAX_FREQ_GHZ} GHz, outdoor-to-indoor at the facade`,
    limitations:
      'Just inside the exterior wall only — not indoor coverage, not a whole-building claim, no floor penetration or in-building distribution. ' +
      'Deterministic: the reference shadow sigma is reported but never sampled.',
  };
}
