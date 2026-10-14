// API client for the simulate-driven RF planning workflow.

/** Propagation models offered by the simulate workflow. */
export type PropagationModelId =
  | 'uma' | 'fspl' | 'close-in' | 'log-distance' | 'hata' | 'cost231-hata' | 'walfisch-ikegami';

export interface PropagationModelInfo {
  id: PropagationModelId;
  label: string;
  blurb: string;
  frequencyRangeGhz: [number, number] | null;
  distanceRangeM: [number, number] | null;
  txHeightRangeM: [number, number] | null;
  rxHeightRangeM: [number, number] | null;
  source: string;
  requiresBuildingHeight?: boolean;
}

export interface ModelOptions {
  pathLossExponent?: number;
  logDistanceEnvironment?: 'free-space' | 'urban' | 'dense-urban' | 'indoor' | 'rural' | 'suburban';
  hataEnvironment?: 'urban' | 'suburban' | 'open';
  cityType?: 'medium' | 'metropolitan';
  walfischIkegamiMode?: 'los' | 'nlos';
  buildingHeightM?: number;
  streetWidthM?: number;
  buildingSeparationM?: number;
  streetOrientationDeg?: number;
}

/** Standard antenna arrangements an operator actually orders. */
export type SiteLayout = 'single' | '3-sector' | '4-sector';

export interface PlanningRadio {
  id: string;
  /** Sectors sharing a siteId are one physical installation on one mast. */
  siteId: string;
  siteName: string;
  /** 'Omni' for a single-sector site, otherwise 'A'/'B'/'C'/'D'. */
  sectorLabel: string;
  name: string;
  latitude: number;
  longitude: number;
  azimuthDeg: number;
  technology: '4g' | '5g';
  frequencyGhz: number;
  bandwidthMhz: number;
  txPowerDbm: number;
  txAntennaGainDbi: number;
  antennaHeightM: number;
  beamWidthDeg: number;
  /** Vertical (elevation) 3 dB beamwidth. Omitted falls back to the engine default. */
  verticalBeamwidthDeg?: number;
  /** Front-to-back ratio at 180°. Omitted falls back to the engine default. */
  frontToBackDb?: number;
  /** How the bracket is angled. Adds to electricalDowntiltDeg server-side. */
  mechanicalDowntiltDeg: number;
  /** Downtilt built into the panel (fixed or RET-set), from its spec sheet. */
  electricalDowntiltDeg?: number;
  /** Which catalogue antenna the pattern numbers came from, or 'custom'. */
  antennaModelId?: string;
  receiverSensitivityDbm: number;
  receiverHeightM: number;
  loadFactor: number;
  locked?: boolean;
}

/**
 * A selectable antenna, as served by GET /antennas.
 *
 * The catalogue is defined and tested in the backend
 * (domain/rf/antenna-catalog.ts) rather than duplicated here, so the numbers
 * the UI shows, the numbers the engine simulates with and the numbers the
 * tests assert on cannot drift apart.
 */
export interface AntennaModel {
  id: string;
  vendor: string;
  model: string;
  label: string;
  bandLabel: string;
  freqMinMhz: number;
  freqMaxMhz: number;
  gainDbi: number;
  beamWidthDeg: number;
  verticalBeamwidthDeg: number;
  verticalDerived: boolean;
  frontToBackDb?: number;
  electricalDowntiltDeg: number;
  electricalDowntiltMaxDeg: number;
  ports: number;
  polarization: string;
  source: string;
  notes?: string;
  generic?: boolean;
  /** Angular width of the −10 dB contour — where neighbouring sectors meet. */
  tenDbWidthDeg: number;
  /** Pattern loss at the crossover of a 3-sector (120° spacing) site. */
  crossover3SectorDb: number;
  /** Pattern loss at the crossover of a 4-sector (90° spacing) site. */
  crossover4SectorDb: number;
}

/** The id used for a sector whose pattern was typed in from a spec sheet. */
export const CUSTOM_ANTENNA_ID = 'custom';

/**
 * Compass bearing for any angle, so rotating past 0° or 360° wraps instead of
 * stopping. −10 becomes 350, 370 becomes 10.
 */
export function normalizeAzimuthDeg(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  return ((Math.round(deg) % 360) + 360) % 360;
}

/** The same bearing expressed as ±180 from north, for a two-way slider. */
export function signedAzimuthDeg(azimuthDeg: number): number {
  const normalized = normalizeAzimuthDeg(azimuthDeg);
  return normalized > 180 ? normalized - 360 : normalized;
}

export interface PlanningBuilding {
  id: string;
  ring: [number, number][];
  heightM?: number;
  demandWeight: number;
  residentialDemand: number;
  densityScore: number;
  tags?: Record<string, string>;
}

export interface RayFeatureCollection {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    properties: {
      ray_index: number; segment_index: number; angle_deg: number;
      signal_dbm: number; signal_start_dbm: number; path_loss_db: number;
      wall_loss_db: number; distance_m: number; los_state: string;
      obstructing_building_id: string | null; is_terminal: boolean; color: string;
    };
    geometry: { type: 'LineString'; coordinates: [number, number][] };
  }[];
}

export interface CellResult {
  cellId: string;
  name: string | null;
  azimuthDeg: number;
  stats: {
    rays: number; segmentCount: number; truncated: boolean;
    blockedRayPct: number; avgReachM: number; minReachM: number; maxReachM: number;
    avgEndSignalDbm: number; wallEventTotal: number;
    model: PropagationModelId;
    declinedSamples: number; declinedRays: number; raysEvaluated: number;
  };
  rays: RayFeatureCollection | null;
  applicability: { applicable: boolean; warnings: string[] };
}

export interface QualityEntry {
  buildingId: string; servingCellId: string; interfererCount: number;
  rsrpDbm: number; sinrDb: number; rsrqDb: number; rssiDbm: number;
  qualityClass: 'good' | 'fair' | 'poor' | 'unusable';
  interferenceLimited: boolean;
}

export interface GapSummary {
  cellId: string;
  gaps: {
    buildingId: string; bestRxDbm: number | null; combinedDemand: number;
    demandWeight: number; residentialDemand: number; distanceM: number;
    centroid: { lon: number; lat: number }; reason: string;
  }[];
  truncated: boolean;
  summary: {
    candidateBuildings: number; servedBuildings: number; gapBuildings: number;
    totalDemandWeight: number; servedDemandWeight: number; unservedDemandWeight: number;
    demandServedPct: number; serviceThresholdDbm: number;
  };
}

export interface SimulateResult {
  cells: CellResult[];
  quality: QualityEntry[];
  gaps: GapSummary[] | null;
  resourceGrid: { resourceBlocks: number; subcarrierSpacingKhz: number; measurementFamily: string; bandwidthMhz: number };
  buildingsConsidered: number;
  settings: {
    radiusM: number; rays: number; includeRays: boolean;
    propagationModel: PropagationModelId; modelLabel: string; modelOptions: ModelOptions;
  };
  warnings: string[];
}

export interface HeatmapResult {
  bounds: { minLon: number; minLat: number; maxLon: number; maxLat: number };
  cols: number;
  rows: number;
  cellSizeM: number;
  /** Row-major, row 0 at the north edge. null where nothing was computed. */
  rsrpDbm: (number | null)[];
  sinrDb: (number | null)[];
  servingCell: (number | null)[];
  qualityClass: ('good' | 'fair' | 'poor' | 'unusable' | null)[];
  cellIds: string[];
  propagationModel: PropagationModelId;
  modelLabel: string;
  sampleCeiling: number;
  warnings: string[];
  stats: {
    model: PropagationModelId; samples: number; covered: number; declined: number;
    minRsrpDbm: number | null; maxRsrpDbm: number | null; coveredPct: number;
  };
}

export interface EquationRecord {
  name: string; formula: string;
  variables: Record<string, { description: string; unit: string; value: number }>;
  source: string; applicableConditions?: string; limitations?: string;
}

interface Envelope<T> {
  ok: boolean;
  result?: T;
  calculation?: EquationRecord[];
  error?: { reason: string; missingInputs: string[]; suggestedModels?: PropagationModelId[] };
}

async function post<T>(path: string, body: unknown): Promise<Envelope<T>> {
  const response = await fetch(`/api/rf-planning${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // The backend answers with the same envelope on success and failure, so a
  // non-2xx still carries a usable reason rather than an opaque status.
  const payload = (await response.json().catch(() => null)) as Envelope<T> | null;
  if (payload) return payload;
  return { ok: false, error: { reason: `HTTP ${response.status}`, missingInputs: [] } };
}

async function get<T>(path: string): Promise<Envelope<T>> {
  const response = await fetch(`/api/rf-planning${path}`, { credentials: 'same-origin' });
  const payload = (await response.json().catch(() => null)) as Envelope<T> | null;
  if (payload) return payload;
  return { ok: false, error: { reason: `HTTP ${response.status}`, missingInputs: [] } };
}

/**
 * The report payload's own narrow shapes, deliberately NOT the full
 * SimulateResult ones.
 *
 * `CellResult` carries every ray's GeoJSON geometry, which the PDF never reads
 * — it only prints the per-cell stats table. Posting the whole thing uploaded
 * megabytes for the server to discard, and on a plan with a large radius or a
 * high ray count it exceeded nginx's 10 MB body cap: the browser got nginx's
 * own HTML 413 page, which is not JSON, so the error surfaced as a bare
 * "HTTP 413" with nothing to act on.
 *
 * These types mirror rf-simulation-report.ts's ReportInput field for field, so
 * the compiler now refuses a payload carrying anything the report cannot use —
 * which is the part that keeps this from silently regressing the next time a
 * field is added to a result.
 */
export interface ReportCell {
  cellId: string;
  name: string | null;
  azimuthDeg: number;
  stats: {
    avgReachM: number; minReachM: number; maxReachM: number; blockedRayPct: number;
    wallEventTotal: number; declinedSamples: number; raysEvaluated: number;
  };
}

export interface ReportQualityEntry {
  qualityClass: string;
  interferenceLimited: boolean;
}

export interface ReportGapSummary {
  cellId: string;
  summary: {
    candidateBuildings: number; gapBuildings: number;
    demandServedPct: number; serviceThresholdDbm: number;
  };
  gaps: { buildingId: string; combinedDemand: number; bestRxDbm: number | null; distanceM: number }[];
}

/** Strip a simulate result's cells down to what the PDF prints. */
export function reportCells(cells: SimulateResult['cells']): ReportCell[] {
  return cells.map(c => ({
    cellId: c.cellId,
    name: c.name,
    azimuthDeg: c.azimuthDeg,
    stats: {
      avgReachM: c.stats.avgReachM,
      minReachM: c.stats.minReachM,
      maxReachM: c.stats.maxReachM,
      blockedRayPct: c.stats.blockedRayPct,
      wallEventTotal: c.stats.wallEventTotal,
      declinedSamples: c.stats.declinedSamples,
      raysEvaluated: c.stats.raysEvaluated,
    },
  }));
}

/** The report only counts quality classes, so only those two fields travel. */
export function reportQuality(quality: SimulateResult['quality']): ReportQualityEntry[] {
  return quality.map(q => ({ qualityClass: q.qualityClass, interferenceLimited: q.interferenceLimited }));
}

/** Gap centroids and demand breakdowns are map concerns, not report ones. */
export function reportGaps(gaps: SimulateResult['gaps']): ReportGapSummary[] | null {
  if (!gaps) return null;
  return gaps.map(g => ({
    cellId: g.cellId,
    summary: {
      candidateBuildings: g.summary.candidateBuildings,
      gapBuildings: g.summary.gapBuildings,
      demandServedPct: g.summary.demandServedPct,
      serviceThresholdDbm: g.summary.serviceThresholdDbm,
    },
    gaps: g.gaps.map(entry => ({
      buildingId: entry.buildingId,
      combinedDemand: entry.combinedDemand,
      bestRxDbm: entry.bestRxDbm,
      distanceM: entry.distanceM,
    })),
  }));
}

export interface ReportRequest {
  title: string;
  radios: PlanningRadio[];
  cells: ReportCell[];
  quality: ReportQualityEntry[];
  gaps: ReportGapSummary[] | null;
  resourceGrid: SimulateResult['resourceGrid'] | null;
  settings: { radiusM: number; rays: number; buildingsConsidered: number };
  propagationModel: PropagationModelId;
  warnings: string[];
  attribution: string | null;
  notes: string | null;
  heatmapPngBase64?: string;
  heatmapMeta?: { metric: string; legend: { label: string; color: string }[]; coveredPct: number; cellSizeM: number };
}

export const rfSimulationApi = {
  /**
   * Download the plan as a PDF.
   *
   * Goes through fetch rather than a plain link because the payload includes
   * the client-rendered coverage raster, which can only be POSTed. The blob is
   * handed to a temporary anchor so the browser treats it as a real download
   * and the Content-Disposition filename is honoured.
   */
  async report(body: ReportRequest): Promise<{ ok: true } | { ok: false; reason: string }> {
    const response = await fetch('/api/rf-planning/report.pdf', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as Envelope<unknown> | null;
      return { ok: false, reason: payload?.error?.reason ?? `HTTP ${response.status}` };
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${body.title.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'rf_plan'}.pdf`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoke on the next tick: revoking synchronously can cancel the download
    // in some browsers before it has actually started reading the blob.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return { ok: true };
  },

  simulate(body: {
    cells: PlanningRadio[]; radiusM: number; rays: number;
    buildings?: PlanningBuilding[]; serviceThresholdDbm?: number;
    includeRays?: boolean; includeGaps?: boolean;
    propagationModel?: PropagationModelId; modelOptions?: ModelOptions;
  }) {
    return post<SimulateResult>('/simulate', body);
  },

  coverageHeatmap(body: {
    cells: PlanningRadio[]; radiusM: number; cellSizeM?: number;
    buildings?: PlanningBuilding[]; includeWallLoss?: boolean;
    propagationModel?: PropagationModelId; modelOptions?: ModelOptions;
  }) {
    return post<HeatmapResult>('/coverage-heatmap', body);
  },

  antennas() {
    return get<{ defaultFrontToBackDb: number; antennas: AntennaModel[] }>('/antennas');
  },

  models() {
    return get<{ defaultModel: PropagationModelId; models: PropagationModelInfo[] }>('/models');
  },

  importBuildings(bounds: { minLon: number; minLat: number; maxLon: number; maxLat: number }) {
    return post<{ endpoint: string; cached: boolean; count: number; attribution: string; buildings: PlanningBuilding[] }>(
      '/buildings/import', bounds,
    );
  },

  optimize(body: { cells: PlanningRadio[]; buildings: PlanningBuilding[]; radiusM: number; rays?: number; azimuthStepDeg?: number; overlapWeight?: number }) {
    return post<{
      best: {
        azimuths: Record<string, number>; servedDemand: number; totalDemand: number;
        demandServedPct: number; buildingsServed: number; overlapDemand: number; score: number;
        contributions: { cellId: string; azimuthDeg: number; exclusiveDemand: number; sharedDemand: number; buildingsServed: number }[];
      };
      pareto: { azimuths: Record<string, number>; demandServedPct: number; overlapDemand: number; score: number }[];
      evaluations: number; azimuthStepDeg: number;
    }>('/optimize', body);
  },

  recommendSites(body: { candidates: { id: string; latitude: number; longitude: number }[]; cells?: PlanningRadio[]; buildings: PlanningBuilding[]; radiusM: number; maxResults?: number }) {
    return post<{
      recommendations: { candidateId: string; origin: { lon: number; lat: number }; bestAzimuthDeg: number; marginalDemand: number; redundantDemand: number; newBuildingsServed: number; rank: number }[];
      note: string;
    }>('/recommend-sites', body);
  },

  buildingEntry(body: { frequencyGhz: number; profileId?: 'low_loss' | 'high_loss'; indoorDepthM?: number; tags?: Record<string, string> }) {
    return post<{
      profileId: string; externalWallLossDb: number; medianEntryLossDb: number;
      referenceShadowSigmaDb: number; applicable: boolean; applicabilityDetail: string; profileSource: string;
    }>('/building-entry', body);
  },

  validateMeasurements(body: { samples: { latitude: number; longitude: number; measuredDbm: number; predictedDbm: number }[]; blockSizeM?: number; foldCount?: number }) {
    return post<{
      overall: { count: number; maeDb: number; rmseDb: number; biasDb: number; stdDevDb: number; maxAbsErrorDb: number; correlation: number };
      folds: { fold: number; heldOutSamples: number; stats: { maeDb: number; rmseDb: number; biasDb: number } }[];
      blockedMaeDb: number; blockedRmseDb: number; blockSizeM: number; foldCount: number; warning?: string;
      calibration: { offsetDb: number; applied: boolean; beforeMaeDb: number; afterMaeDb: number; detail: string };
      methodology: string;
    }>('/validate-measurements', body);
  },
};

/**
 * Standard sector arrangements.
 *
 * The azimuths and beamwidths are what gets ordered in practice, not an even
 * division of the circle: a 3-sector site uses 65 deg panels on 120 deg
 * spacing (the panels' own pattern tails cover the seams, which is why
 * 3 x 65 = 195 rather than 360 is correct and not a gap), and a 4-sector site
 * uses narrower 45 deg panels on 90 deg spacing. Both are editable per sector
 * afterwards — these are a starting point, not a constraint.
 */
export const SITE_LAYOUTS: Record<
  SiteLayout,
  { label: string; azimuths: number[]; beamWidthDeg: number; defaultAntennaId: string; description: string }
> = {
  'single': {
    label: 'Single sector',
    azimuths: [0],
    beamWidthDeg: 90,
    defaultAntennaId: 'generic-90',
    description: 'One panel. Point it where you need it.',
  },
  '3-sector': {
    label: '3-sector',
    azimuths: [0, 120, 240],
    beamWidthDeg: 65,
    defaultAntennaId: 'generic-65',
    description: 'Three 65° panels at 120° spacing — the standard macro arrangement.',
  },
  '4-sector': {
    label: '4-sector',
    azimuths: [0, 90, 180, 270],
    beamWidthDeg: 45,
    defaultAntennaId: 'generic-45',
    description: 'Four 45° panels at 90° spacing — higher capacity, tighter beams.',
  },
};

const SECTOR_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

/** This deployment's real CBRS B48/n48 defaults, shared by every sector. */
function radioDefaults() {
  return {
    technology: '5g' as const,
    frequencyGhz: 3.6,       // CBRS B48/n48 mid-band
    bandwidthMhz: 20,
    txPowerDbm: 27,
    txAntennaGainDbi: 6,
    antennaHeightM: 25,
    mechanicalDowntiltDeg: 5,
    receiverSensitivityDbm: -110,
    receiverHeightM: 1.5,
    loadFactor: 0.7,
  };
}

/**
 * Build a whole site at one position.
 *
 * Every sector shares the siteId, so moving the site moves all of its panels
 * together and the inspector can offer site-wide edits (height, channel,
 * power) separately from per-sector ones (azimuth, tilt, beamwidth).
 */
export function createSite(
  layout: SiteLayout, siteNumber: number, latitude: number, longitude: number,
  antenna?: AntennaModel,
): PlanningRadio[] {
  const spec = SITE_LAYOUTS[layout];
  const siteId = `site-${Date.now()}-${siteNumber}`;
  const siteName = `Site ${siteNumber}`;
  const single = spec.azimuths.length === 1;
  return spec.azimuths.map((azimuthDeg, index) => {
    const sectorLabel = single ? 'Omni' : SECTOR_LABELS[index];
    return {
      id: `${siteId}-${index}`,
      siteId,
      siteName,
      sectorLabel,
      name: single ? siteName : `${siteName} ${sectorLabel}`,
      latitude, longitude,
      azimuthDeg,
      // The layout's own beamwidth is the fallback for when the catalogue has
      // not loaded yet. When it has, the antenna is the single source of the
      // whole pattern — gain, both beamwidths and front-to-back together —
      // because those four are tied by the aperture and a mix-and-match of a
      // panel's beamwidth with an unrelated gain is not a buildable antenna.
      beamWidthDeg: antenna?.beamWidthDeg ?? spec.beamWidthDeg,
      ...radioDefaults(),
      ...applyAntenna(antenna),
    };
  });
}

/** The pattern fields an antenna selection owns. Nothing else is touched. */
export function applyAntenna(antenna?: AntennaModel): Partial<PlanningRadio> {
  if (!antenna) return {};
  return {
    antennaModelId: antenna.id,
    beamWidthDeg: antenna.beamWidthDeg,
    verticalBeamwidthDeg: antenna.verticalBeamwidthDeg,
    txAntennaGainDbi: antenna.gainDbi,
    frontToBackDb: antenna.frontToBackDb,
    electricalDowntiltDeg: antenna.electricalDowntiltDeg,
  };
}

/** Sectors grouped by site, preserving the order they were created in. */
export function groupBySite(radios: PlanningRadio[]): { siteId: string; siteName: string; sectors: PlanningRadio[] }[] {
  const sites: { siteId: string; siteName: string; sectors: PlanningRadio[] }[] = [];
  const index = new Map<string, number>();
  for (const radio of radios) {
    const existing = index.get(radio.siteId);
    if (existing !== undefined) {
      sites[existing].sectors.push(radio);
      continue;
    }
    index.set(radio.siteId, sites.length);
    sites.push({ siteId: radio.siteId, siteName: radio.siteName, sectors: [radio] });
  }
  return sites;
}

/** Next free sector label for a site that is gaining a panel. */
export function nextSectorLabel(existing: PlanningRadio[]): string {
  const used = new Set(existing.map(r => r.sectorLabel));
  return SECTOR_LABELS.find(label => !used.has(label)) ?? `S${existing.length + 1}`;
}
