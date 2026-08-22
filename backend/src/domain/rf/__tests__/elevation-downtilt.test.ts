import { elevationAngleDeg, geometricDowntiltDeg } from '../elevation-downtilt';

describe('elevation-downtilt', () => {
  test('elevationAngleDeg matches an independently-computed atan2', () => {
    // 30m antenna, 1.5m target => heightDiff = 1.5 - 30 = -28.5
    const angle = elevationAngleDeg(-28.5, 500);
    const expected = Math.atan2(-28.5, 500) * (180 / Math.PI);
    expect(angle).toBeCloseTo(expected, 6);
    expect(angle).toBeCloseTo(-3.26, 1);
  });

  test('geometricDowntiltDeg matches an independently-computed atan2', () => {
    const tilt = geometricDowntiltDeg(30, 1.5, 100);
    const expected = Math.atan2(28.5, 100) * (180 / Math.PI);
    expect(tilt).toBeCloseTo(expected, 6);
    expect(tilt).toBeCloseTo(15.92, 1);
  });

  test('target above site gives a negative (upward) downtilt', () => {
    const tilt = geometricDowntiltDeg(10, 50, 200);
    expect(tilt).toBeLessThan(0);
  });
});
