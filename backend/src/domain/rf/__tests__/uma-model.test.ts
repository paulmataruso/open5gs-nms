import {
  umaLosPathLossDb, umaNlosPathLossDb, umaPathLossDb, umaBreakpointDistanceM,
  slantDistanceM, umaApplicability, umaEquation, UMA_FREQ_RANGE_GHZ,
} from '../uma-model';

describe('uma-model (3GPP TR 38.901 Table 7.4.1-1)', () => {
  // CBRS B48/n48 reference case for this deployment.
  const F = 3.6, H_TX = 25, H_RX = 1.5;

  test('breakpoint distance follows 4*h_tx\'*h_rx\'*f_c/c', () => {
    // h'_tx = 24, h'_rx = 0.5, f = 3.6e9 -> 4*24*0.5*3.6e9/3e8 = 576 m
    expect(umaBreakpointDistanceM(F, H_TX, H_RX)).toBeCloseTo(576, 6);
  });

  test('slant distance includes the height difference, not just ground range', () => {
    // 100 m ground, 23.5 m height delta
    expect(slantDistanceM(100, H_TX, H_RX)).toBeCloseTo(Math.hypot(100, 23.5), 6);
    expect(slantDistanceM(100, H_TX, H_RX)).toBeGreaterThan(100);
  });

  test('LOS below the breakpoint uses the single-slope branch', () => {
    const d = 100;
    const d3d = slantDistanceM(d, H_TX, H_RX);
    const expected = 28 + 22 * Math.log10(d3d) + 20 * Math.log10(F);
    expect(umaLosPathLossDb(d, F, H_TX, H_RX)).toBeCloseTo(expected, 6);
  });

  test('LOS beyond the breakpoint switches to the dual-slope branch', () => {
    const below = umaLosPathLossDb(500, F, H_TX, H_RX);
    const above = umaLosPathLossDb(700, F, H_TX, H_RX);
    // The 700 m point is past the 576 m breakpoint, so it must use PL2 and
    // therefore be strictly greater than a single-slope extrapolation would be.
    const singleSlopeAt700 = 28 + 22 * Math.log10(slantDistanceM(700, H_TX, H_RX)) + 20 * Math.log10(F);
    expect(above).toBeGreaterThan(singleSlopeAt700);
    expect(above).toBeGreaterThan(below);
  });

  test('NLOS is always at least the LOS loss — the mandatory floor', () => {
    // At short range the raw NLOS expression dips below LOS; without the
    // max() clamp this produces a physically impossible bright spot.
    for (const d of [10, 20, 50, 100, 300, 1000, 3000]) {
      const los = umaLosPathLossDb(d, F, H_TX, H_RX);
      const nlos = umaNlosPathLossDb(d, F, H_TX, H_RX);
      expect(nlos).toBeGreaterThanOrEqual(los);
    }
  });

  test('NLOS exceeds LOS at typical planning range', () => {
    expect(umaNlosPathLossDb(300, F, H_TX, H_RX)).toBeGreaterThan(umaLosPathLossDb(300, F, H_TX, H_RX));
  });

  test('loss increases monotonically with distance and with frequency', () => {
    let previous = -Infinity;
    for (const d of [10, 50, 100, 200, 400, 800, 1600]) {
      const value = umaPathLossDb(d, F, H_TX, H_RX, 'nlos');
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
    expect(umaPathLossDb(200, 28, H_TX, H_RX, 'los')).toBeGreaterThan(umaPathLossDb(200, 3.6, H_TX, H_RX, 'los'));
  });

  test('distance of zero stays finite rather than -Infinity', () => {
    expect(Number.isFinite(umaPathLossDb(0, F, H_TX, H_RX, 'los'))).toBe(true);
    expect(Number.isFinite(umaPathLossDb(0, F, H_TX, H_RX, 'nlos'))).toBe(true);
  });

  test('CBRS 3.6 GHz is inside the model envelope; 140 GHz is not', () => {
    expect(umaApplicability(300, 3.6, H_TX, H_RX).applicable).toBe(true);
    expect(umaApplicability(300, 140, H_TX, H_RX).applicable).toBe(false);
    expect(UMA_FREQ_RANGE_GHZ[1]).toBe(100);
  });

  test('applicability warns rather than throws on out-of-range input', () => {
    const tooClose = umaApplicability(5, F, H_TX, H_RX);
    expect(tooClose.applicable).toBe(false);
    expect(tooClose.warnings.join(' ')).toMatch(/below UMa's 10 m minimum/);
    // Still computes a number — a planner can see it, just flagged.
    expect(Number.isFinite(umaPathLossDb(5, F, H_TX, H_RX, 'los'))).toBe(true);
  });

  test('a receiver above the transmitter is flagged', () => {
    expect(umaApplicability(100, F, 5, 10).warnings.join(' ')).toMatch(/not above receiver height/);
  });

  test('equation record reports the branch actually used', () => {
    expect(umaEquation(100, F, H_TX, H_RX, 'los').formula).toContain('22·log10');
    expect(umaEquation(700, F, H_TX, H_RX, 'los').formula).toContain('40·log10');
    expect(umaEquation(100, F, H_TX, H_RX, 'nlos').formula).toContain('max(PL_LOS');
    expect(umaEquation(100, F, H_TX, H_RX, 'los').source).toContain('38.901');
  });
});
