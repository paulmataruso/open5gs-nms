import { dbmToWatts, wattsToDbm, sumPowersDbm } from '../units';

describe('units', () => {
  test('dbmToWatts(30) === 1 (30 dBm = 1 W)', () => {
    expect(dbmToWatts(30)).toBeCloseTo(1, 6);
  });

  test('dbmToWatts(0) === 0.001 (0 dBm = 1 mW)', () => {
    expect(dbmToWatts(0)).toBeCloseTo(0.001, 6);
  });

  test('wattsToDbm(2) ≈ 33.0103', () => {
    expect(wattsToDbm(2)).toBeCloseTo(33.0103, 3);
  });

  test('sumPowersDbm(-50, -50) ≈ -46.9897 — proves linear-domain summation, not naive dBm add', () => {
    const result = sumPowersDbm(-50, -50);
    expect(result).toBeCloseTo(-46.9897, 3);
    expect(Math.abs(result - -100)).toBeGreaterThan(1); // not a naive dBm sum
    expect(Math.abs(result - -50)).toBeGreaterThan(1);  // not a no-op
  });
});
