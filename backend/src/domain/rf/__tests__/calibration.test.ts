import { calculateCalibrationOffset, SurveyPoint } from '../calibration';
import { computeSiteSignalAtPoint, ResolvedSiteParams } from '../site-signal';

const siteParams: ResolvedSiteParams = {
  siteLat: 37.7749, siteLon: -122.4194, siteHeightM: 30,
  azimuthDeg: 0, horizontalBeamwidthDeg: 90, verticalBeamwidthDeg: 10,
  totalDowntiltDeg: 2, frontToBackDb: 20,
  txPowerDbm: 40, cableLossDb: 2, connectorLossDb: 0.5, filterLossDb: 0,
  antennaGainDbi: 17, frequencyMhz: 1900, frequencyHz: 1_900_000_000,
  buildingLossDb: 0, foliageLossDb: 0, miscLossDb: 0, ueAntennaGainDbi: 0, receiverHeightM: 1.5,
  propagationModel: 'fspl', environment: 'urban', cityType: 'medium',
  useTerrainData: false, terrainSampleCount: 8,
};

const surveyLocations = [
  { lat: 37.7760, lon: -122.4190 },
  { lat: 37.7770, lon: -122.4180 },
  { lat: 37.7780, lon: -122.4170 },
  { lat: 37.7790, lon: -122.4160 },
];

async function buildSurveyPoints(trueOffsetDb: number): Promise<SurveyPoint[]> {
  const points: SurveyPoint[] = [];
  for (const loc of surveyLocations) {
    const signal = await computeSiteSignalAtPoint(siteParams, loc.lat, loc.lon);
    if (!signal) throw new Error('expected a valid signal at every test survey location');
    points.push({ lat: loc.lat, lon: loc.lon, measuredDbm: signal.totalReceivedPowerDbm + trueOffsetDb });
  }
  return points;
}

describe('calibration', () => {
  test('recovers a known positive offset (measured consistently stronger than predicted)', async () => {
    const surveyPoints = await buildSurveyPoints(5);
    const result = await calculateCalibrationOffset(surveyPoints, siteParams);
    expect(result).not.toBeNull();
    expect(result!.offsetDb).toBeCloseTo(5, 6);
    expect(result!.pointCount).toBe(surveyLocations.length);
    expect(result!.meanAbsErrorDb).toBeCloseTo(5, 6);
  });

  test('recovers a known negative offset (measured consistently weaker than predicted)', async () => {
    const surveyPoints = await buildSurveyPoints(-8);
    const result = await calculateCalibrationOffset(surveyPoints, siteParams);
    expect(result).not.toBeNull();
    expect(result!.offsetDb).toBeCloseTo(-8, 6);
  });

  test('a zero offset (perfectly matching measurements) reports ~0 error', async () => {
    const surveyPoints = await buildSurveyPoints(0);
    const result = await calculateCalibrationOffset(surveyPoints, siteParams);
    expect(result).not.toBeNull();
    expect(result!.offsetDb).toBeCloseTo(0, 6);
    expect(result!.meanAbsErrorDb).toBeCloseTo(0, 6);
  });

  test('mixed errors average out correctly (not just absolute-value averaged)', async () => {
    const base = await buildSurveyPoints(0);
    const mixed: SurveyPoint[] = base.map((p, i) => ({ ...p, measuredDbm: p.measuredDbm + (i % 2 === 0 ? 10 : -10) }));
    const result = await calculateCalibrationOffset(mixed, siteParams);
    expect(result).not.toBeNull();
    // Equal +10/-10 swings should average to ~0 offset, but nonzero mean absolute error.
    expect(result!.offsetDb).toBeCloseTo(0, 6);
    expect(result!.meanAbsErrorDb).toBeCloseTo(10, 6);
  });

  test('no survey points returns null, not an error or a fabricated zero', async () => {
    const result = await calculateCalibrationOffset([], siteParams);
    expect(result).toBeNull();
  });

  test('a survey point outside the propagation model\'s valid range is skipped, not fatal', async () => {
    const hataParams: ResolvedSiteParams = { ...siteParams, propagationModel: 'hata', frequencyMhz: 900, frequencyHz: 900_000_000 };
    const surveyPoints: SurveyPoint[] = [
      { lat: 37.7749, lon: -122.4194 }, // essentially at the site itself — well under Hata's 1km minimum
      { lat: 37.8200, lon: -122.3700 }, // several km away — within Hata's valid range
    ].map(p => ({ ...p, measuredDbm: -80 }));
    const result = await calculateCalibrationOffset(surveyPoints, hataParams);
    expect(result).not.toBeNull();
    expect(result!.pointCount).toBeLessThan(surveyPoints.length);
    expect(result!.skippedCount).toBeGreaterThan(0);
  });
});
