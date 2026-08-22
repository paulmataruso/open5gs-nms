import { pointInPolygon } from '../polygon';

describe('polygon', () => {
  // A simple 1x1 degree square.
  const square = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 1 },
    { lat: 1, lon: 1 },
    { lat: 1, lon: 0 },
  ];

  test('a point clearly inside the square is inside', () => {
    expect(pointInPolygon({ lat: 0.5, lon: 0.5 }, square)).toBe(true);
  });

  test('a point clearly outside the square is outside', () => {
    expect(pointInPolygon({ lat: 2, lon: 2 }, square)).toBe(false);
    expect(pointInPolygon({ lat: -1, lon: 0.5 }, square)).toBe(false);
  });

  test('fewer than 3 vertices is never "inside"', () => {
    expect(pointInPolygon({ lat: 0.5, lon: 0.5 }, [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }])).toBe(false);
  });

  // A concave "arrow" shape: notch cut out of the top edge.
  const concave = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 4 },
    { lat: 4, lon: 4 },
    { lat: 4, lon: 2.5 },
    { lat: 2, lon: 2 },
    { lat: 4, lon: 1.5 },
    { lat: 4, lon: 0 },
  ];

  test('concave polygon: point inside the solid body is inside', () => {
    expect(pointInPolygon({ lat: 1, lon: 2 }, concave)).toBe(true);
  });

  test('concave polygon: point inside the cut-out notch is outside', () => {
    expect(pointInPolygon({ lat: 3.5, lon: 2 }, concave)).toBe(false);
  });
});
