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
export type PropagationModel = 'fspl' | 'hata' | 'cost231-hata' | 'close-in' | 'log-distance' | 'walfisch-ikegami' | 'itm';
export type HataEnvironment = 'urban' | 'suburban' | 'open';
export type Cost231CityType = 'medium' | 'metropolitan';
export type LogDistanceEnvironment = 'free-space' | 'urban' | 'dense-urban' | 'indoor' | 'rural' | 'suburban';
export type WalfischIkegamiMode = 'los' | 'nlos';
// 'itm' only (see itm-model.ts) — mirrors ITM's own radio climate zones
// (Enums.h) and MDVAR modes exactly; not a free-text/numeric passthrough so
// the frontend can offer a real dropdown instead of a bare code.
export type ItmRadioClimate =
  | 'equatorial' | 'continental-subtropical' | 'maritime-subtropical' | 'desert'
  | 'continental-temperate' | 'maritime-temperate-land' | 'maritime-temperate-sea';
export type ItmPolarization = 'horizontal' | 'vertical';
export type ItmVariabilityMode = 'single-message' | 'accidental' | 'mobile' | 'broadcast';

// The v<=-1 diffraction-clear boundary (isLineOfSight) and this 3-way
// classification answer genuinely different questions and are computed
// independently — see diffraction.ts's header comment and fresnel-zone.ts.
export type LosClassification = 'los' | 'partial' | 'nlos';
// 0/50/60/100 are the spec-named presets; not enforced at runtime (matches
// this codebase's existing HataEnvironment/Cost231CityType behavior — an
// unrecognized value simply isn't hard-rejected).
export type FresnelClearanceThresholdPercent = 0 | 50 | 60 | 100;

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
  // 'close-in'/'log-distance' only — no height/frequency restriction, unlike
  // Hata/COST-231-Hata. isLineOfSight selects the measured UMi Street Canyon
  // exponent (LOS 2.0 / NLOS 3.1) when pathLossExponent isn't given
  // directly; defaults to the more conservative NLOS value if omitted.
  pathLossExponent?: number;
  isLineOfSight?: boolean;
  // 'log-distance' only — selects a named environment preset's exponent
  // (overridden by pathLossExponent when both are given).
  logDistanceEnvironment?: LogDistanceEnvironment;
  // 'walfisch-ikegami' only. Reuses txHeightM/rxHeightM (already required for
  // Hata/COST-231-Hata) as h_Base/h_Mobile, and cityType (already shared with
  // COST-231-Hata) for the kf branch — no duplicate fields for either.
  walfischIkegamiMode?: WalfischIkegamiMode;
  buildingHeightM?: number;
  streetWidthM?: number;
  buildingSeparationM?: number;
  streetOrientationDeg?: number;
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
  earthCurvatureKFactor?: number;
  fresnelClearanceThresholdPercent?: FresnelClearanceThresholdPercent;
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
  losClassification?: LosClassification;
  fresnelClearancePercent?: number | null;
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
  // Hata/COST-231-Hata/Walfisch-Ikegami only, and only when environment/
  // cityType aren't given explicitly (which always wins) — looks up the
  // site's real ESA WorldCover land-cover class and maps it to environment/
  // cityType instead of defaulting to 'urban'/'medium'. See
  // landcover-provider.ts's environmentFromWorldCoverClass for the
  // (deliberately coarse, disclosed) mapping convention.
  autoDetectEnvironment?: boolean;
  useTerrainData?: boolean;
  terrainSampleCount?: number;
  // 'close-in'/'log-distance' only — see LinkBudgetInput's comment. When
  // useTerrainData is also on, LOS/NLOS is resolved automatically per cell
  // from the real Deygout determination and this override is ignored.
  pathLossExponent?: number;
  isLineOfSight?: boolean;
  logDistanceEnvironment?: LogDistanceEnvironment;
  earthCurvatureKFactor?: number;
  fresnelClearanceThresholdPercent?: FresnelClearanceThresholdPercent;
  walfischIkegamiMode?: WalfischIkegamiMode;
  buildingHeightM?: number;
  streetWidthM?: number;
  buildingSeparationM?: number;
  streetOrientationDeg?: number;
  // 'itm' only (see itm-model.ts). Requires useTerrainData:true — ITM's
  // entire algorithm is profile-shaped, unlike every other model here, so
  // there is no meaningful abstract-distance fallback; the resolver returns
  // errResult if terrain data isn't available rather than substituting
  // another model. All fields below default to real, cited "average
  // ground"/"average atmosphere" reference values when omitted.
  groundConductivity?: number;
  groundPermittivity?: number;
  surfaceRefractivityN0?: number;
  radioClimate?: ItmRadioClimate;
  polarization?: ItmPolarization;
  modeOfVariability?: ItmVariabilityMode;
  timePercent?: number;
  locationPercent?: number;
  situationPercent?: number;
}

export interface CoverageGridCell {
  lat: number;
  lon: number;
  row: number;
  col: number;
  distanceM: number;
  totalReceivedPowerDbm: number;
  insideTargetPolygon?: boolean;
  losClassification: LosClassification | undefined;
  fresnelClearancePercent: number | null | undefined;
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
  // See the matching comment on CoverageGridInput.
  autoDetectEnvironment?: boolean;
  useTerrainData?: boolean;
  terrainSampleCount?: number;
  pathLossExponent?: number;
  isLineOfSight?: boolean;
  logDistanceEnvironment?: LogDistanceEnvironment;
  earthCurvatureKFactor?: number;
  fresnelClearanceThresholdPercent?: FresnelClearanceThresholdPercent;
  walfischIkegamiMode?: WalfischIkegamiMode;
  buildingHeightM?: number;
  streetWidthM?: number;
  buildingSeparationM?: number;
  streetOrientationDeg?: number;
  // 'itm' only — see the matching comment on CoverageGridInput.
  groundConductivity?: number;
  groundPermittivity?: number;
  surfaceRefractivityN0?: number;
  radioClimate?: ItmRadioClimate;
  polarization?: ItmPolarization;
  modeOfVariability?: ItmVariabilityMode;
  timePercent?: number;
  locationPercent?: number;
  situationPercent?: number;
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
  losClassification?: LosClassification;
  fresnelClearancePercent?: number | null;
}

export interface InterferenceGridResult {
  cells: InterferenceCell[];
  rows: number;
  cols: number;
  bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  siteIds: string[];
}
