import {
  simulationPathLossDb, modelApplicability, modelLabel, isSimulationModel,
  SIMULATION_MODELS, SIMULATION_MODEL_INFO, DEFAULT_SIMULATION_MODEL,
} from '../propagation-select';
import { umaPathLossDb } from '../uma-model';
import { fsplDb } from '../pathloss-fspl';

// This deployment's real radio: CBRS n48 at 3.6 GHz on a 25 m pole.
const CBRS = { frequencyGhz: 3.6, txHeightM: 25, rxHeightM: 1.5, radiusM: 400 };

describe('simulationPathLossDb dispatch', () => {
  it('delegates rather than reimplementing: UMa matches the UMa module exactly', () => {
    const viaDispatcher = simulationPathLossDb('uma', { ...CBRS, distanceM: 250, lineOfSight: false });
    const direct = umaPathLossDb(250, 3.6, 25, 1.5, 'nlos');
    expect(viaDispatcher).toBe(direct);
  });

  it('delegates FSPL to the FSPL module exactly', () => {
    expect(simulationPathLossDb('fspl', { ...CBRS, distanceM: 250, lineOfSight: true }))
      .toBe(fsplDb(250, 3.6e9));
  });

  it('every model is reachable and none falls through to another', () => {
    // A fallthrough bug would make two models return identical values for the
    // same input, so this needs ONE input every model will actually accept.
    // That input is narrower than it looks: Hata stops at 1.5 GHz and
    // COST-231 starts at 1.5 GHz, so 1.5 GHz is the only frequency where all
    // seven are simultaneously in range. Heights and distance are chosen to
    // sit inside the macro-cell models' windows too, and Walfisch-Ikegami
    // gets the rooftop height it requires.
    const values = new Map<string, number | null>();
    for (const model of SIMULATION_MODELS) {
      values.set(model, simulationPathLossDb(model, {
        frequencyGhz: 1.5, txHeightM: 40, rxHeightM: 1.5,
        distanceM: 2000, lineOfSight: false, buildingHeightM: 12,
      }));
    }
    for (const model of SIMULATION_MODELS) expect(values.get(model)).not.toBeNull();
    // Close-in and log-distance legitimately coincide when the exponent
    // matches, so compare the rest pairwise.
    const distinct = new Set([...values.entries()].filter(([m]) => m !== 'log-distance').map(([, v]) => v));
    expect(distinct.size).toBe(SIMULATION_MODELS.length - 1);
  });

  it('returns null — not a fabricated number — when a model declines', () => {
    // Hata is specified from 1 km outward; 300 m is inside its minimum.
    expect(simulationPathLossDb('hata', {
      frequencyGhz: 0.9, txHeightM: 40, rxHeightM: 1.5, distanceM: 300, lineOfSight: false,
    })).toBeNull();
  });

  it('declines Walfisch-Ikegami NLOS without a rooftop height instead of inventing one', () => {
    const params = { frequencyGhz: 1.8, txHeightM: 40, rxHeightM: 1.5, distanceM: 1000, lineOfSight: false };
    expect(simulationPathLossDb('walfisch-ikegami', { ...params, walfischIkegamiMode: 'nlos' })).toBeNull();
    expect(simulationPathLossDb('walfisch-ikegami', { ...params, walfischIkegamiMode: 'nlos', buildingHeightM: 12 })).not.toBeNull();
  });

  it('NLOS never comes out stronger than LOS at the same distance', () => {
    for (const model of ['uma', 'close-in'] as const) {
      const los = simulationPathLossDb(model, { ...CBRS, distanceM: 300, lineOfSight: true })!;
      const nlos = simulationPathLossDb(model, { ...CBRS, distanceM: 300, lineOfSight: false })!;
      expect(nlos).toBeGreaterThanOrEqual(los);
    }
  });

  it('path loss grows with distance for every model that accepts the range', () => {
    for (const model of SIMULATION_MODELS) {
      const near = simulationPathLossDb(model, {
        frequencyGhz: 1.8, txHeightM: 40, rxHeightM: 1.5, distanceM: 1500, lineOfSight: false, buildingHeightM: 12,
      });
      const far = simulationPathLossDb(model, {
        frequencyGhz: 1.8, txHeightM: 40, rxHeightM: 1.5, distanceM: 4000, lineOfSight: false, buildingHeightM: 12,
      });
      if (near === null || far === null) continue;
      expect(far).toBeGreaterThan(near);
    }
  });
});

describe('modelApplicability on this deployment’s real CBRS band', () => {
  it('accepts UMa, which is why it is the default', () => {
    const check = modelApplicability('uma', CBRS);
    expect(check.applicable).toBe(true);
    expect(DEFAULT_SIMULATION_MODEL).toBe('uma');
  });

  it('blocks Hata at 3.6 GHz and says so with the real published range', () => {
    const check = modelApplicability('hata', CBRS);
    expect(check.applicable).toBe(false);
    expect(check.blocking.join(' ')).toContain('0.15-1.5 GHz');
    expect(check.blocking.join(' ')).toContain('3.6 GHz');
  });

  it('names models that DO cover the scenario, so the error is actionable', () => {
    const check = modelApplicability('cost231-hata', CBRS);
    expect(check.applicable).toBe(false);
    expect(check.suggested).toContain('uma');
    expect(check.suggested).not.toContain('cost231-hata');
  });

  it('treats a radius below the minimum as blocking but above the maximum as a warning', () => {
    // Every sample inside the minimum means an empty map — that must stop the run.
    const tooNear = modelApplicability('hata', { frequencyGhz: 0.9, txHeightM: 40, rxHeightM: 1.5, radiusM: 500 });
    expect(tooNear.applicable).toBe(false);
    // Past the maximum only the far edge is lost, so the run is still useful.
    const tooFar = modelApplicability('hata', { frequencyGhz: 0.9, txHeightM: 40, rxHeightM: 1.5, radiusM: 30_000 });
    expect(tooFar.applicable).toBe(true);
    expect(tooFar.warnings.join(' ')).toContain('left empty');
  });

  it('blocks a 25 m CBRS pole from Hata, which assumes a 30 m+ macro tower', () => {
    const check = modelApplicability('hata', { ...CBRS, frequencyGhz: 0.9, radiusM: 5000 });
    expect(check.applicable).toBe(false);
    expect(check.blocking.join(' ')).toContain('transmit height');
  });

  it('accepts FSPL and log-distance unconditionally — they declare no limits', () => {
    for (const model of ['fspl', 'log-distance'] as const) {
      expect(modelApplicability(model, CBRS).applicable).toBe(true);
      expect(SIMULATION_MODEL_INFO[model].frequencyRangeGhz).toBeNull();
    }
  });

  it('blocks Walfisch-Ikegami NLOS until a rooftop height exists', () => {
    const scenario = { frequencyGhz: 1.8, txHeightM: 20, rxHeightM: 1.5, radiusM: 1000 };
    expect(modelApplicability('walfisch-ikegami', scenario).applicable).toBe(false);
    expect(modelApplicability('walfisch-ikegami', { ...scenario, buildingHeightM: 12 }).applicable).toBe(true);
  });
});

describe('model metadata', () => {
  it('every model has a label, blurb and citable source', () => {
    for (const model of SIMULATION_MODELS) {
      const info = SIMULATION_MODEL_INFO[model];
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.blurb.length).toBeGreaterThan(0);
      expect(info.source.length).toBeGreaterThan(0);
      expect(modelLabel(model)).toBe(info.label);
    }
  });

  it('rejects unknown model names from untrusted input', () => {
    expect(isSimulationModel('uma')).toBe(true);
    expect(isSimulationModel('itm')).toBe(false); // needs a terrain profile; not offered here
    expect(isSimulationModel('nonsense')).toBe(false);
    expect(isSimulationModel(undefined)).toBe(false);
  });
});
