// Shared result envelope for every RF domain calculation. This is the
// architectural backbone of the RF planning engine: every function in
// domain/rf/ returns a CalculationResult<T>, so "every equation is
// first-class data" and "say so instead of guessing when a calculation
// can't be done" are uniform behaviors from the first function written,
// not something bolted on per-endpoint later.

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

export interface Warning {
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
  warnings: Warning[];
  model?: string;
  references: string[];
}

export function okResult<T>(
  result: T,
  calculation: EquationRecord[],
  opts?: { assumptions?: Assumption[]; warnings?: Warning[]; model?: string },
): CalculationResult<T> {
  return {
    ok: true,
    result,
    calculation,
    assumptions: opts?.assumptions ?? [],
    warnings: opts?.warnings ?? [],
    model: opts?.model,
    references: [...new Set(calculation.map(c => c.source))],
  };
}

export function errResult<T>(error: CalculationError): CalculationResult<T> {
  return { ok: false, error, calculation: [], assumptions: [], warnings: [], references: [] };
}

// --- Propagation model selection (shared across link budget / coverage grid) ---
export type PropagationModel = 'fspl' | 'hata' | 'cost231-hata' | 'close-in';
export type HataEnvironment = 'urban' | 'suburban' | 'open';
export type Cost231CityType = 'medium' | 'metropolitan';

// --- Link budget ---
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
  // Only required when propagationModel is 'hata' or 'cost231-hata' — the
  // empirical models need real antenna heights, not just a distance.
  txHeightM?: number;
  rxHeightM?: number;
  environment?: HataEnvironment;
  cityType?: Cost231CityType;
  // 'close-in' only — no height/frequency restriction, unlike Hata/
  // COST-231-Hata. isLineOfSight selects the measured UMi Street Canyon
  // exponent (LOS 2.0 / NLOS 3.1) when pathLossExponent isn't given
  // directly; defaults to the more conservative NLOS value if omitted.
  pathLossExponent?: number;
  isLineOfSight?: boolean;
}

export interface LinkBudgetResult {
  eirpDbm: number;
  pathLossDb: number;
  totalReceivedPowerDbm: number;
}

// --- Point analysis (geometry) ---
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

// --- Coverage grid (map/heatmap tool) ---
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
  // 'close-in' only — see LinkBudgetInput's comment. When useTerrainData is
  // also on, LOS/NLOS is resolved automatically per cell from the real
  // Deygout determination and this override is ignored.
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

// --- Multi-site interference / SINR ---
export interface InterferenceSiteInput {
  id: string;
  name: string;
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
  terrainSampleCount?: number;
  pathLossExponent?: number;
  isLineOfSight?: boolean;
}

export interface InterferenceGridInput {
  sites: InterferenceSiteInput[];
  centerLat: number;
  centerLon: number;
  radiusM: number;
  resolution: number;
  bandwidthHz: number;
  noiseFigureDb?: number;
  temperatureK?: number;
}

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
