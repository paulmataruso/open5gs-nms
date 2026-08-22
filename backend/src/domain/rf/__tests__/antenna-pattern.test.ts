import {
  horizontalPatternLossDb, verticalPatternLossDb, combinedPatternLossDb, directionalAntennaGainDb,
} from '../antenna-pattern';

describe('antenna-pattern', () => {
  test('on boresight (zero offset) has zero pattern loss', () => {
    expect(horizontalPatternLossDb(0, 65, 20)).toBe(0);
    expect(verticalPatternLossDb(0, 10, 20)).toBe(0);
  });

  test('offset = beamwidth/2 loses exactly 3 dB, per 12*(0.5)^2 = 3', () => {
    expect(horizontalPatternLossDb(32.5, 65, 20)).toBeCloseTo(3, 6);
    expect(verticalPatternLossDb(5, 10, 20)).toBeCloseTo(3, 6);
  });

  test('offset well beyond the pattern clamps at the front-to-back/sidelobe cap', () => {
    expect(horizontalPatternLossDb(180, 65, 20)).toBe(20);
    expect(verticalPatternLossDb(90, 10, 20)).toBe(20);
  });

  test('azimuth offset normalizes correctly around the ±180 wrap', () => {
    // 350 degrees off is equivalent to -10 degrees off — should match.
    expect(horizontalPatternLossDb(350, 65, 20)).toBeCloseTo(horizontalPatternLossDb(-10, 65, 20), 6);
  });

  test('combined loss is the sum of horizontal+vertical, capped at Am', () => {
    expect(combinedPatternLossDb(3, 3, 20)).toBeCloseTo(6, 6);
    expect(combinedPatternLossDb(15, 15, 20)).toBe(20);
  });

  test('directional gain subtracts pattern loss from peak gain', () => {
    expect(directionalAntennaGainDb(17, 6)).toBeCloseTo(11, 6);
    expect(directionalAntennaGainDb(17, 0)).toBe(17);
  });
});
