import {
  traceBeam, beamAngleForIndex, normalizeDeg, signedAngleDelta, penetrationLossDb,
  signalColorRgb, raySegmentsToGeoJson, SEGMENT_STEP_M, type RayTraceProfile,
} from '../ray-trace';
import { BuildingIndex, BuildingFootprint, destinationPoint } from '../building-index';

const ORIGIN = { lon: -72.180426, lat: 43.375298 }; // a real site on this deployment

/** CBRS n48 sector, 27 dBm conducted, 60 degree beam — real registered values. */
const PROFILE: RayTraceProfile = {
  frequencyGhz: 3.6,
  txPowerDbm: 27,
  txAntennaGainDbi: 6,
  rxAntennaGainDbi: 0,
  systemLossDb: 0,
  polarizationLossDb: 0,
  antennaHeightM: 25,
  receiverHeightM: 1.5,
  beamWidthDeg: 60,
  receiverSensitivityDbm: -110,
};

function square(id: string, lon: number, lat: number, spanDeg: number, extra: Partial<BuildingFootprint> = {}): BuildingFootprint {
  const h = spanDeg / 2;
  return { id, ring: [[lon - h, lat - h], [lon + h, lat - h], [lon + h, lat + h], [lon - h, lat + h]], ...extra };
}

describe('beam geometry', () => {
  test('a single ray points down boresight, not the beam edge', () => {
    expect(beamAngleForIndex(90, 60, 1, 0)).toBeCloseTo(90, 6);
  });

  test('rays are evenly spaced and symmetric about the azimuth', () => {
    // 4 rays across 60 deg -> 15 deg slices, sampled at their midpoints.
    expect(beamAngleForIndex(90, 60, 4, 0)).toBeCloseTo(67.5, 6);
    expect(beamAngleForIndex(90, 60, 4, 1)).toBeCloseTo(82.5, 6);
    expect(beamAngleForIndex(90, 60, 4, 2)).toBeCloseTo(97.5, 6);
    expect(beamAngleForIndex(90, 60, 4, 3)).toBeCloseTo(112.5, 6);
    // Symmetric: first and last are equidistant from the azimuth.
    expect(90 - beamAngleForIndex(90, 60, 4, 0)).toBeCloseTo(beamAngleForIndex(90, 60, 4, 3) - 90, 6);
  });

  test('bearings wrap correctly through north', () => {
    expect(beamAngleForIndex(0, 60, 2, 0)).toBeCloseTo(345, 6);
    expect(normalizeDeg(-30)).toBeCloseTo(330, 6);
    expect(normalizeDeg(400)).toBeCloseTo(40, 6);
  });

  test('signed delta takes the short way round', () => {
    expect(signedAngleDelta(350, 10)).toBeCloseTo(20, 6);
    expect(signedAngleDelta(10, 350)).toBeCloseTo(-20, 6);
    expect(signedAngleDelta(90, 90)).toBeCloseTo(0, 6);
  });

  test('penetration loss steps with frequency band', () => {
    expect(penetrationLossDb(3.6)).toBe(8);   // CBRS
    expect(penetrationLossDb(28)).toBe(30);   // cm-wave
    expect(penetrationLossDb(140)).toBe(80);  // sub-THz
  });
});

describe('traceBeam in clear space', () => {
  test('every ray reaches the full radius with no buildings', () => {
    const r = traceBeam({ origin: ORIGIN, azimuthDeg: 90, rays: 12, radiusM: 300, profile: PROFILE });
    expect(r.terminals).toHaveLength(12);
    expect(r.terminals.every(t => !t.blocked)).toBe(true);
    expect(r.stats.blockedRayPct).toBe(0);
    expect(r.stats.maxReachM).toBeCloseTo(300, 0);
    expect(r.stats.wallEventTotal).toBe(0);
  });

  test('segment count follows radius / step per ray', () => {
    const rays = 8, radiusM = 200;
    const r = traceBeam({ origin: ORIGIN, azimuthDeg: 0, rays, radiusM, profile: PROFILE });
    expect(r.stats.segmentCount).toBe(rays * (radiusM / SEGMENT_STEP_M));
  });

  test('with zero downtilt the strongest ground point is the nearest one', () => {
    // Boresight is horizontal, so pattern gain keeps improving with distance
    // while path loss grows faster. Net result: the best ground sample is the
    // closest one. This is the textbook argument FOR downtilt, and the next
    // test demonstrates it.
    const r = traceBeam({ origin: ORIGIN, azimuthDeg: 90, rays: 1, radiusM: 600, profile: PROFILE });
    const ray = r.segments.filter(s => s.rayIndex === 0).sort((a, b) => a.endDistanceM - b.endDistanceM);
    const signals = ray.map(s => s.endSignalDbm);
    expect(signals.indexOf(Math.max(...signals))) .toBe(0);
    // And it is genuinely weaker at the far edge than near in.
    expect(signals[signals.length - 1]).toBeLessThan(signals[0]);
  });

  test('downtilt steers the peak to the tilt-matched distance', () => {
    // 10 deg of downtilt on a 23.5 m height differential puts boresight on the
    // ground at 23.5/tan(10 deg) ~ 133 m.
    const tilted = traceBeam({
      origin: ORIGIN, azimuthDeg: 90, rays: 1, radiusM: 600,
      profile: { ...PROFILE, mechanicalDowntiltDeg: 10 },
    });
    const ray = tilted.segments.filter(s => s.rayIndex === 0).sort((a, b) => a.endDistanceM - b.endDistanceM);
    const signals = ray.map(s => s.endSignalDbm);
    const peakDistance = ray[signals.indexOf(Math.max(...signals))].endDistanceM;
    // Within one segment step of the predicted 133 m.
    expect(peakDistance).toBeGreaterThanOrEqual(100);
    expect(peakDistance).toBeLessThanOrEqual(150);
  });

  test('downtilt trades horizon reach for mid-range gain', () => {
    const flat = traceBeam({ origin: ORIGIN, azimuthDeg: 90, rays: 1, radiusM: 600, profile: PROFILE });
    const tilted = traceBeam({
      origin: ORIGIN, azimuthDeg: 90, rays: 1, radiusM: 600,
      profile: { ...PROFILE, mechanicalDowntiltDeg: 10 },
    });
    const at = (r: typeof flat, distance: number) =>
      r.segments.find(s => s.rayIndex === 0 && s.endDistanceM === distance)!.endSignalDbm;
    // Stronger where the beam now points...
    expect(at(tilted, 125)).toBeGreaterThan(at(flat, 125));
    // ...and weaker out at the horizon, which is the whole trade.
    expect(at(tilted, 600)).toBeLessThan(at(flat, 600));
  });

  test('an omnidirectional-style wide vertical beam decays monotonically throughout', () => {
    const wide = { ...PROFILE, verticalBeamwidthDeg: 120 };
    const r = traceBeam({ origin: ORIGIN, azimuthDeg: 90, rays: 1, radiusM: 300, profile: wide });
    const ray0 = r.segments.filter(s => s.rayIndex === 0).sort((a, b) => a.endDistanceM - b.endDistanceM);
    for (let i = 1; i < ray0.length; i++) {
      expect(ray0[i].endSignalDbm).toBeLessThan(ray0[i - 1].endSignalDbm);
    }
  });

  test('boresight ray is stronger than a beam-edge ray at equal distance', () => {
    const r = traceBeam({ origin: ORIGIN, azimuthDeg: 90, rays: 9, radiusM: 200, profile: PROFILE });
    const atEdge = r.segments.filter(s => s.rayIndex === 0 && s.endDistanceM === 200)[0];
    const atCentre = r.segments.filter(s => s.rayIndex === 4 && s.endDistanceM === 200)[0];
    expect(atCentre.endSignalDbm).toBeGreaterThan(atEdge.endSignalDbm);
  });

  test('collectSegments:false still produces stats, but no features', () => {
    const r = traceBeam({ origin: ORIGIN, azimuthDeg: 90, rays: 6, radiusM: 200, profile: PROFILE, collectSegments: false });
    expect(r.segments).toHaveLength(0);
    expect(r.terminals).toHaveLength(6);
    expect(r.stats.avgReachM).toBeGreaterThan(0);
  });

  test('a zero radius terminates immediately without crashing', () => {
    const r = traceBeam({ origin: ORIGIN, azimuthDeg: 90, rays: 4, radiusM: 0, profile: PROFILE });
    expect(r.segments).toHaveLength(0);
    expect(r.terminals).toHaveLength(4);
  });
});

describe('traceBeam against buildings', () => {
  /** A tall wall across the beam, ~100 m east of the site. */
  function wallEast(): BuildingIndex {
    const target = destinationPoint(ORIGIN, 90, 100);
    return new BuildingIndex([
      square('wall', target.lon, target.lat, 0.0012, { heightM: 45, heightSource: 'tag' }),
    ]);
  }

  test('a tall building charges wall loss and marks segments NLOS', () => {
    const buildings = wallEast();
    const r = traceBeam({ origin: ORIGIN, azimuthDeg: 90, rays: 5, radiusM: 400, profile: PROFILE, buildings });
    expect(r.stats.wallEventTotal).toBeGreaterThan(0);
    const withWallLoss = r.segments.filter(s => s.wallLossDb > 0);
    expect(withWallLoss.length).toBeGreaterThan(0);
    expect(withWallLoss.every(s => s.losState === 'nlos')).toBe(true);
    expect(withWallLoss[0].obstructingBuildingId).toBe('wall');
  });

  test('wall loss accumulates per crossing, in 8 dB steps at CBRS', () => {
    const r = traceBeam({ origin: ORIGIN, azimuthDeg: 90, rays: 1, radiusM: 400, profile: PROFILE, buildings: wallEast() });
    const losses = [...new Set(r.segments.map(s => s.wallLossDb))].sort((a, b) => a - b);
    // 0 before the wall, then 8 (entry) and 16 (exit).
    expect(losses).toContain(0);
    expect(losses).toContain(8);
    expect(losses).toContain(16);
  });

  test('the obstructed case is strictly worse than the clear case', () => {
    const clear = traceBeam({ origin: ORIGIN, azimuthDeg: 90, rays: 5, radiusM: 400, profile: PROFILE });
    const blocked = traceBeam({ origin: ORIGIN, azimuthDeg: 90, rays: 5, radiusM: 400, profile: PROFILE, buildings: wallEast() });
    expect(blocked.stats.avgEndSignalDbm).toBeLessThan(clear.stats.avgEndSignalDbm);
  });

  test('buildings in the beam get a recorded best received power', () => {
    const r = traceBeam({ origin: ORIGIN, azimuthDeg: 90, rays: 5, radiusM: 400, profile: PROFILE, buildings: wallEast() });
    expect(r.buildingCoverage.get('wall')).toBeDefined();
    expect(r.buildingCoverage.get('wall')).toBeLessThan(PROFILE.txPowerDbm);
  });

  test('enough walls eventually terminate the ray below sensitivity', () => {
    // A stack of ten tall blocks: 20 crossings x 8 dB = 160 dB of wall loss.
    const blocks: BuildingFootprint[] = [];
    for (let i = 0; i < 10; i++) {
      const p = destinationPoint(ORIGIN, 90, 40 + i * 25);
      blocks.push(square(`b${i}`, p.lon, p.lat, 0.0002, { heightM: 45, heightSource: 'tag' }));
    }
    const r = traceBeam({
      origin: ORIGIN, azimuthDeg: 90, rays: 1, radiusM: 400, profile: PROFILE,
      buildings: new BuildingIndex(blocks),
    });
    expect(r.terminals[0].blocked).toBe(true);
    expect(r.terminals[0].reachM).toBeLessThan(400);
    expect(r.stats.blockedRayPct).toBe(100);
  });

  test('a low shed does not stop the ray', () => {
    const p = destinationPoint(ORIGIN, 90, 60);
    const r = traceBeam({
      origin: ORIGIN, azimuthDeg: 90, rays: 1, radiusM: 300, profile: PROFILE,
      buildings: new BuildingIndex([square('shed', p.lon, p.lat, 0.0004, { heightM: 2.5, heightSource: 'tag' })]),
    });
    // It is crossed (so it costs wall loss) but the ray still runs the radius.
    expect(r.stats.wallEventTotal).toBeGreaterThan(0);
    expect(r.terminals[0].reachM).toBeCloseTo(300, 0);
  });
});

describe('output shaping', () => {
  test('colour ramp moves green -> amber -> red -> violet as signal falls', () => {
    expect(signalColorRgb(-70)).toEqual([5, 150, 105]);
    expect(signalColorRgb(-85)).toEqual([34, 197, 94]);
    expect(signalColorRgb(-95)).toEqual([245, 158, 11]);
    expect(signalColorRgb(-105)).toEqual([225, 29, 72]);
    expect(signalColorRgb(-130)).toEqual([126, 34, 206]);
  });

  test('GeoJSON output is a valid LineString FeatureCollection with evidence', () => {
    const r = traceBeam({ origin: ORIGIN, azimuthDeg: 90, rays: 3, radiusM: 100, profile: PROFILE });
    const fc = raySegmentsToGeoJson(r) as any;
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(r.segments.length);
    const f = fc.features[0];
    expect(f.geometry.type).toBe('LineString');
    expect(f.geometry.coordinates).toHaveLength(2);
    expect(typeof f.properties.signal_dbm).toBe('number');
    expect(f.properties.color).toMatch(/^rgb\(/);
    expect(f.properties).toHaveProperty('los_state');
    expect(f.properties).toHaveProperty('wall_loss_db');
  });
});
