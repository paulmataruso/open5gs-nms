import {
  resolveResourceGrid, computeRadioQuality, thermalNoiseDbm, thermalNoisePerResourceElementDbm,
  dbmToMilliwatts, milliwattsToDbm, sumDbm, classifyRadioQuality, isInterferenceLimited,
  defaultSubcarrierSpacingKhz, radioQualityEquation, SUBCARRIERS_PER_RESOURCE_BLOCK,
} from '../radio-quality';

describe('radio-quality resource grids', () => {
  test('LTE resource blocks match TS 36.101 Table 5.6-1', () => {
    expect(resolveResourceGrid('4g', 1.4).resourceBlocks).toBe(6);
    expect(resolveResourceGrid('4g', 5).resourceBlocks).toBe(25);
    expect(resolveResourceGrid('4g', 10).resourceBlocks).toBe(50);
    expect(resolveResourceGrid('4g', 20).resourceBlocks).toBe(100);
    expect(resolveResourceGrid('4g', 20).subcarrierSpacingKhz).toBe(15);
  });

  test('NR FR1 at 30 kHz SCS matches TS 38.101-1 — the CBRS n48 case', () => {
    // This is the correction that matters for this deployment: a reference
    // implementation assumed 120 kHz (FR2) for all NR.
    expect(resolveResourceGrid('5g', 20, 30).resourceBlocks).toBe(51);
    expect(resolveResourceGrid('5g', 40, 30).resourceBlocks).toBe(106);
    expect(resolveResourceGrid('5g', 100, 30).resourceBlocks).toBe(273);
  });

  test('NR FR2 at 120 kHz is still available for mmWave', () => {
    expect(resolveResourceGrid('5g', 100, 120).resourceBlocks).toBe(66);
    expect(resolveResourceGrid('5g', 400, 120).resourceBlocks).toBe(264);
  });

  test('30 kHz and 120 kHz disagree sharply at the same channel width', () => {
    // 273 vs 66 RB at 100 MHz — a ~6 dB error in the RSSI term if confused.
    const fr1 = resolveResourceGrid('5g', 100, 30).resourceBlocks;
    const fr2 = resolveResourceGrid('5g', 100, 120).resourceBlocks;
    expect(fr1 / fr2).toBeGreaterThan(4);
  });

  test('5G defaults to 30 kHz SCS (FR1), not mmWave numerology', () => {
    expect(defaultSubcarrierSpacingKhz('5g')).toBe(30);
    expect(defaultSubcarrierSpacingKhz('4g')).toBe(15);
    expect(resolveResourceGrid('5g', 20).resourceBlocks).toBe(51);
  });

  test('occupied subcarriers is 12 per resource block', () => {
    const grid = resolveResourceGrid('5g', 20, 30);
    expect(grid.occupiedSubcarriers).toBe(grid.resourceBlocks * SUBCARRIERS_PER_RESOURCE_BLOCK);
  });

  test('an invalid channel width is rejected with the valid set named', () => {
    expect(() => resolveResourceGrid('4g', 7)).toThrow(/1.4, 3, 5, 10, 15, 20/);
    expect(() => resolveResourceGrid('5g', 400, 30)).toThrow(/not valid at 30 kHz/);
  });
});

describe('radio-quality power maths', () => {
  test('dBm/mW round-trip', () => {
    expect(milliwattsToDbm(dbmToMilliwatts(-85))).toBeCloseTo(-85, 9);
    expect(dbmToMilliwatts(0)).toBeCloseTo(1, 9);
    expect(dbmToMilliwatts(-30)).toBeCloseTo(0.001, 12);
  });

  test('summing two equal powers adds 3 dB', () => {
    expect(sumDbm(-90, -90)).toBeCloseTo(-90 + 10 * Math.log10(2), 9);
  });

  test('thermal noise over 1 Hz is the -174 dBm/Hz reference', () => {
    expect(thermalNoiseDbm(1, 0)).toBeCloseTo(-174, 9);
  });

  test('ten times the bandwidth adds 10 dB of noise', () => {
    expect(thermalNoiseDbm(1e7, 0) - thermalNoiseDbm(1e6, 0)).toBeCloseTo(10, 9);
  });

  test('noise figure adds directly', () => {
    expect(thermalNoiseDbm(1e6, 7) - thermalNoiseDbm(1e6, 0)).toBeCloseTo(7, 9);
  });

  test('per-resource-element noise uses the subcarrier bandwidth', () => {
    // 30 kHz SCS -> 30000 Hz
    expect(thermalNoisePerResourceElementDbm(30, 0)).toBeCloseTo(thermalNoiseDbm(30000, 0), 9);
  });

  test('non-positive bandwidth returns NaN rather than a bogus number', () => {
    expect(Number.isNaN(thermalNoiseDbm(0, 0))).toBe(true);
    expect(Number.isNaN(thermalNoiseDbm(-1, 0))).toBe(true);
  });
});

describe('radio-quality metrics', () => {
  const grid = resolveResourceGrid('5g', 20, 30); // 51 RB, CBRS n48

  test('with no interferers SINR is the pure noise-limited ratio', () => {
    const r = computeRadioQuality({ rsrpDbm: -90, interfererRsrpDbm: [], grid, noiseFigureDb: 7 });
    expect(r.interferencePerReDbm).toBeNull();
    expect(r.sinrDb).toBeCloseTo(-90 - r.noisePerReDbm, 6);
  });

  test('adding an equal-power interferer drops SINR below the noise-only case', () => {
    const clean = computeRadioQuality({ rsrpDbm: -90, interfererRsrpDbm: [], grid, noiseFigureDb: 7 });
    const dirty = computeRadioQuality({ rsrpDbm: -90, interfererRsrpDbm: [-90], grid, noiseFigureDb: 7 });
    expect(dirty.sinrDb).toBeLessThan(clean.sinrDb);
  });

  test('load factor scales an interferer\'s contribution', () => {
    const full = computeRadioQuality({ rsrpDbm: -90, interfererRsrpDbm: [-90], grid, noiseFigureDb: 7, loadFactors: [1] });
    const light = computeRadioQuality({ rsrpDbm: -90, interfererRsrpDbm: [-90], grid, noiseFigureDb: 7, loadFactors: [0.1] });
    const idle = computeRadioQuality({ rsrpDbm: -90, interfererRsrpDbm: [-90], grid, noiseFigureDb: 7, loadFactors: [0] });
    expect(light.sinrDb).toBeGreaterThan(full.sinrDb);
    expect(idle.sinrDb).toBeGreaterThan(light.sinrDb);
  });

  test('a missing load factor defaults to fully loaded (conservative)', () => {
    const explicit = computeRadioQuality({ rsrpDbm: -90, interfererRsrpDbm: [-95], grid, noiseFigureDb: 7, loadFactors: [1] });
    const implied = computeRadioQuality({ rsrpDbm: -90, interfererRsrpDbm: [-95], grid, noiseFigureDb: 7 });
    expect(implied.sinrDb).toBeCloseTo(explicit.sinrDb, 9);
  });

  test('RSRQ stays within its physical ceiling of 1/12 (about -10.8 dB)', () => {
    // RSRQ = N_RB*P / (12*N_RB*(P+I+N)); with I,N -> 0 the limit is 1/12.
    const r = computeRadioQuality({ rsrpDbm: -50, interfererRsrpDbm: [], grid, noiseFigureDb: 0 });
    expect(r.rsrqDb).toBeLessThanOrEqual(10 * Math.log10(1 / 12) + 1e-6);
  });

  test('RSSI is above RSRP because it spans all occupied subcarriers', () => {
    const r = computeRadioQuality({ rsrpDbm: -90, interfererRsrpDbm: [], grid, noiseFigureDb: 7 });
    expect(r.rssiDbm).toBeGreaterThan(r.rsrpDbm);
  });

  test('quality classes and the interference-limited distinction', () => {
    const unusable = computeRadioQuality({ rsrpDbm: -120, interfererRsrpDbm: [], grid, noiseFigureDb: 7 });
    expect(classifyRadioQuality(unusable)).toBe('unusable');
    expect(isInterferenceLimited(unusable)).toBe(false);

    // Strong serving signal swamped by a stronger neighbour: coverage fine,
    // quality ruined — the case a plain coverage map cannot show.
    const jammed = computeRadioQuality({ rsrpDbm: -80, interfererRsrpDbm: [-70, -72], grid, noiseFigureDb: 7 });
    expect(jammed.sinrDb).toBeLessThan(0);
    expect(isInterferenceLimited(jammed)).toBe(true);
    expect(classifyRadioQuality(jammed)).toBe('poor');

    const good = computeRadioQuality({ rsrpDbm: -75, interfererRsrpDbm: [], grid, noiseFigureDb: 7 });
    expect(classifyRadioQuality(good)).toBe('good');
  });

  test('equation record names the grid actually used', () => {
    const r = computeRadioQuality({ rsrpDbm: -90, interfererRsrpDbm: [], grid, noiseFigureDb: 7 });
    const eq = radioQualityEquation(r);
    expect(eq.variables.N_RB.value).toBe(51);
    expect(eq.variables.SCS.value).toBe(30);
    expect(eq.applicableConditions).toContain('NR SS');
  });
});
