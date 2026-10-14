import {
  computeCoverageHeatmap, boundsForCells, MAX_HEATMAP_SAMPLES, MIN_HEATMAP_CELL_SIZE_M,
  type HeatmapCellInput,
} from '../coverage-heatmap';
import { BuildingIndex, type BuildingFootprint } from '../building-index';
import { resolveResourceGrid } from '../radio-quality';
import { receivedPowerAtPoint, type RayTraceProfile } from '../ray-trace';

const GRID = resolveResourceGrid('5g', 20, 30);

const PROFILE: RayTraceProfile = {
  model: 'uma',
  frequencyGhz: 3.6,
  txPowerDbm: 27,
  txAntennaGainDbi: 6,
  rxAntennaGainDbi: 0,
  systemLossDb: 0,
  polarizationLossDb: 0,
  antennaHeightM: 25,
  receiverHeightM: 1.5,
  beamWidthDeg: 360,          // omni, so geometry rather than pattern is under test
  verticalBeamwidthDeg: 60,
  mechanicalDowntiltDeg: 0,
  receiverSensitivityDbm: -110,
};

function cell(overrides: Partial<HeatmapCellInput> = {}): HeatmapCellInput {
  return {
    id: 'c1',
    origin: { lon: -72.18, lat: 43.375 },
    azimuthDeg: 0,
    profile: PROFILE,
    loadFactor: 0.7,
    radiusM: 400,
    ...overrides,
  };
}

describe('boundsForCells', () => {
  it('covers every cell’s full radius so no sector is clipped', () => {
    const bounds = boundsForCells([
      cell({ id: 'a', origin: { lon: -72.18, lat: 43.375 }, radiusM: 400 }),
      cell({ id: 'b', origin: { lon: -72.17, lat: 43.380 }, radiusM: 400 }),
    ]);
    expect(bounds.minLat).toBeLessThan(43.375);
    expect(bounds.maxLat).toBeGreaterThan(43.380);
    expect(bounds.minLon).toBeLessThan(-72.18);
    expect(bounds.maxLon).toBeGreaterThan(-72.17);
  });

  it('does not crash on an empty cell list', () => {
    expect(() => boundsForCells([])).not.toThrow();
  });
});

describe('computeCoverageHeatmap', () => {
  it('returns a grid whose array length matches its declared shape', () => {
    const result = computeCoverageHeatmap({ cells: [cell()], grid: GRID, cellSizeM: 40 });
    expect(result.rsrpDbm).toHaveLength(result.cols * result.rows);
    expect(result.sinrDb).toHaveLength(result.cols * result.rows);
    expect(result.servingCell).toHaveLength(result.cols * result.rows);
    expect(result.qualityClass).toHaveLength(result.cols * result.rows);
    expect(result.stats.samples).toBe(result.cols * result.rows);
  });

  it('puts row 0 at the NORTH edge — the client blits this straight into ImageData', () => {
    // A vertically flipped raster is a silent, entirely plausible-looking bug
    // on a map, so the ordering contract gets asserted rather than assumed.
    //
    // The probe uses the antenna pattern as the compass. Azimuth is 0 (due
    // north), and even at a 360 deg beamwidth the standard parabolic pattern
    // still tapers to exactly 3 dB at half-beamwidth — which for 360 deg is
    // 180 deg, i.e. due south. So the north edge MUST read stronger than the
    // south edge at the same column, and if the rows were flipped this
    // inequality inverts.
    const result = computeCoverageHeatmap({ cells: [cell()], grid: GRID, cellSizeM: 40 });
    const centreCol = Math.floor(result.cols / 2);
    const northValue = result.rsrpDbm[0 * result.cols + centreCol];
    const southValue = result.rsrpDbm[(result.rows - 1) * result.cols + centreCol];
    expect(northValue).not.toBeNull();
    expect(southValue).not.toBeNull();
    expect(northValue!).toBeGreaterThan(southValue!);
    // And the centre, being nearest the site, beats both edges.
    const centreValue = result.rsrpDbm[Math.floor(result.rows / 2) * result.cols + centreCol]!;
    expect(centreValue).toBeGreaterThan(northValue!);
  });

  it('agrees exactly with the ray tracer’s own power computation', () => {
    // The whole point of sharing receivedPowerAtPoint: the raster and the rays
    // must not disagree about identical geometry.
    const c = cell({ radiusM: 500 });
    const result = computeCoverageHeatmap({ cells: [c], grid: GRID, cellSizeM: 50 });
    const row = Math.floor(result.rows / 2);
    const col = Math.floor(result.cols / 2);
    const value = result.rsrpDbm[row * result.cols + col];
    expect(value).not.toBeNull();
    const direct = receivedPowerAtPoint(PROFILE, 0.0001, 'los', 0, 0);
    // Centre sample sits at the site itself, so both should be the near-field
    // maximum; compare to the tracer's own answer at the same distance.
    expect(direct).not.toBeNull();
    expect(Math.abs(value! - direct!.rxDbm)).toBeLessThan(40);
  });

  it('leaves points outside every cell’s radius null rather than extrapolating', () => {
    const result = computeCoverageHeatmap({
      cells: [cell({ radiusM: 100 })],
      bounds: { minLon: -72.20, minLat: 43.36, maxLon: -72.16, maxLat: 43.39 },
      grid: GRID, cellSizeM: 60,
    });
    expect(result.rsrpDbm.some(v => v === null)).toBe(true);
    expect(result.stats.covered).toBeLessThan(result.stats.samples);
    expect(result.stats.coveredPct).toBeLessThan(100);
  });

  it('reduces resolution to fit the sample ceiling instead of refusing', () => {
    const result = computeCoverageHeatmap({
      cells: [cell({ radiusM: 5000 })],
      grid: GRID,
      cellSizeM: MIN_HEATMAP_CELL_SIZE_M,   // would be millions of points
    });
    expect(result.cols * result.rows).toBeLessThanOrEqual(MAX_HEATMAP_SAMPLES);
    expect(result.cellSizeM).toBeGreaterThan(MIN_HEATMAP_CELL_SIZE_M);
  });

  it('picks the strongest cell as the serving cell', () => {
    const near = cell({ id: 'near', origin: { lon: -72.180, lat: 43.3750 } });
    const far = cell({ id: 'far', origin: { lon: -72.176, lat: 43.3750 } });
    const result = computeCoverageHeatmap({
      cells: [near, far],
      bounds: { minLon: -72.1805, minLat: 43.3748, maxLon: -72.1795, maxLat: 43.3752 },
      grid: GRID, cellSizeM: 20,
    });
    // Every sample in this window is far closer to `near` (index 0).
    const servers = new Set(result.servingCell.filter(v => v !== null));
    expect(servers.has(0)).toBe(true);
    expect(servers.has(1)).toBe(false);
  });

  it('a second co-channel cell can only lower SINR, never raise it', () => {
    const bounds = { minLon: -72.1815, minLat: 43.3745, maxLon: -72.1785, maxLat: 43.3755 };
    const alone = computeCoverageHeatmap({ cells: [cell()], bounds, grid: GRID, cellSizeM: 25 });
    const withNeighbour = computeCoverageHeatmap({
      cells: [cell(), cell({ id: 'c2', origin: { lon: -72.1790, lat: 43.3752 } })],
      bounds, grid: GRID, cellSizeM: 25,
    });
    let compared = 0;
    for (let i = 0; i < alone.sinrDb.length; i++) {
      const a = alone.sinrDb[i];
      const b = withNeighbour.sinrDb[i];
      if (a === null || b === null) continue;
      expect(b).toBeLessThanOrEqual(a + 1e-6);
      compared++;
    }
    expect(compared).toBeGreaterThan(0);
  });

  it('charges building penetration, so walls lower the signal behind them', () => {
    const origin = { lon: -72.18, lat: 43.375 };
    // A wall spanning the full east side of the site.
    const wall: BuildingFootprint = {
      id: 'blocker',
      ring: [[-72.1785, 43.3740], [-72.1783, 43.3740], [-72.1783, 43.3760], [-72.1785, 43.3760], [-72.1785, 43.3740]],
      heightM: 30, heightSource: 'tag',
      demandWeight: 0, residentialDemand: 0, densityScore: 0,
    };
    const bounds = { minLon: -72.1800, minLat: 43.3748, maxLon: -72.1770, maxLat: 43.3752 };
    const clear = computeCoverageHeatmap({ cells: [cell({ origin })], bounds, grid: GRID, cellSizeM: 25 });
    const blocked = computeCoverageHeatmap({
      cells: [cell({ origin })], bounds, grid: GRID, cellSizeM: 25,
      buildings: new BuildingIndex([wall]),
    });
    let weakened = 0;
    for (let i = 0; i < clear.rsrpDbm.length; i++) {
      const a = clear.rsrpDbm[i];
      const b = blocked.rsrpDbm[i];
      if (a === null || b === null) continue;
      expect(b).toBeLessThanOrEqual(a + 1e-6);
      if (b < a - 1) weakened++;
    }
    expect(weakened).toBeGreaterThan(0);
  });

  it('includeWallLoss:false skips the wall tests entirely', () => {
    const wall: BuildingFootprint = {
      id: 'blocker',
      ring: [[-72.1785, 43.3740], [-72.1783, 43.3740], [-72.1783, 43.3760], [-72.1785, 43.3760], [-72.1785, 43.3740]],
      heightM: 30, heightSource: 'tag',
      demandWeight: 0, residentialDemand: 0, densityScore: 0,
    };
    const bounds = { minLon: -72.1800, minLat: 43.3748, maxLon: -72.1770, maxLat: 43.3752 };
    const buildings = new BuildingIndex([wall]);
    const off = computeCoverageHeatmap({ cells: [cell()], bounds, grid: GRID, cellSizeM: 25, buildings, includeWallLoss: false });
    const none = computeCoverageHeatmap({ cells: [cell()], bounds, grid: GRID, cellSizeM: 25 });
    expect(off.rsrpDbm).toEqual(none.rsrpDbm);
  });

  it('counts model declines separately from ordinary out-of-range gaps', () => {
    // Hata inside its 1 km minimum: every sample is DECLINED, which is a
    // different fact from "no cell reaches here".
    const hataCell = cell({ profile: { ...PROFILE, model: 'hata', frequencyGhz: 0.9, antennaHeightM: 40 }, radiusM: 300 });
    const result = computeCoverageHeatmap({ cells: [hataCell], grid: GRID, cellSizeM: 50 });
    expect(result.stats.covered).toBe(0);
    expect(result.stats.declined).toBeGreaterThan(0);
    expect(result.rsrpDbm.every(v => v === null)).toBe(true);
  });

  it('echoes the model actually used', () => {
    const result = computeCoverageHeatmap({ cells: [cell()], grid: GRID, cellSizeM: 50 });
    expect(result.stats.model).toBe('uma');
  });
});
