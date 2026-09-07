import { EARTH_CURVATURE_K_FACTOR_STANDARD, effectiveEarthRadiusM, earthCurvatureBulgeM } from '../earth-curvature';
import { EARTH_RADIUS_M } from '../geometry';

describe('earth-curvature', () => {
  test('k=1 is a no-op on effective Earth radius', () => {
    expect(effectiveEarthRadiusM(1)).toBe(EARTH_RADIUS_M);
  });

  test('standard k-factor is 4/3', () => {
    expect(EARTH_CURVATURE_K_FACTOR_STANDARD).toBeCloseTo(4 / 3, 10);
  });

  test('curvature bulge for d1=d2=15km at k=4/3 matches the standard "d1(km)*d2(km)/(12.75*k)" engineering rule-of-thumb', () => {
    const reM = effectiveEarthRadiusM(4 / 3);
    const bulgeM = earthCurvatureBulgeM(15_000, 15_000, reM);
    const ruleOfThumbM = (15 * 15) / (12.75 * (4 / 3)); // classic km-based approximation for the 6371km mean radius
    expect(bulgeM).toBeCloseTo(ruleOfThumbM, 1);
    expect(bulgeM).toBeCloseTo(13.24, 1);
  });

  test('a larger k-factor (more curvature benefit) produces a smaller bulge than k=1 for the same geometry', () => {
    const bulgeK1 = earthCurvatureBulgeM(15_000, 15_000, effectiveEarthRadiusM(1));
    const bulgeK43 = earthCurvatureBulgeM(15_000, 15_000, effectiveEarthRadiusM(4 / 3));
    expect(bulgeK43).toBeLessThan(bulgeK1);
  });

  test('bulge is symmetric in d1/d2 and scales roughly with the product of the distances', () => {
    const reM = effectiveEarthRadiusM(4 / 3);
    expect(earthCurvatureBulgeM(10_000, 20_000, reM)).toBeCloseTo(earthCurvatureBulgeM(20_000, 10_000, reM), 9);
    expect(earthCurvatureBulgeM(20_000, 20_000, reM)).toBeCloseTo(earthCurvatureBulgeM(10_000, 10_000, reM) * 4, 6);
  });
});
