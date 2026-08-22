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
  propagationModel?: 'fspl' | 'hata' | 'cost231-hata' | 'close-in';
  environment?: 'urban' | 'suburban' | 'open';
  cityType?: 'medium' | 'metropolitan';
  useTerrainData?: boolean;
  pathLossExponent?: number;
  isLineOfSight?: boolean;
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
