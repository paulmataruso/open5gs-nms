import { calculatePointAnalysis } from '../point-analysis';

// Mocks elevation-provider directly (rather than terrain-profile) so
// terrain-profile's own real geometry/sampling logic still runs — only the
// actual tile fetch/parse is stubbed, keeping this test hermetic (no real
// network access) while still exercising the real integration path.
jest.mock('../elevation-provider', () => ({
  getElevationM: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getElevationM } = require('../elevation-provider');

describe('point-analysis', () => {
  beforeEach(() => {
    (getElevationM as jest.Mock).mockReset();
  });

  test('without useTerrainData, behaves exactly as the original flat-earth calculation', async () => {
    const result = await calculatePointAnalysis({
      siteLat: 37.7749, siteLon: -122.4194, siteHeightM: 30,
      targetLat: 37.7849, targetLon: -122.4094, targetHeightM: 1.5,
    });
    expect(result.ok).toBe(true);
    expect(result.result!.siteGroundElevationM).toBeUndefined();
    expect(result.warnings.some(w => w.code === 'ASSUMPTION_USED')).toBe(true);
    expect(getElevationM).not.toHaveBeenCalled();
  });

  test('with useTerrainData, real ground elevation shifts the effective height difference', async () => {
    // Site ground is much higher than target ground — even though the
    // caller's AGL heights are identical, the real elevation difference
    // should dominate the elevation angle (a much steeper downward angle
    // than the flat-earth case would predict).
    (getElevationM as jest.Mock).mockImplementation(async (lat: number) => (lat > 37.78 ? 50 : 500));

    const flat = await calculatePointAnalysis({
      siteLat: 37.7749, siteLon: -122.4194, siteHeightM: 10,
      targetLat: 37.7849, targetLon: -122.4094, targetHeightM: 10,
    });
    const terrain = await calculatePointAnalysis({
      siteLat: 37.7749, siteLon: -122.4194, siteHeightM: 10,
      targetLat: 37.7849, targetLon: -122.4094, targetHeightM: 10,
      useTerrainData: true, terrainSampleCount: 4,
    });

    expect(flat.ok).toBe(true);
    expect(terrain.ok).toBe(true);
    expect(terrain.result!.siteGroundElevationM).toBe(500);
    expect(terrain.result!.targetGroundElevationM).toBe(50);
    // Site sits 450m higher in real ground elevation than the target, on
    // top of identical AGL heights — the terrain-aware elevation angle
    // must be steeper (more negative) than the flat-earth one.
    expect(terrain.result!.elevationAngleDeg).toBeLessThan(flat.result!.elevationAngleDeg);
  });

  test('when elevation data is unavailable, falls back to flat-earth with an explicit warning, not a crash', async () => {
    (getElevationM as jest.Mock).mockResolvedValue(null);

    const result = await calculatePointAnalysis({
      siteLat: 37.7749, siteLon: -122.4194, siteHeightM: 30,
      targetLat: 37.7849, targetLon: -122.4094, targetHeightM: 1.5,
      useTerrainData: true, terrainSampleCount: 4,
    });
    expect(result.ok).toBe(true);
    expect(result.result!.siteGroundElevationM).toBeUndefined();
    expect(result.warnings.some(w => w.code === 'TERRAIN_DATA_UNAVAILABLE')).toBe(true);
  });
});
