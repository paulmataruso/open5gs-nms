import { hataPathLossDb, cost231HataPathLossDb } from '../hata-model';

describe('hata-model', () => {
  test('urban Hata path loss is a real, positive number for a typical macro-cell scenario', () => {
    const r = hataPathLossDb(900, 50, 1.5, 5, 'urban');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pathLossDb).toBeGreaterThan(0);
      expect(Number.isFinite(r.pathLossDb)).toBe(true);
    }
  });

  test('suburban and open-area path loss are both lower than urban for the same inputs', () => {
    const urban = hataPathLossDb(900, 50, 1.5, 5, 'urban');
    const suburban = hataPathLossDb(900, 50, 1.5, 5, 'suburban');
    const open = hataPathLossDb(900, 50, 1.5, 5, 'open');
    expect(urban.ok && suburban.ok && open.ok).toBe(true);
    if (urban.ok && suburban.ok && open.ok) {
      expect(suburban.pathLossDb).toBeLessThan(urban.pathLossDb);
      expect(open.pathLossDb).toBeLessThan(suburban.pathLossDb);
    }
  });

  test('path loss increases with distance', () => {
    const near = hataPathLossDb(900, 50, 1.5, 2, 'urban');
    const far = hataPathLossDb(900, 50, 1.5, 8, 'urban');
    expect(near.ok && far.ok).toBe(true);
    if (near.ok && far.ok) expect(far.pathLossDb).toBeGreaterThan(near.pathLossDb);
  });

  test('frequency outside [150,1500] MHz is a structured error, not extrapolation', () => {
    const tooLow = hataPathLossDb(100, 50, 1.5, 5, 'urban');
    const tooHigh = hataPathLossDb(2000, 50, 1.5, 5, 'urban');
    expect(tooLow.ok).toBe(false);
    expect(tooHigh.ok).toBe(false);
  });

  test('base station height outside [30,200] m is a structured error', () => {
    const r = hataPathLossDb(900, 10, 1.5, 5, 'urban');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toMatch(/txHeightM/);
  });

  test('distance outside [1,10] km is a structured error', () => {
    const r = hataPathLossDb(900, 50, 1.5, 15, 'urban');
    expect(r.ok).toBe(false);
  });

  test('COST-231-Hata path loss is a real positive number, and metropolitan adds exactly the 3 dB Cm over medium city', () => {
    const medium = cost231HataPathLossDb(1800, 50, 1.5, 5, 'medium');
    const metro = cost231HataPathLossDb(1800, 50, 1.5, 5, 'metropolitan');
    expect(medium.ok && metro.ok).toBe(true);
    if (medium.ok && metro.ok) {
      expect(medium.pathLossDb).toBeGreaterThan(0);
      expect(metro.pathLossDb - medium.pathLossDb).toBeCloseTo(3, 6);
    }
  });

  test('COST-231-Hata frequency outside [1500,2000] MHz is a structured error', () => {
    const r = cost231HataPathLossDb(900, 50, 1.5, 5, 'medium');
    expect(r.ok).toBe(false);
  });

  test('COST-231-Hata distance outside [1,20] km is a structured error', () => {
    const r = cost231HataPathLossDb(1800, 50, 1.5, 25, 'medium');
    expect(r.ok).toBe(false);
  });
});
