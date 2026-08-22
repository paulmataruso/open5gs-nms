import {
  tileSwCornerForLatLon, tileKeyFor, parseHgtBuffer, elevationFromTile,
} from '../elevation-provider';

// All tests here exercise the pure tile-math functions directly against a
// small synthetic buffer — no real network access, no real tile files, so
// this suite is fully hermetic in CI. The real fetch/cache/download path
// (getElevationM) is exercised live against the actual deployed backend
// container as part of this feature's manual verification step, not here.

describe('elevation-provider: tile addressing', () => {
  test('tileSwCornerForLatLon floors both coordinates to the tile\'s southwest corner', () => {
    expect(tileSwCornerForLatLon(37.5, -122.5)).toEqual({ swLat: 37, swLon: -123 });
    expect(tileSwCornerForLatLon(-33.9, 18.4)).toEqual({ swLat: -34, swLon: 18 });
    expect(tileSwCornerForLatLon(0.1, 0.1)).toEqual({ swLat: 0, swLon: 0 });
  });

  test('tileKeyFor formats N/S and E/W with correct zero-padded magnitudes', () => {
    expect(tileKeyFor({ swLat: 37, swLon: -123 })).toBe('N37W123');
    expect(tileKeyFor({ swLat: -34, swLon: 18 })).toBe('S34E018');
    expect(tileKeyFor({ swLat: 0, swLon: 0 })).toBe('N00E000');
  });
});

describe('elevation-provider: .hgt parsing (synthetic buffer)', () => {
  const SIZE = 4;
  const VOID = -32768;
  // Row 0 = north edge, row (SIZE-1) = south edge; col 0 = west, col (SIZE-1) = east.
  const values = [
    10, 11, 12, 13,
    20, 21, 22, 23,
    30, 31, 32, VOID,
    40, 41, 42, 43,
  ];

  function buildBuffer(): Buffer {
    const buf = Buffer.alloc(SIZE * SIZE * 2);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let i = 0; i < values.length; i++) view.setInt16(i * 2, values[i], false);
    return buf;
  }

  test('parseHgtBuffer reads big-endian 16-bit values into an Int16Array matching the source order', () => {
    const parsed = parseHgtBuffer(buildBuffer(), SIZE);
    expect(Array.from(parsed)).toEqual(values);
  });

  test('elevationFromTile resolves an interior point to the correct grid cell', () => {
    const tile = parseHgtBuffer(buildBuffer(), SIZE);
    const coords = { swLat: 37, swLon: -123 };
    // row=2 -> lat = 38 - (2/3) = 37.3333...; col=1 -> lon = -123 + (1/3) = -122.6667
    const elevation = elevationFromTile(tile, SIZE, coords, 37 + 1 / 3, -123 + 1 / 3);
    expect(elevation).toBe(31);
  });

  test('elevationFromTile returns null for a void pixel rather than -32768', () => {
    const tile = parseHgtBuffer(buildBuffer(), SIZE);
    const coords = { swLat: 37, swLon: -123 };
    // row=2, col=3 -> lat = 38 - (2/3); lon = -123 + 1 = -122
    const elevation = elevationFromTile(tile, SIZE, coords, 38 - 2 / 3, -122);
    expect(elevation).toBeNull();
  });

  test('elevationFromTile resolves the four corners correctly (row0=north, col0=west)', () => {
    const tile = parseHgtBuffer(buildBuffer(), SIZE);
    const coords = { swLat: 37, swLon: -123 };
    expect(elevationFromTile(tile, SIZE, coords, 38, -123)).toBe(10); // NW
    expect(elevationFromTile(tile, SIZE, coords, 38, -122)).toBe(13); // NE
    expect(elevationFromTile(tile, SIZE, coords, 37, -123)).toBe(40); // SW
    expect(elevationFromTile(tile, SIZE, coords, 37, -122)).toBe(43); // SE
  });

  test('elevationFromTile returns null for a point outside this tile\'s bounds', () => {
    const tile = parseHgtBuffer(buildBuffer(), SIZE);
    const coords = { swLat: 37, swLon: -123 };
    expect(elevationFromTile(tile, SIZE, coords, 39, -123)).toBeNull();
    expect(elevationFromTile(tile, SIZE, coords, 37, -120)).toBeNull();
  });
});
