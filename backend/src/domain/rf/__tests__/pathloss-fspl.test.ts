import { fsplDb, fsplDbKmMhz, fsplDbMilesMhz } from '../pathloss-fspl';

describe('pathloss-fspl', () => {
  test('1 km @ 1 GHz ≈ 92.45 dB (widely-cited reference figure)', () => {
    expect(fsplDb(1000, 1e9)).toBeCloseTo(92.45, 1);
  });

  test('km/MHz display wrapper agrees with the SI canonical form to <0.01 dB', () => {
    const si = fsplDb(1000, 1e9);
    const km = fsplDbKmMhz(1, 1000);
    expect(Math.abs(si - km)).toBeLessThan(0.01);
  });

  test('miles/MHz display wrapper agrees with the SI canonical form to <0.01 dB', () => {
    const si = fsplDb(1609.344, 1e9);
    const mi = fsplDbMilesMhz(1, 1000);
    expect(Math.abs(si - mi)).toBeLessThan(0.01);
  });
});
