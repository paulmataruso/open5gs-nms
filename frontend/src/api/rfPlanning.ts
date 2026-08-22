import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || '';

const api = axios.create({
  baseURL: `${API_URL}/api/rf-planning`,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

// Mirrors backend/src/domain/rf/rf-types.ts — hand-duplicated, matching
// this repo's existing convention (no shared frontend/backend types
// package exists).
export interface EquationRecord {
  name: string;
  formula: string;
  variables: Record<string, { description: string; unit: string; value: number }>;
  source: string;
  applicableConditions?: string;
  limitations?: string;
}

export interface Assumption {
  parameter: string;
  assumedValue: number | string;
  unit?: string;
  reason: string;
  overridable: true;
}

export interface CalcWarning {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
}

export interface CalculationError {
  reason: string;
  missingInputs: string[];
  availableInputs?: Record<string, number | string>;
}

export interface CalculationResult<T> {
  ok: boolean;
  result?: T;
  error?: CalculationError;
  calculation: EquationRecord[];
  assumptions: Assumption[];
  warnings: CalcWarning[];
  model?: string;
  references: string[];
}

export type PropagationModel = 'fspl' | 'hata' | 'cost231-hata' | 'close-in';
export type HataEnvironment = 'urban' | 'suburban' | 'open';
export type Cost231CityType = 'medium' | 'metropolitan';

export interface LinkBudgetInput {
  txPowerDbm: number;
  cableLossDb: number;
  connectorLossDb: number;
  filterLossDb?: number;
  antennaGainDbi: number;
  frequencyMhz?: number;
  band?: number;
  earfcn?: number;
  distanceM: number;
  buildingLossDb?: number;
  foliageLossDb?: number;
  miscLossDb?: number;
  ueAntennaGainDbi?: number;
  propagationModel?: PropagationModel;
  txHeightM?: number;
  rxHeightM?: number;
  environment?: HataEnvironment;
  cityType?: Cost231CityType;
  // 'close-in' only — no height/frequency restriction, unlike Hata/
  // COST-231-Hata. isLineOfSight selects the measured UMi Street Canyon
  // exponent (LOS 2.0 / NLOS 3.1) when pathLossExponent isn't given.
  pathLossExponent?: number;
  isLineOfSight?: boolean;
}

export interface LinkBudgetResult {
  eirpDbm: number;
  pathLossDb: number;
  totalReceivedPowerDbm: number;
}

export interface PointAnalysisInput {
  siteLat: number;
  siteLon: number;
  siteHeightM: number;
  targetLat: number;
  targetLon: number;
  targetHeightM: number;
  mechanicalDowntiltDeg?: number;
  electricalDowntiltDeg?: number;
  useTerrainData?: boolean;
  terrainSampleCount?: number;
}

export interface PointAnalysisResult {
  distanceM: number;
  bearingDeg: number;
  elevationAngleDeg: number;
  geometricDowntiltDeg: number;
  totalConfiguredDowntiltDeg?: number;
  siteGroundElevationM?: number;
  targetGroundElevationM?: number;
  isLineOfSight?: boolean;
  diffractionLossDb?: number;
}

export interface LteBandDefinition {
  band: number;
  duplex: 'FDD' | 'TDD';
  dlFreqLowMhz: number;
  dlEarfcnOffset: number;
  dlEarfcnMin: number;
  dlEarfcnMax: number;
}

export interface LatLon {
  lat: number;
  lon: number;
}

export interface CoverageGridInput {
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
  radiusM: number;
  resolution: number;
  targetPolygon?: LatLon[];
  minAcceptableSignalDbm?: number;
  propagationModel?: PropagationModel;
  environment?: HataEnvironment;
  cityType?: Cost231CityType;
  useTerrainData?: boolean;
  terrainSampleCount?: number;
  pathLossExponent?: number;
  isLineOfSight?: boolean;
}

export interface CoverageGridCell {
  lat: number;
  lon: number;
  row: number;
  col: number;
  distanceM: number;
  totalReceivedPowerDbm: number;
  insideTargetPolygon?: boolean;
}

export interface CoverageRequirement {
  requiredTxPowerDbm: number;
  limitingPoint: LatLon;
  limitingDistanceM: number;
  thresholdDbm: number;
  pointsSampled: number;
}

export interface CoverageGridResult {
  cells: CoverageGridCell[];
  rows: number;
  cols: number;
  bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  coverageRequirement?: CoverageRequirement;
}

export interface RfPlanningSurveyPoint {
  lat: number;
  lon: number;
  measuredDbm: number;
  timestamp?: string;
}

// --- RF Planning Projects (persisted multi-site comparisons) ---
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
  propagationModel?: PropagationModel;
  environment?: HataEnvironment;
  cityType?: Cost231CityType;
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
  targetPolygon?: LatLon[];
  minAcceptableSignalDbm?: number;
}

export interface SiteComparisonResult {
  siteId: string;
  siteName: string;
  ok: boolean;
  coverageRequirement?: CoverageRequirement;
  warnings: CalcWarning[];
  error?: CalculationError;
}

// --- Multi-site interference / SINR ---
export interface InterferenceCell {
  lat: number;
  lon: number;
  row: number;
  col: number;
  servingSiteId: string | null;
  servingDbm: number | null;
  sinrDb: number | null;
}

export interface InterferenceGridResult {
  cells: InterferenceCell[];
  rows: number;
  cols: number;
  bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  siteIds: string[];
}

export interface InterferenceGridOptions {
  centerLat?: number;
  centerLon?: number;
  radiusM?: number;
  resolution?: number;
  bandwidthHz?: number;
  noiseFigureDb?: number;
  temperatureK?: number;
}

// --- Field-survey calibration ---
export interface CalibrationPointResult extends RfPlanningSurveyPoint {
  predictedDbm: number;
  errorDb: number;
}

export interface CalibrationResult {
  offsetDb: number;
  pointCount: number;
  skippedCount: number;
  meanAbsErrorDb: number;
  points: CalibrationPointResult[];
}

const projectsApi = axios.create({
  baseURL: `${API_URL}/api/rf-planning/projects`,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

export const rfPlanningProjectsApi = {
  list: async (): Promise<RfPlanningProject[]> => {
    const { data } = await projectsApi.get('/');
    return data.projects;
  },
  get: async (id: string): Promise<RfPlanningProject> => {
    const { data } = await projectsApi.get(`/${id}`);
    return data.project;
  },
  create: async (name: string, description?: string): Promise<RfPlanningProject> => {
    const { data } = await projectsApi.post('/', { name, description });
    return data.project;
  },
  update: async (id: string, patch: Partial<RfPlanningProject>): Promise<RfPlanningProject> => {
    const { data } = await projectsApi.put(`/${id}`, patch);
    return data.project;
  },
  remove: async (id: string): Promise<void> => {
    await projectsApi.delete(`/${id}`);
  },
  compareSites: async (
    id: string, targetPolygon: LatLon[], minAcceptableSignalDbm: number, radiusM?: number, resolution?: number,
  ): Promise<SiteComparisonResult[]> => {
    const { data } = await projectsApi.post(`/${id}/compare-sites`, { targetPolygon, minAcceptableSignalDbm, radiusM, resolution });
    return data.results;
  },
  interference: async (id: string, options?: InterferenceGridOptions): Promise<CalculationResult<InterferenceGridResult>> => {
    const { data } = await projectsApi.post(`/${id}/interference`, options ?? {});
    return data;
  },
  addSurveyPoint: async (id: string, siteId: string, point: RfPlanningSurveyPoint): Promise<RfPlanningProject> => {
    const { data } = await projectsApi.post(`/${id}/sites/${siteId}/survey-points`, point);
    return data.project;
  },
  removeSurveyPoint: async (id: string, siteId: string, index: number): Promise<RfPlanningProject> => {
    const { data } = await projectsApi.delete(`/${id}/sites/${siteId}/survey-points/${index}`);
    return data.project;
  },
  calibration: async (id: string, siteId: string): Promise<CalibrationResult | null> => {
    const { data } = await projectsApi.get(`/${id}/sites/${siteId}/calibration`);
    return data.result;
  },
  reportUrl: (id: string): string => `${API_URL}/api/rf-planning/projects/${id}/report.pdf`,
};

export const rfPlanningApi = {
  linkBudget: async (input: LinkBudgetInput): Promise<CalculationResult<LinkBudgetResult>> => {
    const { data } = await api.post('/link-budget', input);
    return data;
  },

  pointAnalysis: async (input: PointAnalysisInput): Promise<CalculationResult<PointAnalysisResult>> => {
    const { data } = await api.post('/point-analysis', input);
    return data;
  },

  lteBands: async (): Promise<LteBandDefinition[]> => {
    const { data } = await api.get('/lte-bands');
    return data.bands;
  },

  coverageGrid: async (input: CoverageGridInput): Promise<CalculationResult<CoverageGridResult>> => {
    const { data } = await api.post('/coverage-grid', input);
    return data;
  },
};
