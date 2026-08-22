import { haversineDistanceM, initialBearingDeg } from '../geometry';

describe('geometry', () => {
  test('1 degree of latitude at the equator ≈ 111.19 km (standard reference figure)', () => {
    const d = haversineDistanceM(0, 0, 1, 0);
    expect(d / 1000).toBeCloseTo(111.19, 0);
  });

  test('bearing due north is 0 degrees', () => {
    expect(initialBearingDeg(0, 0, 1, 0)).toBeCloseTo(0, 1);
  });

  test('bearing due east is 90 degrees', () => {
    expect(initialBearingDeg(0, 0, 0, 1)).toBeCloseTo(90, 1);
  });

  test('bearing due south is 180 degrees', () => {
    expect(initialBearingDeg(1, 0, 0, 0)).toBeCloseTo(180, 1);
  });
});
