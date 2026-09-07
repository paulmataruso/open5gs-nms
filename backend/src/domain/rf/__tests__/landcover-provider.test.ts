import {
  tileSwCornerForLatLon, tileKeyFor, snapToTileEdge, pixelIndicesForLatLon, WorldCoverClass,
} from '../landcover-provider';

// All tests here exercise the pure tile-addressing and pixel-coordinate
// math directly — no real network access, no real GeoTIFF parsing, so this
// suite is fully hermetic in CI, same reasoning as elevation-provider.
// test.ts's own header comment. The real fetch/cache/parse/classify path
// (getLandCoverClass) was verified live against the actual ESA WorldCover
// S3 bucket during this feature's manual verification step, not here —
// including the exact real-world bug this suite's edge-case tests guard
// against (see snapToTileEdge's own comment): lat=42.0 against a real
// N42W096 tile (spans [42,45)) silently returned null before the fix,
// because dividing by WorldCover's 1/12000° resolution isn't exact in
// floating point and computed row=36000 for a 36000-pixel-tall image.

describe('landcover-provider: tile addressing', () => {
  test('tileSwCornerForLatLon floors both coordinates to the tile\'s 3-degree southwest corner', () => {
    expect(tileSwCornerForLatLon(36.5, -81.8)).toEqual({ swLat: 36, swLon: -84 });
    expect(tileSwCornerForLatLon(42.0, -93.5)).toEqual({ swLat: 42, swLon: -96 });
    expect(tileSwCornerForLatLon(0.1, 0.1)).toEqual({ swLat: 0, swLon: 0 });
    expect(tileSwCornerForLatLon(-33.9, 18.4)).toEqual({ swLat: -36, swLon: 18 });
  });

  // Verified directly against real S3 keys returned by a live
  // ListObjectsV2 call against s3://esa-worldcover/v200/2021/map/ —
  // ESA_WorldCover_10m_2021_v200_N00E006_Map.tif and _N00E009_Map.tif were
  // both observed, confirming this exact zero-padded N/S+E/W format.
  test('tileKeyFor matches ESA WorldCover\'s own real S3 key format', () => {
    expect(tileKeyFor({ swLat: 0, swLon: 6 })).toBe('N00E006');
    expect(tileKeyFor({ swLat: 0, swLon: 9 })).toBe('N00E009');
    expect(tileKeyFor({ swLat: 36, swLon: -84 })).toBe('N36W084');
    expect(tileKeyFor({ swLat: -36, swLon: 18 })).toBe('S36E018');
  });
});

describe('landcover-provider: snapToTileEdge', () => {
  test('passes through an in-bounds index unchanged', () => {
    expect(snapToTileEdge(0, 36000)).toBe(0);
    expect(snapToTileEdge(35999, 36000)).toBe(35999);
    expect(snapToTileEdge(18000, 36000)).toBe(18000);
  });

  test('snaps a by-1 overshoot at either edge to the nearest valid pixel (the real bug found live)', () => {
    expect(snapToTileEdge(36000, 36000)).toBe(35999);
    expect(snapToTileEdge(-1, 36000)).toBe(0);
  });

  test('rejects anything more than 1 pixel out of range as a real out-of-tile coordinate', () => {
    expect(snapToTileEdge(36001, 36000)).toBeNull();
    expect(snapToTileEdge(-2, 36000)).toBeNull();
    expect(snapToTileEdge(100000, 36000)).toBeNull();
  });
});

describe('landcover-provider: pixelIndicesForLatLon', () => {
  // A real WorldCover tile's own georeferencing shape: origin at the NW
  // corner, resX positive (east), resY negative (south), 36000x36000 at
  // 3deg/36000px = 1/12000 deg per pixel — matches the real N42W096 tile
  // inspected live (origin [-96,45], resolution [0.0000833..., -0.0000833...]).
  const ORIGIN_X = -96, ORIGIN_Y = 45;
  const RES_X = 3 / 36000, RES_Y = -3 / 36000;
  const SIZE = 36000;

  test('resolves an interior point to the correct pixel', () => {
    // 1 pixel south-east of the NW corner.
    const lat = ORIGIN_Y + RES_Y * 1.5;
    const lon = ORIGIN_X + RES_X * 1.5;
    expect(pixelIndicesForLatLon(lat, lon, ORIGIN_X, ORIGIN_Y, RES_X, RES_Y, SIZE, SIZE)).toEqual({ row: 1, col: 1 });
  });

  test('resolves the exact NW corner to pixel (0,0)', () => {
    expect(pixelIndicesForLatLon(ORIGIN_Y, ORIGIN_X, ORIGIN_X, ORIGIN_Y, RES_X, RES_Y, SIZE, SIZE)).toEqual({ row: 0, col: 0 });
  });

  test('resolves the exact SE corner (south/east edge) to the last valid pixel, not null — the real bug', () => {
    const southEdgeLat = ORIGIN_Y + RES_Y * SIZE; // = 42.0 for the real N42W096 case
    const eastEdgeLon = ORIGIN_X + RES_X * SIZE; // = -93.0
    expect(pixelIndicesForLatLon(southEdgeLat, eastEdgeLon, ORIGIN_X, ORIGIN_Y, RES_X, RES_Y, SIZE, SIZE))
      .toEqual({ row: SIZE - 1, col: SIZE - 1 });
  });

  test('returns null for a point genuinely outside the tile', () => {
    expect(pixelIndicesForLatLon(50, ORIGIN_X, ORIGIN_X, ORIGIN_Y, RES_X, RES_Y, SIZE, SIZE)).toBeNull();
    expect(pixelIndicesForLatLon(ORIGIN_Y, -50, ORIGIN_X, ORIGIN_Y, RES_X, RES_Y, SIZE, SIZE)).toBeNull();
  });
});

describe('landcover-provider: WorldCoverClass', () => {
  // Transcribed directly from Table 3 (p.15-16) of ESA's own
  // WorldCover_PUM_V2.0.pdf, fetched and read directly — not recalled.
  test('numeric codes match the official Product User Manual exactly', () => {
    expect(WorldCoverClass.TreeCover).toBe(10);
    expect(WorldCoverClass.Shrubland).toBe(20);
    expect(WorldCoverClass.Grassland).toBe(30);
    expect(WorldCoverClass.Cropland).toBe(40);
    expect(WorldCoverClass.BuiltUp).toBe(50);
    expect(WorldCoverClass.BareOrSparseVegetation).toBe(60);
    expect(WorldCoverClass.SnowAndIce).toBe(70);
    expect(WorldCoverClass.PermanentWaterBodies).toBe(80);
    expect(WorldCoverClass.HerbaceousWetland).toBe(90);
    expect(WorldCoverClass.Mangroves).toBe(95);
    expect(WorldCoverClass.MossAndLichen).toBe(100);
  });
});
