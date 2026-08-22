import { fresnelKirchhoffParameter, knifeEdgeDiffractionLossDb, computeDiffractionLossDb, TerrainProfilePoint } from '../diffraction';

describe('diffraction', () => {
  test('Fresnel-Kirchhoff parameter: zero obstruction height gives v=0', () => {
    expect(fresnelKirchhoffParameter(0, 1000, 1000, 0.15)).toBe(0);
  });

  test('Fresnel-Kirchhoff parameter scales with obstruction height', () => {
    const v1 = fresnelKirchhoffParameter(10, 1000, 1000, 0.15);
    const v2 = fresnelKirchhoffParameter(20, 1000, 1000, 0.15);
    expect(v2).toBeCloseTo(v1 * 2, 6); // linear in h
  });

  test('knife-edge loss at v=0 (grazing incidence) is the standard +6.02 dB reference value', () => {
    expect(knifeEdgeDiffractionLossDb(0)).toBeCloseTo(-20 * Math.log10(0.5), 6);
    expect(knifeEdgeDiffractionLossDb(0)).toBeCloseTo(6.02, 2);
  });

  test('knife-edge loss is zero for v <= -1 (clear line of sight)', () => {
    expect(knifeEdgeDiffractionLossDb(-1)).toBe(0);
    expect(knifeEdgeDiffractionLossDb(-5)).toBe(0);
  });

  test('knife-edge loss increases monotonically with v beyond the grazing point', () => {
    const losses = [0, 0.5, 1, 1.5, 2, 2.4, 3, 5].map(knifeEdgeDiffractionLossDb);
    for (let i = 1; i < losses.length; i++) {
      expect(losses[i]).toBeGreaterThanOrEqual(losses[i - 1]);
    }
  });

  const FREQ_HZ = 1_900_000_000; // 1.9 GHz

  test('a perfectly flat profile (no obstruction) is line-of-sight with zero loss', () => {
    const profile: TerrainProfilePoint[] = Array.from({ length: 10 }, (_, i) => ({ distanceM: i * 100, elevationM: 0 }));
    const result = computeDiffractionLossDb(profile, 30, 1.5, FREQ_HZ);
    expect(result.isLineOfSight).toBe(true);
    expect(result.totalLossDb).toBe(0);
    expect(result.dominantEdgeIndex).toBeNull();
  });

  test('a single sharp ridge well above the direct line blocks line-of-sight and produces real loss', () => {
    const profile: TerrainProfilePoint[] = [
      { distanceM: 0, elevationM: 0 },
      { distanceM: 250, elevationM: 0 },
      { distanceM: 500, elevationM: 100 }, // a 100m ridge halfway between a 30m TX and a 1.5m RX
      { distanceM: 750, elevationM: 0 },
      { distanceM: 1000, elevationM: 0 },
    ];
    const result = computeDiffractionLossDb(profile, 30, 1.5, FREQ_HZ);
    expect(result.isLineOfSight).toBe(false);
    expect(result.totalLossDb).toBeGreaterThan(0);
    expect(result.dominantEdgeIndex).toBe(2);
  });

  test('a taller obstruction produces more loss than a shorter one at the same location', () => {
    const makeProfile = (ridgeHeightM: number): TerrainProfilePoint[] => [
      { distanceM: 0, elevationM: 0 },
      { distanceM: 500, elevationM: ridgeHeightM },
      { distanceM: 1000, elevationM: 0 },
    ];
    const shortRidge = computeDiffractionLossDb(makeProfile(50), 30, 1.5, FREQ_HZ);
    const tallRidge = computeDiffractionLossDb(makeProfile(150), 30, 1.5, FREQ_HZ);
    expect(tallRidge.totalLossDb).toBeGreaterThan(shortRidge.totalLossDb);
  });

  test('Deygout multi-edge: two real obstructions produce more total loss than either alone', () => {
    const twoObstructions: TerrainProfilePoint[] = [
      { distanceM: 0, elevationM: 0 },
      { distanceM: 300, elevationM: 80 },
      { distanceM: 600, elevationM: 0 },
      { distanceM: 900, elevationM: 90 },
      { distanceM: 1200, elevationM: 0 },
    ];
    const oneObstructionOnly: TerrainProfilePoint[] = [
      { distanceM: 0, elevationM: 0 },
      { distanceM: 300, elevationM: 80 },
      { distanceM: 600, elevationM: 0 },
      { distanceM: 900, elevationM: 0 },
      { distanceM: 1200, elevationM: 0 },
    ];
    const both = computeDiffractionLossDb(twoObstructions, 30, 1.5, FREQ_HZ);
    const single = computeDiffractionLossDb(oneObstructionOnly, 30, 1.5, FREQ_HZ);
    expect(both.totalLossDb).toBeGreaterThan(single.totalLossDb);
  });

  test('a profile with fewer than 2 points is treated as clear line-of-sight, not an error', () => {
    const result = computeDiffractionLossDb([{ distanceM: 0, elevationM: 0 }], 30, 1.5, FREQ_HZ);
    expect(result.isLineOfSight).toBe(true);
    expect(result.totalLossDb).toBe(0);
  });
});
