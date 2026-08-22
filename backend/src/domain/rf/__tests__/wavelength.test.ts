import { wavelengthMeters } from '../wavelength';

describe('wavelength', () => {
  test('wavelengthMeters(1900 MHz) ≈ 0.157785 m', () => {
    expect(wavelengthMeters(1_900_000_000)).toBeCloseTo(0.157785, 5);
  });

  test('wavelengthMeters(3550 MHz, Band 48 center) ≈ 0.084448 m', () => {
    expect(wavelengthMeters(3_550_000_000)).toBeCloseTo(0.084448, 5);
  });
});
