import { describe, it, expect } from 'vitest';
import {
  normalizeAzimuthDeg,
  signedAzimuthDeg,
  reportCells,
  reportQuality,
  reportGaps,
  createSite,
  applyAntenna,
  groupBySite,
  nextSectorLabel,
  SITE_LAYOUTS,
  type AntennaModel,
  type PlanningRadio,
  type SimulateResult,
} from '../rfSimulation';

/**
 * The pure helpers behind the RF Planning workspace.
 *
 * Load-bearing facts (CLAUDE.md, RF Planning row), each pinned below:
 *  - Azimuth wraps BOTH ways. The slider once ran 0-359, so a sector pointing
 *    north sat on its endpoint and could only rotate clockwise.
 *  - The report projections are a payload guard. The simulate result carries
 *    every traced ray's GeoJSON; posting it whole exceeded nginx's 10m body cap
 *    and, because nginx's 413 is HTML, the user saw a bare "HTTP 413". The only
 *    thing that stops that regressing is asserting nothing extra survives.
 *  - Site defaults are what gets ordered: 3 x 65 deg on 120 deg spacing,
 *    4 x 45 deg on 90 deg, and sectors sharing a siteId are one mast.
 *  - An antenna selection applies its WHOLE pattern at once, because gain and
 *    the two beamwidths are tied by the aperture.
 */

describe('normalizeAzimuthDeg', () => {
  it.each([
    [0, 0], [1, 1], [359, 359], [360, 0], [361, 1], [-1, 359], [-360, 0],
    [180, 180], [-180, 180], [725, 5], [-725, 355],
  ])('wraps %d to %d', (input, expected) => {
    expect(normalizeAzimuthDeg(input)).toBe(expected);
  });

  it('rounds to a whole degree before wrapping, so 359.9 lands on north', () => {
    expect(normalizeAzimuthDeg(359.9)).toBe(0);
    expect(normalizeAzimuthDeg(359.4)).toBe(359);
  });

  it('never returns negative zero or a value outside 0..359', () => {
    expect(Object.is(normalizeAzimuthDeg(-0.4), 0)).toBe(true);
    for (let d = -1000; d <= 1000; d += 37) {
      const n = normalizeAzimuthDeg(d);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(360);
    }
  });

  it('maps non-finite input to north rather than NaN', () => {
    expect(normalizeAzimuthDeg(NaN)).toBe(0);
    expect(normalizeAzimuthDeg(Infinity)).toBe(0);
    expect(normalizeAzimuthDeg(-Infinity)).toBe(0);
  });
});

describe('signedAzimuthDeg', () => {
  it.each([
    [0, 0], [90, 90], [179, 179], [180, 180], [181, -179], [270, -90],
    [359, -1], [360, 0], [-1, -1], [-90, -90], [-179, -179], [725, 5], [-725, -5],
  ])('expresses %d as %d', (input, expected) => {
    expect(signedAzimuthDeg(input)).toBe(expected);
  });

  it('puts the single ambiguous bearing, 180, on the positive end both ways', () => {
    expect(signedAzimuthDeg(180)).toBe(180);
    expect(signedAzimuthDeg(-180)).toBe(180);
  });

  it('lets a north-pointing sector rotate either way from 0', () => {
    expect(signedAzimuthDeg(0 - 10)).toBe(-10);
    expect(signedAzimuthDeg(0 + 10)).toBe(10);
  });

  it('always lands in (-180, 180]', () => {
    for (let d = -1000; d <= 1000; d += 29) {
      const s = signedAzimuthDeg(d);
      expect(s).toBeGreaterThan(-180);
      expect(s).toBeLessThanOrEqual(180);
    }
  });
});

/** What a traced ray carries that the PDF never reads. */
const RAY_JUNK = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: { color: '#ff0000', wall_loss_db: 12 },
    geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
  }],
};

function cell(id: string): SimulateResult['cells'][number] {
  return {
    cellId: id,
    name: `Cell ${id}`,
    azimuthDeg: 120,
    stats: {
      rays: 500, segmentCount: 9000, truncated: true,
      blockedRayPct: 12.5, avgReachM: 410, minReachM: 20, maxReachM: 900,
      avgEndSignalDbm: -97, wallEventTotal: 33,
      model: 'uma',
      declinedSamples: 4, declinedRays: 2, raysEvaluated: 498,
    },
    rays: RAY_JUNK,
    applicability: { applicable: true, warnings: ['x'] },
  } as unknown as SimulateResult['cells'][number];
}

describe('reportCells', () => {
  it('emits exactly the fields the PDF consumer declares, and nothing else', () => {
    const [out] = reportCells([cell('a')]);
    expect(Object.keys(out).sort()).toEqual(['azimuthDeg', 'cellId', 'name', 'stats']);
    expect(Object.keys(out.stats).sort()).toEqual([
      'avgReachM', 'blockedRayPct', 'declinedSamples', 'maxReachM',
      'minReachM', 'raysEvaluated', 'wallEventTotal',
    ]);
  });

  it('drops every ray geometry, so the posted body cannot grow with ray count (the HTTP 413 incident)', () => {
    const big = Array.from({ length: 50 }, (_, i) => cell(String(i)));
    const json = JSON.stringify(reportCells(big));
    expect(json).not.toContain('LineString');
    expect(json).not.toContain('coordinates');
    expect(json).not.toContain('FeatureCollection');
    expect(json).not.toContain('wall_loss_db');
    expect(json).not.toContain('applicability');
    expect(json.length).toBeLessThan(JSON.stringify(big).length / 2);
  });

  it('carries the values through unchanged and preserves order', () => {
    const out = reportCells([cell('a'), cell('b')]);
    expect(out.map(c => c.cellId)).toEqual(['a', 'b']);
    expect(out[0]).toMatchObject({
      name: 'Cell a', azimuthDeg: 120,
      stats: { avgReachM: 410, minReachM: 20, maxReachM: 900, blockedRayPct: 12.5,
        wallEventTotal: 33, declinedSamples: 4, raysEvaluated: 498 },
    });
  });

  it('keeps a null name as null and handles an empty list', () => {
    const c = cell('a');
    c.name = null;
    expect(reportCells([c])[0].name).toBeNull();
    expect(reportCells([])).toEqual([]);
  });
});

describe('reportQuality', () => {
  it('sends only the two fields the report counts', () => {
    const entry = {
      buildingId: 'b1', servingCellId: 'c1', interferenceLimited: true,
      interfererCount: 3, rsrpDbm: -90, sinrDb: 4, rsrqDb: -11, rssiDbm: -70,
      qualityClass: 'fair',
    } as SimulateResult['quality'][number];
    const [out] = reportQuality([entry]);
    expect(out).toEqual({ qualityClass: 'fair', interferenceLimited: true });
    expect(Object.keys(out)).toHaveLength(2);
  });
});

describe('reportGaps', () => {
  const gap = {
    cellId: 'c1',
    truncated: true,
    summary: {
      candidateBuildings: 10, servedBuildings: 7, gapBuildings: 3,
      totalDemandWeight: 5, servedDemandWeight: 3, unservedDemandWeight: 2,
      demandServedPct: 60, serviceThresholdDbm: -105,
    },
    gaps: [{
      buildingId: 'b9', bestRxDbm: null, combinedDemand: 4, demandWeight: 1,
      residentialDemand: 2, distanceM: 350, centroid: { lon: 1, lat: 2 }, reason: 'weak',
    }],
  };

  it('returns null when there are no gaps, rather than an empty list', () => {
    expect(reportGaps(null as unknown as SimulateResult['gaps'])).toBeNull();
    expect(reportGaps(undefined as unknown as SimulateResult['gaps'])).toBeNull();
  });

  it('strips centroids, demand breakdowns and totals', () => {
    const out = reportGaps([gap] as unknown as SimulateResult['gaps'])!;
    expect(Object.keys(out[0]).sort()).toEqual(['cellId', 'gaps', 'summary']);
    expect(out[0].summary).toEqual({
      candidateBuildings: 10, gapBuildings: 3, demandServedPct: 60, serviceThresholdDbm: -105,
    });
    expect(out[0].gaps[0]).toEqual({ buildingId: 'b9', combinedDemand: 4, bestRxDbm: null, distanceM: 350 });
    const json = JSON.stringify(out);
    expect(json).not.toContain('centroid');
    expect(json).not.toContain('reason');
    expect(json).not.toContain('truncated');
  });
});

const ANTENNA = {
  id: 'panel-x', vendor: 'V', model: 'M', label: 'V M',
  beamWidthDeg: 33, verticalBeamwidthDeg: 7, gainDbi: 18.5, frontToBackDb: 28,
  electricalDowntiltDeg: 3,
} as AntennaModel;

describe('SITE_LAYOUTS and createSite', () => {
  it('3-sector is 65 deg panels on 120 deg spacing', () => {
    const sectors = createSite('3-sector', 1, 10, 20);
    expect(sectors.map(s => s.azimuthDeg)).toEqual([0, 120, 240]);
    expect(sectors.every(s => s.beamWidthDeg === 65)).toBe(true);
    expect(sectors.map(s => s.sectorLabel)).toEqual(['A', 'B', 'C']);
  });

  it('4-sector is 45 deg panels on 90 deg spacing', () => {
    const sectors = createSite('4-sector', 2, 10, 20);
    expect(sectors.map(s => s.azimuthDeg)).toEqual([0, 90, 180, 270]);
    expect(sectors.every(s => s.beamWidthDeg === 45)).toBe(true);
    expect(sectors.map(s => s.sectorLabel)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('single is one Omni sector named after the site', () => {
    const [only, ...rest] = createSite('single', 3, 10, 20);
    expect(rest).toHaveLength(0);
    expect(only.sectorLabel).toBe('Omni');
    expect(only.name).toBe('Site 3');
    expect(only.beamWidthDeg).toBe(90);
  });

  it('sectors share one siteId, position and name, but have unique ids', () => {
    const sectors = createSite('3-sector', 4, 41.5, -87.25);
    expect(new Set(sectors.map(s => s.siteId)).size).toBe(1);
    expect(new Set(sectors.map(s => s.id)).size).toBe(3);
    expect(new Set(sectors.map(s => s.siteName))).toEqual(new Set(['Site 4']));
    expect(sectors.every(s => s.latitude === 41.5 && s.longitude === -87.25)).toBe(true);
    expect(sectors.map(s => s.name)).toEqual(['Site 4 A', 'Site 4 B', 'Site 4 C']);
  });

  it('uses CBRS n48 defaults', () => {
    const [s] = createSite('single', 1, 0, 0);
    expect(s).toMatchObject({ frequencyGhz: 3.6, bandwidthMhz: 20, technology: '5g' });
  });

  it('lets a loaded antenna own the whole pattern, overriding the layout beamwidth', () => {
    const sectors = createSite('3-sector', 1, 0, 0, ANTENNA);
    for (const s of sectors) {
      expect(s).toMatchObject({
        antennaModelId: 'panel-x', beamWidthDeg: 33, verticalBeamwidthDeg: 7,
        txAntennaGainDbi: 18.5, frontToBackDb: 28, electricalDowntiltDeg: 3,
      });
    }
  });

  it('layout table matches what the sites are built from', () => {
    expect(SITE_LAYOUTS['3-sector'].beamWidthDeg).toBe(65);
    expect(SITE_LAYOUTS['4-sector'].beamWidthDeg).toBe(45);
  });
});

describe('applyAntenna', () => {
  it('returns no overrides when no antenna is selected', () => {
    expect(applyAntenna()).toEqual({});
  });

  it('moves gain, both beamwidths, front-to-back and tilt together', () => {
    expect(applyAntenna(ANTENNA)).toEqual({
      antennaModelId: 'panel-x',
      beamWidthDeg: 33,
      verticalBeamwidthDeg: 7,
      txAntennaGainDbi: 18.5,
      frontToBackDb: 28,
      electricalDowntiltDeg: 3,
    });
  });

  it('touches nothing outside the pattern (position, power, mechanical tilt)', () => {
    const keys = Object.keys(applyAntenna(ANTENNA));
    for (const k of ['latitude', 'longitude', 'txPowerDbm', 'mechanicalDowntiltDeg', 'azimuthDeg', 'antennaHeightM']) {
      expect(keys).not.toContain(k);
    }
  });
});

describe('groupBySite', () => {
  it('groups sectors of one mast and preserves creation order', () => {
    const a = createSite('3-sector', 1, 0, 0);
    const b = createSite('single', 2, 1, 1);
    // Interleave so grouping must key on siteId, not adjacency.
    const groups = groupBySite([a[0], b[0], a[1], a[2]]);
    expect(groups).toHaveLength(2);
    expect(groups[0].siteId).toBe(a[0].siteId);
    expect(groups[0].siteName).toBe('Site 1');
    expect(groups[0].sectors.map(s => s.id)).toEqual([a[0].id, a[1].id, a[2].id]);
    expect(groups[1].sectors).toEqual([b[0]]);
  });

  it('returns an empty list for no radios', () => {
    expect(groupBySite([])).toEqual([]);
  });
});

describe('nextSectorLabel', () => {
  const withLabels = (...labels: string[]) =>
    labels.map(sectorLabel => ({ sectorLabel }) as PlanningRadio);

  it('starts at A', () => {
    expect(nextSectorLabel([])).toBe('A');
  });

  it('continues the sequence', () => {
    expect(nextSectorLabel(withLabels('A', 'B'))).toBe('C');
  });

  it('fills the first gap rather than appending', () => {
    expect(nextSectorLabel(withLabels('A', 'C'))).toBe('B');
  });

  it('falls back to S<n+1> once A-F are exhausted', () => {
    expect(nextSectorLabel(withLabels('A', 'B', 'C', 'D', 'E', 'F'))).toBe('S7');
  });
});
