// Standard ray-casting point-in-polygon test, applied directly to lat/lon
// pairs treated as planar (x,y) coordinates — a well-established
// simplification at RF-planning scale (a target area a few km across),
// where longitude-degree convergence toward the poles is negligible.

import { LatLon } from './rf-types';

export function pointInPolygon(point: LatLon, vertices: LatLon[]): boolean {
  if (vertices.length < 3) return false;
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i].lon, yi = vertices[i].lat;
    const xj = vertices[j].lon, yj = vertices[j].lat;
    const intersects = (yi > point.lat) !== (yj > point.lat) &&
      point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}
