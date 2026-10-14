import {
  buildingEntryLoss, buildingEntryProfileFromTags, buildingEntryEquation, materialLossDb,
  BUILDING_ENTRY_PROFILES, BUILDING_ENTRY_MIN_FREQ_GHZ, BUILDING_ENTRY_MAX_FREQ_GHZ,
} from '../building-entry';

describe('building-entry (TR 38.901 O2I)', () => {
  test('material losses are linear in frequency per Table 7.4.3-1', () => {
    // standard glass 2 + 0.2f, concrete 5 + 4f, IRR glass 23 + 0.3f
    expect(materialLossDb({ intercept: 2.0, slope: 0.2 }, 3.6)).toBeCloseTo(2.72, 9);
    expect(materialLossDb({ intercept: 5.0, slope: 4.0 }, 3.6)).toBeCloseTo(19.4, 9);
    expect(materialLossDb({ intercept: 23.0, slope: 0.3 }, 3.6)).toBeCloseTo(24.08, 9);
  });

  test('low-loss at CBRS 3.6 GHz matches the hand calculation', () => {
    // T = 0.3·10^(−2.72/10) + 0.7·10^(−19.4/10) = 0.168417
    // PL_tw = 5 − 10·log10(0.168417) = 12.741 dB
    const r = buildingEntryLoss(3.6, 'low_loss');
    expect(r.applicable).toBe(true);
    expect(r.externalWallLossDb).toBeCloseTo(12.741, 2);
    expect(r.indoorLossDb).toBe(0);
    expect(r.medianEntryLossDb).toBeCloseTo(12.741, 2);
  });

  test('high loss exceeds low loss at the same frequency', () => {
    expect(buildingEntryLoss(3.6, 'high_loss').medianEntryLossDb)
      .toBeGreaterThan(buildingEntryLoss(3.6, 'low_loss').medianEntryLossDb);
  });

  test('entry loss rises with frequency', () => {
    let previous = -Infinity;
    for (const f of [1, 2.6, 3.6, 10, 28]) {
      const value = buildingEntryLoss(f, 'low_loss').medianEntryLossDb;
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  test('indoor depth adds 0.5 dB per metre, and only when asked for', () => {
    const facade = buildingEntryLoss(3.6, 'low_loss', 0);
    const inside = buildingEntryLoss(3.6, 'low_loss', 10);
    expect(inside.indoorLossDb).toBeCloseTo(5, 9);
    expect(inside.medianEntryLossDb - facade.medianEntryLossDb).toBeCloseTo(5, 9);
    expect(facade.applicabilityDetail).toMatch(/just inside the facade/);
    expect(inside.applicabilityDetail).toMatch(/10 m indoor depth/);
  });

  test('out-of-range frequency is refused, not silently extrapolated', () => {
    const subThz = buildingEntryLoss(140, 'low_loss');
    expect(subThz.applicable).toBe(false);
    expect(subThz.medianEntryLossDb).toBe(0);
    expect(subThz.applicabilityDetail).toMatch(/outside that range/);

    expect(buildingEntryLoss(0.1, 'low_loss').applicable).toBe(false);
    // Boundaries themselves are inside.
    expect(buildingEntryLoss(BUILDING_ENTRY_MIN_FREQ_GHZ, 'low_loss').applicable).toBe(true);
    expect(buildingEntryLoss(BUILDING_ENTRY_MAX_FREQ_GHZ, 'low_loss').applicable).toBe(true);
  });

  test('reference shadow sigma is reported but never applied to the loss', () => {
    const low = buildingEntryLoss(3.6, 'low_loss');
    const high = buildingEntryLoss(3.6, 'high_loss');
    expect(low.referenceShadowSigmaDb).toBe(4.4);
    expect(high.referenceShadowSigmaDb).toBe(6.5);
    // Deterministic: repeated calls are identical, no random draw.
    expect(buildingEntryLoss(3.6, 'low_loss').medianEntryLossDb).toBe(low.medianEntryLossDb);
  });

  test('facade composition fractions sum to one', () => {
    for (const profile of Object.values(BUILDING_ENTRY_PROFILES)) {
      expect(profile.glassFraction + profile.concreteFraction).toBeCloseTo(1, 9);
    }
  });

  test('material tags select a composition, and absence returns null', () => {
    expect(buildingEntryProfileFromTags({ 'building:material': 'glass' })).toBe('low_loss');
    expect(buildingEntryProfileFromTags({ 'building:material': 'metal' })).toBe('high_loss');
    expect(buildingEntryProfileFromTags({ 'facade:material': 'brick' })).toBe('low_loss');
    // No evidence must not become a silent guess.
    expect(buildingEntryProfileFromTags({})).toBeNull();
    expect(buildingEntryProfileFromTags(undefined)).toBeNull();
    expect(buildingEntryProfileFromTags({ 'building:material': 'unobtainium' })).toBeNull();
  });

  test('equation record carries the composition and the scope caveat', () => {
    const eq = buildingEntryEquation(buildingEntryLoss(3.6, 'low_loss'));
    expect(eq.variables.p_glass.value).toBe(0.3);
    expect(eq.variables.L_concrete.value).toBeCloseTo(19.4, 2);
    expect(eq.source).toContain('38.901');
    expect(eq.limitations).toMatch(/not indoor coverage/);
  });
});
