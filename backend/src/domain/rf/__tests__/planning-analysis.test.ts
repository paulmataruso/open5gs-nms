import { BuildingIndex, BuildingFootprint, destinationPoint } from '../building-index';
import { findCoverageGaps, footprintCentroid, DEFAULT_BUILDING_SERVICE_THRESHOLD_DBM } from '../coverage-gap';
import { residualStats, spatialBlocks, spatiallyBlockedValidation, holdoutCheckedCalibrationOffset, type MeasurementSample } from '../measurement-validation';
import { optimizeNetwork, recommendSites, paretoFrontier, evaluateNetwork } from '../network-optimize';
import type { RayTraceProfile } from '../ray-trace';

const ORIGIN = { lon: -72.180426, lat: 43.375298 };

const PROFILE: RayTraceProfile = {
  frequencyGhz: 3.6, txPowerDbm: 27, txAntennaGainDbi: 6, rxAntennaGainDbi: 0,
  systemLossDb: 0, polarizationLossDb: 0, antennaHeightM: 25, receiverHeightM: 1.5,
  beamWidthDeg: 90, receiverSensitivityDbm: -110, mechanicalDowntiltDeg: 5,
};

function buildingAt(id: string, bearingDeg: number, distanceM: number, extra: Partial<BuildingFootprint> = {}): BuildingFootprint {
  const c = destinationPoint(ORIGIN, bearingDeg, distanceM);
  const h = 0.00015;
  return {
    id,
    ring: [[c.lon - h, c.lat - h], [c.lon + h, c.lat - h], [c.lon + h, c.lat + h], [c.lon - h, c.lat + h]],
    heightM: 8, heightSource: 'tag',
    demandWeight: 20, residentialDemand: 12,
    ...extra,
  };
}

describe('coverage gaps', () => {
  test('centroid sits inside its own footprint', () => {
    const b = buildingAt('b', 90, 100);
    const c = footprintCentroid(b);
    expect(c.lon).toBeGreaterThan(b.ring[0][0]);
    expect(c.lon).toBeLessThan(b.ring[1][0]);
  });

  test('buildings behind the antenna are out of scope, not gaps', () => {
    const behind = buildingAt('behind', 270, 150);
    const result = findCoverageGaps({
      origin: ORIGIN, azimuthDeg: 90, rays: 16, radiusM: 400, profile: PROFILE,
      buildings: new BuildingIndex([behind]),
    });
    expect(result.summary.candidateBuildings).toBe(0);
    expect(result.gaps).toHaveLength(0);
  });

  test('buildings beyond the radius are out of scope', () => {
    const far = buildingAt('far', 90, 900);
    const result = findCoverageGaps({
      origin: ORIGIN, azimuthDeg: 90, rays: 16, radiusM: 400, profile: PROFILE,
      buildings: new BuildingIndex([far]),
    });
    expect(result.summary.candidateBuildings).toBe(0);
  });

  test('a near building in the beam is served; a distant one is a gap', () => {
    // Threshold chosen with the wall-penetration cost in mind: a building the
    // ray passes THROUGH is charged its own facade loss (8 dB per wall at
    // CBRS), so even a close building lands well below free-space expectation.
    // Measured here: near ~ -92 dBm at 80 m, distant ~ -117 dBm at 390 m.
    const near = buildingAt('near', 90, 80);
    const distant = buildingAt('distant', 90, 390);
    const result = findCoverageGaps({
      origin: ORIGIN, azimuthDeg: 90, rays: 24, radiusM: 400, profile: PROFILE,
      buildings: new BuildingIndex([near, distant]),
      serviceThresholdDbm: -100,
    });
    expect(result.summary.candidateBuildings).toBe(2);
    expect(result.gaps.map(g => g.buildingId)).toContain('distant');
    expect(result.gaps.map(g => g.buildingId)).not.toContain('near');
    expect(result.summary.demandServedPct).toBeGreaterThan(0);
    expect(result.summary.demandServedPct).toBeLessThan(100);
  });

  test('a building never illuminated is reported with that reason', () => {
    // Narrow beam, building off to the side but still within the angular span
    // of a wide search radius -> it can be a candidate yet never hit by a ray.
    const result = findCoverageGaps({
      origin: ORIGIN, azimuthDeg: 90, rays: 2, radiusM: 400,
      profile: { ...PROFILE, beamWidthDeg: 120 },
      buildings: new BuildingIndex([buildingAt('edge', 150, 300)]),
    });
    const edge = result.gaps.find(g => g.buildingId === 'edge');
    if (edge) {
      expect(['never_illuminated', 'below_service_threshold']).toContain(edge.reason);
      if (edge.reason === 'never_illuminated') expect(edge.bestRxDbm).toBeNull();
    }
  });

  test('residentialOnly filters out pure-commercial footprints', () => {
    const commercial = buildingAt('shop', 90, 120, { residentialDemand: 0, demandWeight: 60 });
    const home = buildingAt('home', 90, 130, { residentialDemand: 20 });
    const index = new BuildingIndex([commercial, home]);
    const all = findCoverageGaps({ origin: ORIGIN, azimuthDeg: 90, rays: 16, radiusM: 400, profile: PROFILE, buildings: index });
    const residential = findCoverageGaps({ origin: ORIGIN, azimuthDeg: 90, rays: 16, radiusM: 400, profile: PROFILE, buildings: index, residentialOnly: true });
    expect(all.summary.candidateBuildings).toBe(2);
    expect(residential.summary.candidateBuildings).toBe(1);
  });

  test('gaps are ordered worst-demand first', () => {
    const buildings = [
      buildingAt('small', 90, 380, { demandWeight: 5, residentialDemand: 0 }),
      buildingAt('big', 90, 385, { demandWeight: 90, residentialDemand: 30 }),
    ];
    const result = findCoverageGaps({
      origin: ORIGIN, azimuthDeg: 90, rays: 24, radiusM: 400, profile: PROFILE,
      buildings: new BuildingIndex(buildings), serviceThresholdDbm: -60,
    });
    expect(result.gaps[0].buildingId).toBe('big');
  });

  test('the service threshold is independent of receiver sensitivity', () => {
    expect(DEFAULT_BUILDING_SERVICE_THRESHOLD_DBM).toBe(-100);
    expect(DEFAULT_BUILDING_SERVICE_THRESHOLD_DBM).toBeGreaterThan(PROFILE.receiverSensitivityDbm);
  });
});

describe('measurement validation', () => {
  const perfect: MeasurementSample[] = Array.from({ length: 20 }, (_, i) => ({
    point: { lon: -72.18 + i * 0.001, lat: 43.375 },
    measuredDbm: -80 - i,
    predictedDbm: -80 - i,
  }));

  test('a perfect model has zero error and unit correlation', () => {
    const stats = residualStats(perfect);
    expect(stats.maeDb).toBe(0);
    expect(stats.rmseDb).toBe(0);
    expect(stats.biasDb).toBe(0);
    expect(stats.correlation).toBeCloseTo(1, 2);
  });

  test('a uniformly optimistic model shows positive bias equal to its MAE', () => {
    const optimistic = perfect.map(s => ({ ...s, predictedDbm: s.measuredDbm + 6 }));
    const stats = residualStats(optimistic);
    expect(stats.biasDb).toBeCloseTo(6, 6);
    expect(stats.maeDb).toBeCloseTo(6, 6);
    expect(stats.stdDevDb).toBeCloseTo(0, 6);
  });

  test('symmetric errors cancel in bias but not in MAE — why both are reported', () => {
    const noisy = perfect.map((s, i) => ({ ...s, predictedDbm: s.measuredDbm + (i % 2 === 0 ? 5 : -5) }));
    const stats = residualStats(noisy);
    expect(stats.biasDb).toBeCloseTo(0, 6);
    expect(stats.maeDb).toBeCloseTo(5, 6);
    expect(stats.rmseDb).toBeCloseTo(5, 6);
  });

  test('empty input returns zeros rather than NaN', () => {
    const stats = residualStats([]);
    expect(stats.count).toBe(0);
    expect(Number.isNaN(stats.maeDb)).toBe(false);
  });

  test('spatial blocks group nearby samples and separate distant ones', () => {
    const samples: MeasurementSample[] = [
      { point: { lon: -72.180, lat: 43.3750 }, measuredDbm: -90, predictedDbm: -90 },
      { point: { lon: -72.1801, lat: 43.3750 }, measuredDbm: -90, predictedDbm: -90 }, // ~8 m away
      { point: { lon: -72.170, lat: 43.3750 }, measuredDbm: -90, predictedDbm: -90 },  // ~800 m away
    ];
    const blocks = spatialBlocks(samples, 250);
    expect(blocks[0]).toBe(blocks[1]);
    expect(blocks[2]).not.toBe(blocks[0]);
  });

  test('single-block input refuses to pretend it was validated', () => {
    const clustered: MeasurementSample[] = Array.from({ length: 10 }, (_, i) => ({
      point: { lon: -72.18 + i * 0.00001, lat: 43.375 },
      measuredDbm: -90, predictedDbm: -88,
    }));
    const result = spatiallyBlockedValidation(clustered, 250, 5);
    expect(result.foldCount).toBe(0);
    expect(result.warning).toMatch(/single .* block/);
    expect(result.warning).toMatch(/understate real-world error/);
  });

  test('blocked validation produces per-fold held-out statistics', () => {
    const spread: MeasurementSample[] = Array.from({ length: 50 }, (_, i) => ({
      point: { lon: -72.18 + i * 0.004, lat: 43.375 },
      measuredDbm: -80 - (i % 7),
      predictedDbm: -80 - (i % 7) + 3,
    }));
    const result = spatiallyBlockedValidation(spread, 250, 5);
    expect(result.foldCount).toBeGreaterThan(1);
    expect(result.folds.length).toBe(result.foldCount);
    expect(result.folds.reduce((a, f) => a + f.heldOutSamples, 0)).toBe(50);
    expect(result.blockedMaeDb).toBeCloseTo(3, 1);
  });

  test('a calibration offset is only applied when it helps on held-out data', () => {
    const biased: MeasurementSample[] = Array.from({ length: 60 }, (_, i) => ({
      point: { lon: -72.18 + i * 0.004, lat: 43.375 },
      measuredDbm: -85 - (i % 5),
      predictedDbm: -85 - (i % 5) + 7, // consistent +7 dB optimism
    }));
    const offset = holdoutCheckedCalibrationOffset(biased, 250, 5, 30);
    expect(offset.applied).toBe(true);
    expect(offset.offsetDb).toBeCloseTo(-7, 0);
    expect(offset.afterMaeDb).toBeLessThan(offset.beforeMaeDb);
    expect(offset.detail).toMatch(/FITTED correction/);
  });

  test('an unbiased model is left alone', () => {
    const unbiased: MeasurementSample[] = Array.from({ length: 60 }, (_, i) => ({
      point: { lon: -72.18 + i * 0.004, lat: 43.375 },
      measuredDbm: -85, predictedDbm: -85 + (i % 2 === 0 ? 4 : -4),
    }));
    const offset = holdoutCheckedCalibrationOffset(unbiased, 250, 5, 30);
    expect(Math.abs(offset.offsetDb)).toBeLessThan(1.5);
  });

  test('too few samples refuses to fit an offset', () => {
    const few = perfect.slice(0, 5).map(s => ({ ...s, predictedDbm: s.measuredDbm + 9 }));
    const offset = holdoutCheckedCalibrationOffset(few, 250, 5, 30);
    expect(offset.applied).toBe(false);
    expect(offset.offsetDb).toBe(0);
    expect(offset.detail).toMatch(/at least 30 samples/);
  });
});

describe('network optimization', () => {
  // Demand concentrated to the east, so the right answer is unambiguous.
  const eastDemand = new BuildingIndex([
    buildingAt('e1', 90, 120, { demandWeight: 50, residentialDemand: 20 }),
    buildingAt('e2', 95, 160, { demandWeight: 50, residentialDemand: 20 }),
    buildingAt('e3', 85, 200, { demandWeight: 50, residentialDemand: 20 }),
  ]);

  test('a single cell turns toward the demand', () => {
    const result = optimizeNetwork({
      cells: [{ id: 'c1', origin: ORIGIN, profile: PROFILE }],
      buildings: eastDemand, radiusM: 400, rays: 16, azimuthStepDeg: 30,
    });
    const azimuth = result.best.azimuths.c1;
    // Within one search step of due east.
    expect(Math.min(Math.abs(azimuth - 90), 360 - Math.abs(azimuth - 90))).toBeLessThanOrEqual(30);
    expect(result.best.demandServedPct).toBeGreaterThan(0);
    expect(result.evaluations).toBeGreaterThan(0);
  });

  test('a locked azimuth is respected and costs no search', () => {
    const result = optimizeNetwork({
      cells: [{ id: 'c1', origin: ORIGIN, profile: PROFILE, lockedAzimuthDeg: 270 }],
      buildings: eastDemand, radiusM: 400, rays: 16, azimuthStepDeg: 30,
    });
    expect(result.best.azimuths.c1).toBe(270);
  });

  test('two co-sited cells are pushed apart rather than stacked', () => {
    const spread = new BuildingIndex([
      buildingAt('n1', 0, 150, { demandWeight: 60, residentialDemand: 0 }),
      buildingAt('s1', 180, 150, { demandWeight: 60, residentialDemand: 0 }),
    ]);
    const result = optimizeNetwork({
      cells: [
        { id: 'a', origin: ORIGIN, profile: PROFILE },
        { id: 'b', origin: ORIGIN, profile: PROFILE },
      ],
      buildings: spread, radiusM: 400, rays: 16, azimuthStepDeg: 45, overlapWeight: 1,
    });
    const delta = Math.abs(result.best.azimuths.a - result.best.azimuths.b);
    expect(Math.min(delta, 360 - delta)).toBeGreaterThan(45);
  });

  test('overlap is counted and penalised', () => {
    const one = new BuildingIndex([buildingAt('shared', 90, 120, { demandWeight: 40, residentialDemand: 0 })]);
    const result = optimizeNetwork({
      cells: [
        { id: 'a', origin: ORIGIN, profile: PROFILE, lockedAzimuthDeg: 90 },
        { id: 'b', origin: ORIGIN, profile: PROFILE, lockedAzimuthDeg: 90 },
      ],
      buildings: one, radiusM: 400, rays: 16, overlapWeight: 1,
    });
    expect(result.best.overlapDemand).toBeGreaterThan(0);
    // Serving it twice must score below serving it once.
    expect(result.best.score).toBeLessThan(result.best.demandServedPct);
  });

  test('contributions separate exclusive from shared demand', () => {
    const result = optimizeNetwork({
      cells: [{ id: 'solo', origin: ORIGIN, profile: PROFILE, lockedAzimuthDeg: 90 }],
      buildings: eastDemand, radiusM: 400, rays: 16,
    });
    const contribution = result.best.contributions.find(c => c.cellId === 'solo')!;
    expect(contribution.sharedDemand).toBe(0);
    expect(contribution.exclusiveDemand).toBeGreaterThan(0);
  });

  test('the Pareto frontier contains only non-dominated configurations', () => {
    const result = optimizeNetwork({
      cells: [{ id: 'c1', origin: ORIGIN, profile: PROFILE }],
      buildings: eastDemand, radiusM: 400, rays: 12, azimuthStepDeg: 45,
    });
    expect(result.pareto.length).toBeGreaterThan(0);
    for (const a of result.pareto) {
      for (const b of result.pareto) {
        if (a === b) continue;
        const dominates = b.servedDemand >= a.servedDemand && b.overlapDemand <= a.overlapDemand &&
          (b.servedDemand > a.servedDemand || b.overlapDemand < a.overlapDemand);
        expect(dominates).toBe(false);
      }
    }
  });

  test('paretoFrontier drops a strictly worse configuration', () => {
    const make = (served: number, overlap: number, id: string) => evaluateNetwork(
      [{ cellId: id, azimuthDeg: served, served: new Set<string>() }],
      new Map(), 0.5,
    );
    const good = { ...make(0, 0, 'a'), servedDemand: 100, overlapDemand: 0, azimuths: { a: 0 } };
    const bad = { ...make(0, 0, 'a'), servedDemand: 50, overlapDemand: 10, azimuths: { a: 90 } };
    const frontier = paretoFrontier([good, bad]);
    expect(frontier).toHaveLength(1);
    expect(frontier[0].servedDemand).toBe(100);
  });
});

describe('site recommendation', () => {
  test('ranks by marginal gain, not by absolute coverage', () => {
    // Geometry matters here. Both targets must be out of reach of the WRONG
    // candidate, otherwise each candidate can serve both and the ranking ties:
    //   'already'  90 deg / 120 m  demand 80  <- the live cell already serves it
    //   'unserved' 90 deg / 900 m  demand 40  <- nobody serves it
    // With a 400 m radius, the near candidate (100 m) cannot reach 900 m and
    // the far candidate (850 m) cannot reach 120 m. So the only way to win on
    // marginal demand is to cover the genuinely unserved building, even though
    // it carries half the demand of the covered one.
    const buildings = new BuildingIndex([
      buildingAt('already', 90, 120, { demandWeight: 80, residentialDemand: 0 }),
      buildingAt('unserved', 90, 900, { demandWeight: 40, residentialDemand: 0 }),
    ]);
    const existing = [{ id: 'live', origin: ORIGIN, profile: PROFILE, lockedAzimuthDeg: 90 }];
    const candidates = [
      { id: 'near-already', origin: destinationPoint(ORIGIN, 90, 100) },
      { id: 'near-unserved', origin: destinationPoint(ORIGIN, 90, 850) },
    ];
    const recommendations = recommendSites(candidates, existing, {
      buildings, radiusM: 400, rays: 16, azimuthStepDeg: 45, defaultProfile: PROFILE,
      // Lenient on purpose: the existing cell must unambiguously already serve
      // 'already', or this becomes a test of the threshold rather than of the
      // marginal ranking.
      serviceThresholdDbm: -120,
    });
    expect(recommendations).toHaveLength(2);
    expect(recommendations[0].rank).toBe(1);
    expect(recommendations[0].candidateId).toBe('near-unserved');
    expect(recommendations[0].marginalDemand).toBeGreaterThan(0);
    // And the one sitting on top of existing coverage is correctly valued at
    // zero marginal gain, with its effort recorded as redundant.
    const redundantPick = recommendations.find(r => r.candidateId === 'near-already')!;
    expect(redundantPick.marginalDemand).toBe(0);
    expect(redundantPick.redundantDemand).toBeGreaterThan(0);
  });

  test('maxResults truncates the ranking', () => {
    const buildings = new BuildingIndex([buildingAt('b', 90, 120)]);
    const candidates = [
      { id: 'a', origin: destinationPoint(ORIGIN, 0, 50) },
      { id: 'b', origin: destinationPoint(ORIGIN, 90, 50) },
      { id: 'c', origin: destinationPoint(ORIGIN, 180, 50) },
    ];
    const result = recommendSites(candidates, [], {
      buildings, radiusM: 400, rays: 12, azimuthStepDeg: 90, defaultProfile: PROFILE, maxResults: 2,
    });
    expect(result).toHaveLength(2);
  });
});
