// Samples ground elevation at even intervals along the great-circle path
// between two points, for diffraction.ts's Deygout knife-edge model.
// Elevation may be null at any sample (unfetchable tile, void/ocean pixel)
// — resolving that into a fallback decision is the caller's job (see
// coverage-grid.ts's degrade-to-flat-earth logic), not this module's.

import pino from 'pino';
import { haversineDistanceM, initialBearingDeg, destinationPoint } from './geometry';
import { getElevationM } from './elevation-provider';

export interface RawTerrainProfilePoint {
  distanceM: number;
  elevationM: number | null;
}

export async function getTerrainProfile(
  siteLat: number, siteLon: number, targetLat: number, targetLon: number,
  sampleCount: number, logger?: pino.Logger,
): Promise<RawTerrainProfilePoint[]> {
  const count = Math.max(sampleCount, 2);
  const totalDistanceM = haversineDistanceM(siteLat, siteLon, targetLat, targetLon);
  const bearingDeg = initialBearingDeg(siteLat, siteLon, targetLat, targetLon);

  const points: RawTerrainProfilePoint[] = [];
  for (let i = 0; i < count; i++) {
    const distanceM = (i / (count - 1)) * totalDistanceM;
    const { lat, lon } = i === 0
      ? { lat: siteLat, lon: siteLon }
      : i === count - 1
        ? { lat: targetLat, lon: targetLon }
        : destinationPoint(siteLat, siteLon, bearingDeg, distanceM);
    const elevationM = await getElevationM(lat, lon, logger);
    points.push({ distanceM, elevationM });
  }
  return points;
}
