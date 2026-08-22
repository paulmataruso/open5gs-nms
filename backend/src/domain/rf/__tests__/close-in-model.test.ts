import { fspl1mDb, closeInPathLossDb, UMI_SC_LOS_PLE, UMI_SC_NLOS_PLE } from '../close-in-model';
import { fsplDb } from '../pathloss-fspl';

describe('close-in-model', () => {
  test('fspl1mDb matches the canonical FSPL formula evaluated at d=1m', () => {
    const freqHz = 3_550_000_000; // CBRS band
    expect(fspl1mDb(freqHz)).toBeCloseTo(fsplDb(1, freqHz), 6);
  });

  test('with the free-space exponent (n=2), the CI model reduces to plain FSPL at any distance', () => {
    const freqHz = 1_900_000_000;
    for (const d of [10, 100, 1000, 5000]) {
      expect(closeInPathLossDb(d, freqHz, 2)).toBeCloseTo(fsplDb(d, freqHz), 6);
    }
  });

  test('a higher path-loss exponent produces more loss at the same distance', () => {
    const freqHz = 3_550_000_000;
    const los = closeInPathLossDb(500, freqHz, UMI_SC_LOS_PLE);
    const nlos = closeInPathLossDb(500, freqHz, UMI_SC_NLOS_PLE);
    expect(nlos).toBeGreaterThan(los);
  });

  test('is valid at CBRS frequency (3.5 GHz) and a short-tower height regime with no restriction error path', () => {
    // The whole point of this model: no height/frequency validity check to fail.
    const freqHz = 3_550_000_000;
    const loss = closeInPathLossDb(2000, freqHz, UMI_SC_NLOS_PLE);
    expect(Number.isFinite(loss)).toBe(true);
    expect(loss).toBeGreaterThan(0);
  });

  test('path loss increases with distance for a fixed exponent', () => {
    const freqHz = 3_550_000_000;
    const near = closeInPathLossDb(100, freqHz, UMI_SC_NLOS_PLE);
    const far = closeInPathLossDb(1000, freqHz, UMI_SC_NLOS_PLE);
    expect(far).toBeGreaterThan(near);
  });
});
