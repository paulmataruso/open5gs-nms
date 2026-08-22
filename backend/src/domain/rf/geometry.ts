// Great-circle distance (Haversine) and initial bearing between two
// lat/lon points. Chosen over Vincenty: the extra ellipsoidal precision
// (sub-meter to low-single-digit-meter at RF planning distances) is below
// the resolution of every other Phase 1 input (heights entered to ±1m, no
// terrain data), while Haversine is closed-form and always converges.

import { EquationRecord } from './rf-types';

// IUGG mean Earth radius.
export const EARTH_RADIUS_M = 6_371_008.8;

function toRad(deg: number): number { return (deg * Math.PI) / 180; }
function toDeg(rad: number): number { return (rad * 180) / Math.PI; }

export function haversineDistanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = toRad(lat1), phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lon2 - lon1);
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

export function initialBearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = toRad(lat1), phi2 = toRad(lat2);
  const dLambda = toRad(lon2 - lon1);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  const theta = Math.atan2(y, x);
  return (toDeg(theta) + 360) % 360;
}

// Destination point given a start position, bearing, and distance —
// standard spherical direct-geodesy formula (same family as the initial
// bearing formula above), used by terrain-profile.ts to walk out a sample
// path from a site toward a target.
export function destinationPoint(lat: number, lon: number, bearingDeg: number, distanceM: number): { lat: number; lon: number } {
  const delta = distanceM / EARTH_RADIUS_M;
  const theta = toRad(bearingDeg);
  const phi1 = toRad(lat);
  const lambda1 = toRad(lon);
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
  const lambda2 = lambda1 + Math.atan2(
    Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
    Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
  );
  return { lat: toDeg(phi2), lon: (((toDeg(lambda2) + 540) % 360)) - 180 };
}

export function geometryEquations(
  lat1: number, lon1: number, lat2: number, lon2: number, distanceM: number, bearingDeg: number,
): EquationRecord[] {
  return [
    {
      name: 'Great-Circle Distance (Haversine)',
      formula: 'a = sin²(Δφ/2) + cos(φ1)·cos(φ2)·sin²(Δλ/2); d = 2R·atan2(√a, √(1−a))',
      variables: {
        lat1: { description: 'Site latitude', unit: 'deg', value: lat1 },
        lon1: { description: 'Site longitude', unit: 'deg', value: lon1 },
        lat2: { description: 'Target latitude', unit: 'deg', value: lat2 },
        lon2: { description: 'Target longitude', unit: 'deg', value: lon2 },
        R:    { description: 'Earth radius (IUGG mean)', unit: 'm', value: EARTH_RADIUS_M },
        d:    { description: 'Great-circle distance', unit: 'm', value: distanceM },
      },
      source: 'Sinnott, R.W., "Virtues of the Haversine," Sky and Telescope 68(2), 159 (1984)',
      applicableConditions: 'Spherical-Earth approximation',
      limitations: 'Assumes a sphere, not the WGS84 ellipsoid — error is negligible at RF planning distances but is a real, documented simplification',
    },
    {
      name: 'Initial Bearing',
      formula: 'θ = atan2(sin(Δλ)·cos(φ2), cos(φ1)·sin(φ2) − sin(φ1)·cos(φ2)·cos(Δλ)), normalized to [0°, 360°)',
      variables: {
        lat1:    { description: 'Site latitude', unit: 'deg', value: lat1 },
        lon1:    { description: 'Site longitude', unit: 'deg', value: lon1 },
        lat2:    { description: 'Target latitude', unit: 'deg', value: lat2 },
        lon2:    { description: 'Target longitude', unit: 'deg', value: lon2 },
        bearing: { description: 'Initial bearing, site to target', unit: 'deg', value: bearingDeg },
      },
      source: 'Standard spherical trigonometry (cf. Ed Williams, Aviation Formulary)',
      applicableConditions: 'Spherical-Earth approximation',
    },
  ];
}
