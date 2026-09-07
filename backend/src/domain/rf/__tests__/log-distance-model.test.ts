import { logDistancePathLossDb, LOG_DISTANCE_ENVIRONMENT_PRESETS } from '../log-distance-model';
import { fsplDb } from '../pathloss-fspl';
import { computeBasePathLossDb } from '../site-signal';
import { calculateLinkBudget } from '../linkbudget';

describe('log-distance-model', () => {
  const FREQ_HZ = 1_900_000_000;
  const FREQ_MHZ = 1900;

  test('free-space preset (n=2.0) reduces exactly to plain FSPL at any distance', () => {
    const n = LOG_DISTANCE_ENVIRONMENT_PRESETS['free-space'].pathLossExponent;
    for (const d of [10, 100, 1000, 5000]) {
      expect(logDistancePathLossDb(d, FREQ_HZ, n)).toBeCloseTo(fsplDb(d, FREQ_HZ), 6);
    }
  });

  test('presets are monotonically increasing: indoor < free-space < urban < dense-urban', () => {
    const d = 1000;
    const indoor = logDistancePathLossDb(d, FREQ_HZ, LOG_DISTANCE_ENVIRONMENT_PRESETS.indoor.pathLossExponent);
    const freeSpace = logDistancePathLossDb(d, FREQ_HZ, LOG_DISTANCE_ENVIRONMENT_PRESETS['free-space'].pathLossExponent);
    const urban = logDistancePathLossDb(d, FREQ_HZ, LOG_DISTANCE_ENVIRONMENT_PRESETS.urban.pathLossExponent);
    const denseUrban = logDistancePathLossDb(d, FREQ_HZ, LOG_DISTANCE_ENVIRONMENT_PRESETS['dense-urban'].pathLossExponent);
    expect(indoor).toBeLessThan(freeSpace);
    expect(freeSpace).toBeLessThan(urban);
    expect(urban).toBeLessThan(denseUrban);
  });

  test('rural and suburban presets are explicitly flagged unverified', () => {
    expect(LOG_DISTANCE_ENVIRONMENT_PRESETS.rural.verified).toBe(false);
    expect(LOG_DISTANCE_ENVIRONMENT_PRESETS.suburban.verified).toBe(false);
  });

  test('urban, dense-urban, indoor, and free-space presets are verified (cited)', () => {
    expect(LOG_DISTANCE_ENVIRONMENT_PRESETS.urban.verified).toBe(true);
    expect(LOG_DISTANCE_ENVIRONMENT_PRESETS['dense-urban'].verified).toBe(true);
    expect(LOG_DISTANCE_ENVIRONMENT_PRESETS.indoor.verified).toBe(true);
    expect(LOG_DISTANCE_ENVIRONMENT_PRESETS['free-space'].verified).toBe(true);
  });

  test('an explicit pathLossExponent override always wins over the environment preset (linkbudget.ts)', () => {
    const result = calculateLinkBudget({
      txPowerDbm: 40, cableLossDb: 2, connectorLossDb: 0.5, antennaGainDbi: 17,
      distanceM: 1000, frequencyMhz: FREQ_MHZ,
      propagationModel: 'log-distance', logDistanceEnvironment: 'urban', pathLossExponent: 2.5,
    });
    expect(result.ok).toBe(true);
    expect(result.result!.pathLossDb).toBeCloseTo(logDistancePathLossDb(1000, FREQ_HZ, 2.5), 6);
  });

  test('selecting an unverified preset (rural/suburban) fires UNVERIFIED_PRESET_VALUE', () => {
    const result = calculateLinkBudget({
      txPowerDbm: 40, cableLossDb: 2, connectorLossDb: 0.5, antennaGainDbi: 17,
      distanceM: 1000, frequencyMhz: FREQ_MHZ,
      propagationModel: 'log-distance', logDistanceEnvironment: 'rural',
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some(w => w.code === 'UNVERIFIED_PRESET_VALUE')).toBe(true);
  });

  test('selecting a verified preset does NOT fire UNVERIFIED_PRESET_VALUE', () => {
    const result = calculateLinkBudget({
      txPowerDbm: 40, cableLossDb: 2, connectorLossDb: 0.5, antennaGainDbi: 17,
      distanceM: 1000, frequencyMhz: FREQ_MHZ,
      propagationModel: 'log-distance', logDistanceEnvironment: 'urban',
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some(w => w.code === 'UNVERIFIED_PRESET_VALUE')).toBe(false);
  });

  // Guards the two independent PropagationModel dispatch points
  // (linkbudget.ts's own inline switch, and site-signal.ts's
  // computeBasePathLossDb shared by coverage-grid.ts/interference.ts) from
  // silently drifting apart for this new model — the same pre-existing
  // minor duplication already present for fspl/hata/cost231-hata/close-in.
  test('dispatch parity: linkbudget.ts and site-signal.ts compute identical log-distance path loss for identical inputs', async () => {
    const distanceM = 2500;
    const n = LOG_DISTANCE_ENVIRONMENT_PRESETS.urban.pathLossExponent;

    const viaLinkBudget = calculateLinkBudget({
      txPowerDbm: 40, cableLossDb: 2, connectorLossDb: 0.5, antennaGainDbi: 17,
      distanceM, frequencyMhz: FREQ_MHZ, propagationModel: 'log-distance', logDistanceEnvironment: 'urban',
    });
    const viaSiteSignal = await computeBasePathLossDb(
      'log-distance', distanceM, FREQ_HZ, FREQ_MHZ,
      0, 0, 'urban', 'medium', undefined, undefined, 'urban',
    );

    expect(viaLinkBudget.ok).toBe(true);
    expect(viaSiteSignal).not.toBeNull();
    expect(viaLinkBudget.result!.pathLossDb).toBeCloseTo(viaSiteSignal!.pathLossDb, 9);
    expect(viaLinkBudget.result!.pathLossDb).toBeCloseTo(logDistancePathLossDb(distanceM, FREQ_HZ, n), 9);
  });
});
