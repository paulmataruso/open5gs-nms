import { calculateLinkBudget } from '../linkbudget';
import { fsplDb } from '../pathloss-fspl';

describe('linkbudget', () => {
  test('full chain is internally consistent with independently-computed EIRP and FSPL', () => {
    const distanceM = 1000, frequencyMhz = 1900;
    const result = calculateLinkBudget({
      txPowerDbm: 40, cableLossDb: 2, connectorLossDb: 0.5, antennaGainDbi: 17,
      frequencyMhz, distanceM, buildingLossDb: 12, foliageLossDb: 0, ueAntennaGainDbi: 0,
    });
    expect(result.ok).toBe(true);
    const expectedEirp = 40 - 2 - 0.5 + 17; // 54.5, matches the spec's own worked example
    const expectedPathLoss = fsplDb(distanceM, frequencyMhz * 1_000_000);
    const expectedRx = expectedEirp - expectedPathLoss - 12 - 0 - 0 + 0;
    expect(result.result!.eirpDbm).toBeCloseTo(expectedEirp, 6);
    expect(result.result!.pathLossDb).toBeCloseTo(expectedPathLoss, 6);
    expect(result.result!.totalReceivedPowerDbm).toBeCloseTo(expectedRx, 6);
  });

  test('missing optional inputs default to 0 and are flagged as assumptions, not silently applied', () => {
    const result = calculateLinkBudget({
      txPowerDbm: 40, cableLossDb: 2, connectorLossDb: 0.5, antennaGainDbi: 17,
      frequencyMhz: 1900, distanceM: 1000,
    });
    expect(result.ok).toBe(true);
    expect(result.assumptions.some(a => a.parameter === 'buildingLossDb')).toBe(true);
    expect(result.assumptions.some(a => a.parameter === 'foliageLossDb')).toBe(true);
  });

  test('the received-power result carries a warning distinguishing it from RSRP', () => {
    const result = calculateLinkBudget({
      txPowerDbm: 40, cableLossDb: 2, connectorLossDb: 0.5, antennaGainDbi: 17,
      frequencyMhz: 1900, distanceM: 1000,
    });
    expect(result.warnings.some(w => w.code === 'NOT_RSRP')).toBe(true);
  });

  test('missing frequency and band/earfcn returns a structured error, not a guess', () => {
    const result = calculateLinkBudget({
      txPowerDbm: 40, cableLossDb: 2, connectorLossDb: 0.5, antennaGainDbi: 17, distanceM: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.missingInputs.length).toBeGreaterThan(0);
  });

  test('band+earfcn resolves frequency correctly (Band 48, EARFCN 55440 -> 3570 MHz)', () => {
    const result = calculateLinkBudget({
      txPowerDbm: 40, cableLossDb: 2, connectorLossDb: 0.5, antennaGainDbi: 17,
      band: 48, earfcn: 55440, distanceM: 1000,
    });
    expect(result.ok).toBe(true);
    const expectedPathLoss = fsplDb(1000, 3570 * 1_000_000);
    expect(result.result!.pathLossDb).toBeCloseTo(expectedPathLoss, 6);
  });

  test('propagationModel "hata" uses the Hata path-loss model instead of FSPL, given real antenna heights', () => {
    const result = calculateLinkBudget({
      txPowerDbm: 40, cableLossDb: 2, connectorLossDb: 0.5, antennaGainDbi: 17,
      frequencyMhz: 900, distanceM: 5000, propagationModel: 'hata',
      txHeightM: 50, rxHeightM: 1.5, environment: 'urban',
    });
    expect(result.ok).toBe(true);
    expect(result.model).toContain('Hata');
    // Hata path loss at 5km/900MHz should be a real, large positive number
    // (Hata models real clutter, not just geometric spreading), and
    // meaningfully different from what FSPL alone would give at the same
    // distance/frequency.
    const fsplOnly = fsplDb(5000, 900 * 1_000_000);
    expect(result.result!.pathLossDb).toBeGreaterThan(0);
    expect(Math.abs(result.result!.pathLossDb - fsplOnly)).toBeGreaterThan(1);
  });

  test('propagationModel "hata" without txHeightM/rxHeightM is a structured error, not a crash', () => {
    const result = calculateLinkBudget({
      txPowerDbm: 40, cableLossDb: 2, connectorLossDb: 0.5, antennaGainDbi: 17,
      frequencyMhz: 900, distanceM: 5000, propagationModel: 'hata',
    });
    expect(result.ok).toBe(false);
    expect(result.error?.missingInputs).toEqual(expect.arrayContaining(['txHeightM', 'rxHeightM']));
  });

  test('propagationModel "cost231-hata" is selectable and produces a real path loss', () => {
    const result = calculateLinkBudget({
      txPowerDbm: 40, cableLossDb: 2, connectorLossDb: 0.5, antennaGainDbi: 17,
      frequencyMhz: 1800, distanceM: 5000, propagationModel: 'cost231-hata',
      txHeightM: 50, rxHeightM: 1.5, cityType: 'metropolitan',
    });
    expect(result.ok).toBe(true);
    expect(result.model).toContain('COST-231');
    expect(result.result!.pathLossDb).toBeGreaterThan(0);
  });

  test('propagationModel "close-in" works at CBRS frequency (3.5 GHz) and a short-tower height Hata/COST-231-Hata would reject', () => {
    const result = calculateLinkBudget({
      txPowerDbm: 30, cableLossDb: 1, connectorLossDb: 0.5, antennaGainDbi: 10,
      frequencyMhz: 3550, distanceM: 800, propagationModel: 'close-in',
      isLineOfSight: false,
    });
    expect(result.ok).toBe(true);
    expect(result.model).toContain('Close-In');
    expect(result.result!.pathLossDb).toBeGreaterThan(0);
  });

  test('propagationModel "close-in" defaults to the conservative NLOS exponent when isLineOfSight is omitted, and flags it as an assumption', () => {
    const withDefault = calculateLinkBudget({
      txPowerDbm: 30, cableLossDb: 1, connectorLossDb: 0.5, antennaGainDbi: 10,
      frequencyMhz: 3550, distanceM: 800, propagationModel: 'close-in',
    });
    const explicitNlos = calculateLinkBudget({
      txPowerDbm: 30, cableLossDb: 1, connectorLossDb: 0.5, antennaGainDbi: 10,
      frequencyMhz: 3550, distanceM: 800, propagationModel: 'close-in', isLineOfSight: false,
    });
    expect(withDefault.ok).toBe(true);
    expect(withDefault.assumptions.some(a => a.parameter === 'isLineOfSight')).toBe(true);
    expect(withDefault.result!.pathLossDb).toBeCloseTo(explicitNlos.result!.pathLossDb, 6);
  });

  test('propagationModel "close-in" LOS predicts less loss than NLOS at the same distance', () => {
    const los = calculateLinkBudget({
      txPowerDbm: 30, cableLossDb: 1, connectorLossDb: 0.5, antennaGainDbi: 10,
      frequencyMhz: 3550, distanceM: 800, propagationModel: 'close-in', isLineOfSight: true,
    });
    const nlos = calculateLinkBudget({
      txPowerDbm: 30, cableLossDb: 1, connectorLossDb: 0.5, antennaGainDbi: 10,
      frequencyMhz: 3550, distanceM: 800, propagationModel: 'close-in', isLineOfSight: false,
    });
    expect(los.ok && nlos.ok).toBe(true);
    expect(los.result!.pathLossDb).toBeLessThan(nlos.result!.pathLossDb);
  });

  test('propagationModel "close-in" accepts a caller-supplied exponent override', () => {
    const result = calculateLinkBudget({
      txPowerDbm: 30, cableLossDb: 1, connectorLossDb: 0.5, antennaGainDbi: 10,
      frequencyMhz: 3550, distanceM: 800, propagationModel: 'close-in', pathLossExponent: 2.5,
    });
    expect(result.ok).toBe(true);
    expect(result.assumptions.some(a => a.parameter === 'isLineOfSight')).toBe(false);
  });
});
