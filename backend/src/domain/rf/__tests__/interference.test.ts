import { calculateMultiSiteInterference } from '../interference';
import { haversineDistanceM } from '../geometry';
import type { InterferenceGridInput, InterferenceSiteInput } from '../rf-types';

// Two sites ~1.76km apart, pointed at each other, so their coverage
// genuinely overlaps around the midpoint.
const siteA: InterferenceSiteInput = {
  id: 'site-a', name: 'Site A',
  siteLat: 37.7749, siteLon: -122.4194, siteHeightM: 30,
  azimuthDeg: 90, horizontalBeamwidthDeg: 120, frontToBackDb: 20,
  txPowerDbm: 40, cableLossDb: 2, connectorLossDb: 0.5, antennaGainDbi: 17, frequencyMhz: 1900,
};
const siteB: InterferenceSiteInput = {
  id: 'site-b', name: 'Site B',
  siteLat: 37.7749, siteLon: -122.3994, siteHeightM: 30,
  azimuthDeg: 270, horizontalBeamwidthDeg: 120, frontToBackDb: 20,
  txPowerDbm: 40, cableLossDb: 2, connectorLossDb: 0.5, antennaGainDbi: 17, frequencyMhz: 1900,
};

const midLat = 37.7749, midLon = -122.4094; // roughly the midpoint between A and B

const baseInput: InterferenceGridInput = {
  sites: [siteA, siteB],
  centerLat: midLat, centerLon: midLon,
  radiusM: 1200, resolution: 20,
  bandwidthHz: 20_000_000,
};

function nearestCell<T extends { lat: number; lon: number }>(cells: T[], lat: number, lon: number): T {
  let best = cells[0], bestD = Infinity;
  for (const c of cells) {
    const d = haversineDistanceM(lat, lon, c.lat, c.lon);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

describe('interference', () => {
  test('grid dimensions and site list are correct', async () => {
    const res = await calculateMultiSiteInterference(baseInput);
    expect(res.ok).toBe(true);
    if (res.ok && res.result) {
      expect(res.result.rows).toBe(20);
      expect(res.result.cols).toBe(20);
      expect(res.result.siteIds.sort()).toEqual(['site-a', 'site-b'].sort());
    }
  });

  test('the serving site flips between A and B depending on which side of the midpoint a cell is on', async () => {
    const res = await calculateMultiSiteInterference(baseInput);
    expect(res.ok).toBe(true);
    if (!res.ok || !res.result) return;

    // Near site A (west side) should be served by A; near site B (east side) by B.
    const nearA = nearestCell(res.result.cells, 37.7749, -122.4174); // just east of A
    const nearB = nearestCell(res.result.cells, 37.7749, -122.4014); // just west of B

    expect(nearA.servingSiteId).toBe('site-a');
    expect(nearB.servingSiteId).toBe('site-b');
  });

  test('SINR near the boundary between two comparable sites is worse than deep inside either site\'s own territory', async () => {
    const res = await calculateMultiSiteInterference(baseInput);
    expect(res.ok).toBe(true);
    if (!res.ok || !res.result) return;

    const cells = res.result.cells.filter((c): c is typeof c & { sinrDb: number } => c.sinrDb != null);
    const atMidpoint = nearestCell(cells, midLat, midLon);
    const deepInA = nearestCell(cells, 37.7749, -122.4194); // right at site A itself
    const deepInB = nearestCell(cells, 37.7749, -122.3994); // right at site B itself

    const midpointSinr = cells.find(c => c.row === atMidpoint.row && c.col === atMidpoint.col)!.sinrDb as number;
    const deepASinr = cells.find(c => c.row === deepInA.row && c.col === deepInA.col)!.sinrDb as number;
    const deepBSinr = cells.find(c => c.row === deepInB.row && c.col === deepInB.col)!.sinrDb as number;

    expect(midpointSinr).toBeLessThan(deepASinr);
    expect(midpointSinr).toBeLessThan(deepBSinr);
  });

  test('a single-site grid degenerates to "always served by that site, no interferers"', async () => {
    const res = await calculateMultiSiteInterference({ ...baseInput, sites: [siteA] });
    expect(res.ok).toBe(true);
    if (!res.ok || !res.result) return;
    const served = res.result.cells.filter(c => c.servingSiteId != null);
    expect(served.length).toBeGreaterThan(0);
    expect(served.every(c => c.servingSiteId === 'site-a')).toBe(true);
  });

  test('resolution beyond the (lower, multi-site) cell cap is clamped with a warning', async () => {
    const res = await calculateMultiSiteInterference({ ...baseInput, resolution: 500 });
    expect(res.ok).toBe(true);
    expect(res.warnings.some(w => w.code === 'RESOLUTION_CLAMPED')).toBe(true);
  });

  test('empty sites array is a structured error, not a crash', async () => {
    const res = await calculateMultiSiteInterference({ ...baseInput, sites: [] });
    expect(res.ok).toBe(false);
  });

  test('an invalid site (missing frequency) is a structured error identifying the site by name', async () => {
    const { frequencyMhz, ...badSiteA } = siteA;
    const res = await calculateMultiSiteInterference({ ...baseInput, sites: [badSiteA as InterferenceSiteInput, siteB] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error?.reason).toContain('Site A');
  });
});
