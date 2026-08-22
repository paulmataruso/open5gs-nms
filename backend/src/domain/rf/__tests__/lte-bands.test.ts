import { earfcnToFrequencyMhz, frequencyMhzToEarfcn } from '../lte-bands';

describe('lte-bands', () => {
  const cases = [
    { band: 48, earfcn: 55440, expectedMhz: 3570 },
    { band: 42, earfcn: 41790, expectedMhz: 3420 },
    { band: 43, earfcn: 43790, expectedMhz: 3620 },
  ];

  for (const c of cases) {
    test(`band ${c.band} EARFCN ${c.earfcn} -> ${c.expectedMhz} MHz, and round-trips`, () => {
      const fwd = earfcnToFrequencyMhz(c.band, c.earfcn);
      expect(fwd.ok).toBe(true);
      if (fwd.ok) expect(fwd.frequencyMhz).toBeCloseTo(c.expectedMhz, 6);

      const inv = frequencyMhzToEarfcn(c.band, c.expectedMhz);
      expect(inv.ok).toBe(true);
      if (inv.ok) expect(inv.earfcn).toBe(c.earfcn);
    });
  }

  test('out-of-range EARFCN returns a structured error, not extrapolation', () => {
    const result = earfcnToFrequencyMhz(48, 99999);
    expect(result.ok).toBe(false);
  });

  test('unknown/unverified band returns a structured error rather than guessing', () => {
    const result = earfcnToFrequencyMhz(7, 2750);
    expect(result.ok).toBe(false);
  });
});
