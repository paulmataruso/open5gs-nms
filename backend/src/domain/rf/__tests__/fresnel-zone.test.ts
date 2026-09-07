import { fresnelZoneRadiusM, fresnelClearancePercent, classifyLineOfSight, DEFAULT_FRESNEL_CLEARANCE_THRESHOLD_PERCENT } from '../fresnel-zone';
import { fresnelKirchhoffParameter } from '../diffraction';

describe('fresnel-zone', () => {
  const FREQ_HZ = 900_000_000; // 900 MHz
  const WAVELENGTH_M = 299_792_458 / FREQ_HZ; // ~0.33310 m

  test('first Fresnel zone radius at 900 MHz, d1=d2=5000m, matches the worked example (~28.86m)', () => {
    const f1 = fresnelZoneRadiusM(5000, 5000, WAVELENGTH_M);
    expect(f1).toBeCloseTo(28.86, 1);
  });

  test('Fresnel zone radius scales with sqrt(wavelength)', () => {
    const f1 = fresnelZoneRadiusM(5000, 5000, WAVELENGTH_M);
    const f1DoubleLambda = fresnelZoneRadiusM(5000, 5000, WAVELENGTH_M * 2);
    expect(f1DoubleLambda).toBeCloseTo(f1 * Math.sqrt(2), 6);
  });

  test('Fresnel zone radius is symmetric in d1/d2', () => {
    expect(fresnelZoneRadiusM(3000, 7000, WAVELENGTH_M)).toBeCloseTo(fresnelZoneRadiusM(7000, 3000, WAVELENGTH_M), 9);
  });

  // The strongest possible verification: cross-check the NEW Fresnel-clearance
  // code against the EXISTING, already-verified fresnelKirchhoffParameter
  // rather than a second independent numeric authority. Since v = sqrt(2)*(h/F1)
  // algebraically, an obstruction height chosen to put v exactly at the
  // existing v<=-1 "clear" boundary must correspond to a fixed, computable
  // clearance percentage — proving the old and new code agree on the same
  // underlying geometry.
  test('the existing v<=-1 diffraction-clear boundary corresponds to ~70.7% Fresnel clearance', () => {
    const d1 = 5000, d2 = 5000;
    const f1 = fresnelZoneRadiusM(d1, d2, WAVELENGTH_M);
    const hAtVMinusOne = -f1 / Math.SQRT2; // solve v = sqrt(2)*(h/F1) = -1 for h
    const v = fresnelKirchhoffParameter(hAtVMinusOne, d1, d2, WAVELENGTH_M);
    expect(v).toBeCloseTo(-1, 3);
    const clearance = fresnelClearancePercent(hAtVMinusOne, f1);
    expect(clearance).toBeCloseTo(70.71, 1);
  });

  test('clearance is 0% when the obstruction sits exactly on the direct ray', () => {
    expect(fresnelClearancePercent(0, 28.86)).toBeCloseTo(0, 6);
  });

  test('clearance is negative when the obstruction pokes above the direct ray', () => {
    expect(fresnelClearancePercent(10, 28.86)).toBeLessThan(0);
  });

  describe('classifyLineOfSight', () => {
    test('default threshold is 60%', () => {
      expect(DEFAULT_FRESNEL_CLEARANCE_THRESHOLD_PERCENT).toBe(60);
    });

    test('clearance <= 0 is always nlos, regardless of threshold', () => {
      expect(classifyLineOfSight(0, 60)).toBe('nlos');
      expect(classifyLineOfSight(-5, 0)).toBe('nlos');
    });

    test('clearance >= threshold is los', () => {
      expect(classifyLineOfSight(70, 60)).toBe('los');
      expect(classifyLineOfSight(60, 60)).toBe('los'); // boundary is inclusive
    });

    test('clearance strictly between 0 and the threshold is partial', () => {
      expect(classifyLineOfSight(30, 60)).toBe('partial');
    });

    test('threshold=0 makes partial unreachable — every positive clearance is los', () => {
      expect(classifyLineOfSight(0.001, 0)).toBe('los');
      expect(classifyLineOfSight(100, 0)).toBe('los');
    });

    test('threshold=100 requires full clearance for los', () => {
      expect(classifyLineOfSight(99, 100)).toBe('partial');
      expect(classifyLineOfSight(100, 100)).toBe('los');
    });
  });
});
