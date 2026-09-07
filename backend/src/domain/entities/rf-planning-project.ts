// ─────────────────────────────────────────────────────────────
// Domain Entity: RF Planning Project
// ─────────────────────────────────────────────────────────────
// A named collection of candidate radio sites an operator wants to compare
// against a shared target coverage area — the persistence layer for the
// Coverage Map tool (backend/src/domain/rf/). Only INPUTS are persisted;
// computed results (heatmaps, coverage requirements) are always recomputed
// live from the saved inputs, never cached here, so there's no stale-data
// invalidation to manage. No per-user ownership field — this is a single-
// tenant, all-data-shared admin tool, same as every other collection in
// this system (subscribers, SAS grants, backups).

export interface RfPlanningSurveyPoint {
  lat: number;
  lon: number;
  measuredDbm: number;
  timestamp?: string;
}

export interface RfPlanningSite {
  id: string;
  name: string;
  // Shared by every sector of a "Quick Add 3-Sector Site" tower so the
  // frontend Coverage Map can treat them as one draggable object. Absent
  // for a standalone radio, or after "Ungroup Tower".
  towerId?: string;
  surveyPoints?: RfPlanningSurveyPoint[];
  siteLat: number;
  siteLon: number;
  siteHeightM: number;
  azimuthDeg: number;
  horizontalBeamwidthDeg: number;
  verticalBeamwidthDeg?: number;
  mechanicalDowntiltDeg?: number;
  electricalDowntiltDeg?: number;
  frontToBackDb?: number;
  txPowerDbm: number;
  cableLossDb: number;
  connectorLossDb: number;
  filterLossDb?: number;
  antennaGainDbi: number;
  frequencyMhz?: number;
  band?: number;
  earfcn?: number;
  buildingLossDb?: number;
  foliageLossDb?: number;
  miscLossDb?: number;
  ueAntennaGainDbi?: number;
  receiverHeightM?: number;
  propagationModel?: 'fspl' | 'hata' | 'cost231-hata' | 'close-in' | 'log-distance' | 'walfisch-ikegami' | 'itm';
  environment?: 'urban' | 'suburban' | 'open';
  cityType?: 'medium' | 'metropolitan';
  // Hata/COST-231-Hata/Walfisch-Ikegami only — see rf-types.ts's
  // CoverageGridInput for the full comment.
  autoDetectEnvironment?: boolean;
  logDistanceEnvironment?: 'free-space' | 'urban' | 'dense-urban' | 'indoor' | 'rural' | 'suburban';
  useTerrainData?: boolean;
  pathLossExponent?: number;
  isLineOfSight?: boolean;
  earthCurvatureKFactor?: number;
  fresnelClearanceThresholdPercent?: 0 | 50 | 60 | 100;
  walfischIkegamiMode?: 'los' | 'nlos';
  buildingHeightM?: number;
  streetWidthM?: number;
  buildingSeparationM?: number;
  streetOrientationDeg?: number;
  // 'itm' only — see rf-types.ts's CoverageGridInput for the authoritative
  // comment on these fields and their real "average ground"/"average
  // atmosphere" default values.
  groundConductivity?: number;
  groundPermittivity?: number;
  surfaceRefractivityN0?: number;
  radioClimate?: 'equatorial' | 'continental-subtropical' | 'maritime-subtropical' | 'desert'
    | 'continental-temperate' | 'maritime-temperate-land' | 'maritime-temperate-sea';
  polarization?: 'horizontal' | 'vertical';
  modeOfVariability?: 'single-message' | 'accidental' | 'mobile' | 'broadcast';
  timePercent?: number;
  locationPercent?: number;
  situationPercent?: number;
}

export interface RfPlanningProject {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  sites: RfPlanningSite[];
  // Shared across every candidate site in the project, so "reverse
  // planning" can compare them against the same target area.
  targetPolygon?: { lat: number; lon: number }[];
  minAcceptableSignalDbm?: number;
}
