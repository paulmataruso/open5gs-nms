import {
  BuildingIndex, BuildingFootprint, segmentIntersection, pointInRing,
  destinationPoint, groundDistanceM, parseLengthMetres, resolveBuildingHeightM,
  UNKNOWN_BUILDING_HEIGHT_M, METRES_PER_BUILDING_LEVEL,
} from '../building-index';

/** Axis-aligned square footprint of the given span, centred on lon/lat. */
function square(id: string, lon: number, lat: number, spanDeg: number, extra: Partial<BuildingFootprint> = {}): BuildingFootprint {
  const h = spanDeg / 2;
  return {
    id,
    ring: [
      [lon - h, lat - h], [lon + h, lat - h], [lon + h, lat + h], [lon - h, lat + h],
    ],
    ...extra,
  };
}

describe('geometry primitives', () => {
  test('crossing segments intersect; non-crossing do not', () => {
    expect(segmentIntersection(0, 0, 2, 2, 0, 2, 2, 0)).not.toBeNull();
    expect(segmentIntersection(0, 0, 1, 1, 2, 2, 3, 3)).toBeNull();
  });

  test('parallel segments never intersect', () => {
    expect(segmentIntersection(0, 0, 1, 0, 0, 1, 1, 1)).toBeNull();
  });

  test('point-in-ring is true inside and false outside', () => {
    const ring: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    expect(pointInRing(0.5, 0.5, ring)).toBe(true);
    expect(pointInRing(1.5, 0.5, ring)).toBe(false);
  });

  test('destination point north of origin increases latitude only', () => {
    const d = destinationPoint({ lon: -72.18, lat: 43.375 }, 0, 100);
    expect(d.lat).toBeGreaterThan(43.375);
    expect(d.lon).toBeCloseTo(-72.18, 9);
    expect(groundDistanceM({ lon: -72.18, lat: 43.375 }, d)).toBeCloseTo(100, 1);
  });

  test('destination/distance round-trips at several bearings', () => {
    const origin = { lon: -72.18, lat: 43.375 };
    for (const bearing of [0, 45, 90, 180, 270, 315]) {
      const p = destinationPoint(origin, bearing, 250);
      expect(groundDistanceM(origin, p)).toBeCloseTo(250, 0);
    }
  });
});

describe('height resolution', () => {
  test('parses metres and feet, rejects nonsense', () => {
    expect(parseLengthMetres('12')).toBeCloseTo(12, 9);
    expect(parseLengthMetres('12 m')).toBeCloseTo(12, 9);
    expect(parseLengthMetres("40'")).toBeCloseTo(12.192, 3);
    expect(parseLengthMetres('tall')).toBeNull();
    expect(parseLengthMetres(undefined)).toBeNull();
  });

  test('explicit height is measured evidence', () => {
    const r = resolveBuildingHeightM(square('a', 0, 0, 0.001, { heightM: 18 }));
    expect(r.heightM).toBe(18);
    expect(r.evidence).toBe('measured');
  });

  test('levels become a derived height', () => {
    const r = resolveBuildingHeightM(square('a', 0, 0, 0.001, { tags: { 'building:levels': '4' } }));
    expect(r.heightM).toBeCloseTo(4 * METRES_PER_BUILDING_LEVEL, 9);
    expect(r.evidence).toBe('derived');
  });

  test('no evidence falls back to the assumed low-rise default', () => {
    const r = resolveBuildingHeightM(square('a', 0, 0, 0.001));
    expect(r.heightM).toBe(UNKNOWN_BUILDING_HEIGHT_M);
    expect(r.evidence).toBe('assumed');
  });
});

describe('BuildingIndex', () => {
  const lon = -72.18, lat = 43.375;

  test('an empty index classifies everything as clear LOS', () => {
    const index = new BuildingIndex([]);
    expect(index.size).toBe(0);
    const c = index.classifyPath({ lon, lat }, 25, destinationPoint({ lon, lat }, 90, 300), 1.5);
    expect(c.state).toBe('los');
    expect(c.wallEventCount).toBe(0);
  });

  test('a ray through a footprint records two wall crossings, ordered', () => {
    const blocker = square('b1', lon + 0.001, lat, 0.0004, { heightM: 20 });
    const index = new BuildingIndex([blocker]);
    const hits = index.segmentIntersections({ lon, lat }, destinationPoint({ lon, lat }, 90, 400));
    expect(hits.length).toBe(2); // entry and exit wall
    expect(hits[0].distanceM).toBeLessThan(hits[1].distanceM);
    expect(hits[0].building.id).toBe('b1');
  });

  test('a tall building between tx and rx is NLOS', () => {
    const index = new BuildingIndex([square('tall', lon + 0.001, lat, 0.0004, { heightM: 40, heightSource: 'tag' })]);
    const c = index.classifyPath({ lon, lat }, 25, destinationPoint({ lon, lat }, 90, 400), 1.5);
    expect(c.state).toBe('nlos');
    expect(c.obstructions.map(b => b.id)).toContain('tall');
    expect(c.heightEvidence).toBe('measured');
  });

  test('a low shed under the ray does NOT block it — the pessimism trap', () => {
    // Ray from 25 m down to 1.5 m over 400 m; at ~80 m along, the ray is still
    // ~20 m up, so a 3 m shed must not count as blockage.
    const index = new BuildingIndex([square('shed', lon + 0.001, lat, 0.0004, { heightM: 3, heightSource: 'tag' })]);
    const c = index.classifyPath({ lon, lat }, 25, destinationPoint({ lon, lat }, 90, 400), 1.5);
    expect(c.state).toBe('los');
    expect(c.wallEventCount).toBe(2);       // it was crossed
    expect(c.obstructions).toHaveLength(0); // but it did not obstruct
  });

  test('blockage resting only on an assumed height reports unknown, not NLOS', () => {
    // No height tags at all -> assumed 6 m default. The footprint has to sit
    // where the ray is genuinely BELOW 6 m, otherwise it correctly does not
    // obstruct: from 8 m down to 1.5 m over 200 m, the ray only drops under
    // 6 m past ~62 m, so place it at ~150 m (0.00185 deg of longitude here).
    const index = new BuildingIndex([square('untagged', lon + 0.00185, lat, 0.0004)]);
    const c = index.classifyPath({ lon, lat }, 8, destinationPoint({ lon, lat }, 90, 200), 1.5);
    expect(c.obstructions.length).toBeGreaterThan(0);
    expect(c.state).toBe('unknown');
    expect(c.heightEvidence).toBe('assumed');
    expect(c.detail).toMatch(/assumed/);
  });

  test('containingBuilding detects an indoor point', () => {
    const index = new BuildingIndex([square('b', lon, lat, 0.001, { heightM: 10 })]);
    expect(index.containingBuilding({ lon, lat })?.id).toBe('b');
    expect(index.containingBuilding({ lon: lon + 0.01, lat })).toBeNull();
  });

  test('degenerate footprints are rejected, not indexed', () => {
    const index = new BuildingIndex([
      { id: 'two-point', ring: [[0, 0], [1, 1]] },
      { id: 'nan', ring: [[0, 0], [Number.NaN, 1], [1, 1]] },
    ]);
    expect(index.size).toBe(0);
  });

  test('scales to many footprints and still finds the right one', () => {
    const many: BuildingFootprint[] = [];
    for (let i = 0; i < 2000; i++) {
      many.push(square(`b${i}`, lon + (i % 50) * 0.0004, lat + Math.floor(i / 50) * 0.0004, 0.0002, { heightM: 9 }));
    }
    const index = new BuildingIndex(many);
    expect(index.size).toBe(2000);
    const hits = index.segmentIntersections({ lon: lon - 0.001, lat }, { lon: lon + 0.02, lat });
    expect(hits.length).toBeGreaterThan(0);
    // Ordered by distance from the start.
    for (let i = 1; i < hits.length; i++) expect(hits[i].distanceM).toBeGreaterThanOrEqual(hits[i - 1].distanceM);
  });
});
