import { calculateCoverageGrid } from '../coverage-grid';
import { initialBearingDeg } from '../geometry';
import type { CoverageGridInput } from '../rf-types';

const baseInput: CoverageGridInput = {
  siteLat: 37.7749, siteLon: -122.4194, siteHeightM: 30,
  azimuthDeg: 0, horizontalBeamwidthDeg: 65, verticalBeamwidthDeg: 10,
  mechanicalDowntiltDeg: 2, electricalDowntiltDeg: 0, frontToBackDb: 20,
  txPowerDbm: 40, cableLossDb: 2, connectorLossDb: 0.5, antennaGainDbi: 17,
  frequencyMhz: 1900,
  radiusM: 2000, resolution: 20,
};

describe('coverage-grid', () => {
  test('grid dimensions match the requested resolution', async () => {
    const res = await calculateCoverageGrid(baseInput);
    expect(res.ok).toBe(true);
    if (res.ok && res.result) {
      expect(res.result.rows).toBe(20);
      expect(res.result.cols).toBe(20);
      expect(res.result.cells.length).toBeGreaterThan(0);
      expect(res.result.cells.length).toBeLessThanOrEqual(20 * 20);
    }
  });

  test('resolution beyond the cell cap is clamped with a warning, not rejected', async () => {
    const res = await calculateCoverageGrid({ ...baseInput, resolution: 500 });
    expect(res.ok).toBe(true);
    expect(res.warnings.some(w => w.code === 'RESOLUTION_CLAMPED')).toBe(true);
    if (res.ok && res.result) {
      expect(res.result.rows).toBeLessThanOrEqual(100);
    }
  });

  test('a cell near boresight is predicted stronger than the same physical point when the antenna points away from it', async () => {
    const pointingAtIt = await calculateCoverageGrid({ ...baseInput, azimuthDeg: 0 });
    const pointingAwayFromIt = await calculateCoverageGrid({ ...baseInput, azimuthDeg: 180 });
    expect(pointingAtIt.ok).toBe(true);
    expect(pointingAwayFromIt.ok).toBe(true);
    if (!pointingAtIt.ok || !pointingAtIt.result || !pointingAwayFromIt.ok || !pointingAwayFromIt.result) return;

    // Grid cell placement is identical between the two calls (same site/radius/
    // resolution) — only azimuthDeg differs — so pick the farthest, most
    // due-north cell (bearing closest to 0) as the comparison point.
    let target = pointingAtIt.result.cells[0];
    let bestBearingDelta = Infinity;
    for (const cell of pointingAtIt.result.cells) {
      if (cell.distanceM < 1500) continue; // stay far from the site to keep vertical/horizontal effects clean
      const bearing = initialBearingDeg(baseInput.siteLat, baseInput.siteLon, cell.lat, cell.lon);
      const delta = Math.min(Math.abs(bearing), 360 - Math.abs(bearing));
      if (delta < bestBearingDelta) { bestBearingDelta = delta; target = cell; }
    }
    expect(bestBearingDelta).toBeLessThan(15); // confirms we actually found a near-due-north cell

    const same = pointingAwayFromIt.result.cells.find(c => c.row === target.row && c.col === target.col);
    expect(same).toBeDefined();
    if (!same) return;

    // Same physical point, same distance (so same path loss and vertical
    // pattern term) — the only thing that changed is which way the antenna
    // is pointed, so the "pointing at it" run must predict a stronger signal.
    expect(target.totalReceivedPowerDbm).toBeGreaterThan(same.totalReceivedPowerDbm);
    // Azimuth offset ~180° is well past the front-to-back cutoff (20 dB) in
    // both the horizontal AND (since it dominates) combined pattern loss, so
    // the difference should be close to that cap, not just marginally worse.
    expect(target.totalReceivedPowerDbm - same.totalReceivedPowerDbm).toBeGreaterThan(15);
  });

  test('coverage requirement round-trips algebraically: the required TX power reproduces the threshold at the limiting point', async () => {
    const input: CoverageGridInput = {
      siteLat: 37.7749, siteLon: -122.4194, siteHeightM: 30,
      azimuthDeg: 45, horizontalBeamwidthDeg: 65, verticalBeamwidthDeg: 10,
      mechanicalDowntiltDeg: 3, electricalDowntiltDeg: 2, frontToBackDb: 20,
      txPowerDbm: 40, cableLossDb: 2, connectorLossDb: 0.5, filterLossDb: 0.5,
      antennaGainDbi: 17, frequencyMhz: 1900,
      buildingLossDb: 5, foliageLossDb: 1, miscLossDb: 0.5, ueAntennaGainDbi: 0,
      receiverHeightM: 1.5,
      radiusM: 3000, resolution: 30,
      targetPolygon: [
        { lat: 37.78142, lon: -122.41035 },
        { lat: 37.78142, lon: -122.40435 },
        { lat: 37.78742, lon: -122.40435 },
        { lat: 37.78742, lon: -122.41035 },
      ],
      minAcceptableSignalDbm: -100,
    };

    const first = await calculateCoverageGrid(input);
    expect(first.ok).toBe(true);
    if (!first.ok || !first.result?.coverageRequirement) {
      throw new Error('expected a coverageRequirement to be computed');
    }
    const { requiredTxPowerDbm, limitingPoint } = first.result.coverageRequirement;

    // Re-run with txPowerDbm set to the solved value (polygon/threshold
    // removed — we're checking the forward calculation now) and find the
    // exact same grid cell (deterministic placement, unchanged site/radius/
    // resolution) to confirm its predicted signal now sits at the threshold.
    const second = await calculateCoverageGrid({ ...input, txPowerDbm: requiredTxPowerDbm, targetPolygon: undefined, minAcceptableSignalDbm: undefined });
    expect(second.ok).toBe(true);
    if (!second.ok || !second.result) return;

    const limitingCell = second.result.cells.find(c => c.lat === limitingPoint.lat && c.lon === limitingPoint.lon);
    expect(limitingCell).toBeDefined();
    if (!limitingCell) return;
    expect(limitingCell.totalReceivedPowerDbm).toBeCloseTo(input.minAcceptableSignalDbm as number, 6);
  });

  test('a polygon with no sampled cells inside it produces a warning, not a coverage requirement', async () => {
    const res = await calculateCoverageGrid({
      ...baseInput,
      targetPolygon: [
        { lat: 89, lon: 0 }, { lat: 89, lon: 0.001 }, { lat: 89.001, lon: 0.001 }, { lat: 89.001, lon: 0 },
      ],
      minAcceptableSignalDbm: -100,
    });
    expect(res.ok).toBe(true);
    if (res.ok && res.result) {
      expect(res.result.coverageRequirement).toBeUndefined();
    }
    expect(res.warnings.some(w => w.code === 'NO_CELLS_IN_POLYGON')).toBe(true);
  });

  test('missing frequency (no frequencyMhz and no band+earfcn) is a structured error, not a crash', async () => {
    const { frequencyMhz, ...rest } = baseInput;
    const res = await calculateCoverageGrid(rest as CoverageGridInput);
    expect(res.ok).toBe(false);
    expect(res.error?.missingInputs.length).toBeGreaterThan(0);
  });

  test('propagationModel "hata" is selectable and produces a differently-named model/equation than fspl', async () => {
    // Hata is only valid up to 1500 MHz — override baseInput's 1900 MHz.
    const hataInput = { ...baseInput, frequencyMhz: 900, radiusM: 1500, resolution: 10 };
    const fspl = await calculateCoverageGrid(hataInput);
    const hata = await calculateCoverageGrid({ ...hataInput, propagationModel: 'hata' as const, environment: 'urban' as const });
    expect(fspl.ok).toBe(true);
    expect(hata.ok).toBe(true);
    expect(hata.model).not.toBe(fspl.model);
    expect(hata.calculation.some(eq => eq.name.includes('Hata'))).toBe(true);
  });

  test('cells outside the Hata model\'s valid distance range are skipped with an aggregate warning, not a crash', async () => {
    // siteHeightM=30 is within Hata's [30,200]m range, but a 2000m grid
    // radius includes cells well under Hata's 1km minimum distance.
    const res = await calculateCoverageGrid({ ...baseInput, frequencyMhz: 900, propagationModel: 'hata', environment: 'urban' });
    expect(res.ok).toBe(true);
    expect(res.warnings.some(w => w.code === 'CELLS_SKIPPED_OUT_OF_MODEL_RANGE')).toBe(true);
  });

  test('hata model rejects an out-of-range input (siteHeightM below Hata\'s 30m minimum) with a structured error', async () => {
    const res = await calculateCoverageGrid({ ...baseInput, frequencyMhz: 900, siteHeightM: 5, propagationModel: 'hata' });
    expect(res.ok).toBe(false);
    expect(res.error?.reason).toMatch(/Hata/);
  });

  test('useTerrainData adds real diffraction loss on top of the base model when a mocked profile has an obstruction', async () => {
    jest.resetModules();
    jest.doMock('../elevation-provider', () => ({
      getElevationM: jest.fn(async (lat: number, lon: number) => {
        // A ridge roughly halfway between the site and a due-north cell.
        const distFromSite = Math.hypot(lat - baseInput.siteLat, lon - baseInput.siteLon);
        return distFromSite > 0.003 && distFromSite < 0.006 ? 200 : 0;
      }),
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { calculateCoverageGrid: calculateCoverageGridMocked } = require('../coverage-grid');

    const flat = await calculateCoverageGridMocked({ ...baseInput, azimuthDeg: 0, radiusM: 1500, resolution: 8 });
    const terrain = await calculateCoverageGridMocked({ ...baseInput, azimuthDeg: 0, radiusM: 1500, resolution: 8, useTerrainData: true, terrainSampleCount: 6 });

    expect(flat.ok).toBe(true);
    expect(terrain.ok).toBe(true);
    expect(terrain.warnings.some((w: { code: string }) => w.code === 'TERRAIN_DIFFRACTION_APPLIED')).toBe(true);

    // Same cells (deterministic grid placement), but terrain run should be
    // strictly weaker on average given the injected ridge blocks part of it.
    const flatAvg = flat.result.cells.reduce((s: number, c: { totalReceivedPowerDbm: number }) => s + c.totalReceivedPowerDbm, 0) / flat.result.cells.length;
    const terrainAvg = terrain.result.cells.reduce((s: number, c: { totalReceivedPowerDbm: number }) => s + c.totalReceivedPowerDbm, 0) / terrain.result.cells.length;
    expect(terrainAvg).toBeLessThan(flatAvg);

    jest.dontMock('../elevation-provider');
  });

  test('propagationModel "close-in" with useTerrainData auto-selects the LOS/NLOS exponent from the real terrain determination', async () => {
    jest.resetModules();

    // Scenario 1: perfectly flat terrain everywhere -> every path is LOS.
    jest.doMock('../elevation-provider', () => ({ getElevationM: jest.fn(async () => 0) }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { calculateCoverageGrid: gridAllLos } = require('../coverage-grid');
    const losRun = await gridAllLos({
      ...baseInput, frequencyMhz: 3550, propagationModel: 'close-in',
      azimuthDeg: 0, radiusM: 1500, resolution: 8, useTerrainData: true, terrainSampleCount: 4,
    });
    jest.dontMock('../elevation-provider');
    jest.resetModules();

    // Scenario 2: a tall wall immediately outside the site blocks every path -> every path is NLOS.
    jest.doMock('../elevation-provider', () => ({
      getElevationM: jest.fn(async (lat: number, lon: number) => {
        const distFromSite = Math.hypot(lat - baseInput.siteLat, lon - baseInput.siteLon);
        return distFromSite > 0.0005 ? 500 : 0;
      }),
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { calculateCoverageGrid: gridAllNlos } = require('../coverage-grid');
    const nlosRun = await gridAllNlos({
      ...baseInput, frequencyMhz: 3550, propagationModel: 'close-in',
      azimuthDeg: 0, radiusM: 1500, resolution: 8, useTerrainData: true, terrainSampleCount: 4,
    });
    jest.dontMock('../elevation-provider');

    expect(losRun.ok).toBe(true);
    expect(nlosRun.ok).toBe(true);

    // Same distances/geometry in both runs (only the mocked terrain
    // differs) — the LOS run should predict meaningfully stronger signal
    // on average, reflecting the lower LOS exponent (2.0 vs 3.1) actually
    // being selected from the real terrain determination, not ignored.
    const avg = (cells: { totalReceivedPowerDbm: number }[]) => cells.reduce((s, c) => s + c.totalReceivedPowerDbm, 0) / cells.length;
    expect(avg(losRun.result.cells)).toBeGreaterThan(avg(nlosRun.result.cells));
  });
});
