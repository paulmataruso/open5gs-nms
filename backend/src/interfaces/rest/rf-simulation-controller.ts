import { Router, Request, Response } from 'express';
import pino from 'pino';
import { BuildingIndex, BuildingFootprint, type Point } from '../../domain/rf/building-index';
import { traceBeam, raySegmentsToGeoJson, type RayTraceProfile, type RayTraceResult } from '../../domain/rf/ray-trace';
import { findCoverageGaps } from '../../domain/rf/coverage-gap';
import { buildingEntryLoss, buildingEntryProfileFromTags, buildingEntryEquation, type BuildingEntryProfileId } from '../../domain/rf/building-entry';
import { resolveResourceGrid, computeRadioQuality, classifyRadioQuality, isInterferenceLimited, radioQualityEquation, defaultSubcarrierSpacingKhz, type RadioTechnology, type SubcarrierSpacingKhz } from '../../domain/rf/radio-quality';
import { optimizeNetwork, recommendSites, type OptimizationCell } from '../../domain/rf/network-optimize';
import { spatiallyBlockedValidation, holdoutCheckedCalibrationOffset, type MeasurementSample } from '../../domain/rf/measurement-validation';
import { umaEquation } from '../../domain/rf/uma-model';
import { fetchOsmBuildings } from '../../domain/rf/osm-buildings';
import {
  ANTENNA_CATALOG, crossoverLossDb, patternWidthDeg, type AntennaModel,
} from '../../domain/rf/antenna-catalog';
import { DEFAULT_FRONT_TO_BACK_DB } from '../../domain/rf/antenna-pattern';
import {
  simulationPathLossDb, modelApplicability, modelLabel, isSimulationModel,
  SIMULATION_MODEL_INFO, SIMULATION_MODELS, DEFAULT_SIMULATION_MODEL,
  type SimulationModel,
} from '../../domain/rf/propagation-select';
import {
  computeCoverageHeatmap, boundsForCells, MAX_HEATMAP_SAMPLES,
  type HeatmapCellInput,
} from '../../domain/rf/coverage-heatmap';
import { resolveBuildingHeightM } from '../../domain/rf/building-index';
import PDFDocument from 'pdfkit';
import { writeSimulationReport, isPng, type ReportInput } from './rf-simulation-report';
import type { RayTraceModelOptions } from '../../domain/rf/ray-trace';

// REST surface for the simulate-driven RF planning workflow.
//
// The shape of this API follows the intended user flow rather than the
// internal module layout: an operator drops radios on the map, fills in their
// parameters, and presses Simulate. One POST /simulate therefore returns
// everything that one action should produce — rays, per-cell statistics,
// interference-aware radio quality, and the demand gaps — instead of making
// the client orchestrate five calls and stitch the results together.
//
// Pure computation, no host I/O, so this needs no host-executor or audit
// logger (same minimal shape as createRfPlanningRouter).

/** Hard ceiling on rays per cell, to bound a single request's work. */
const MAX_RAYS = 360;
const MAX_CELLS = 16;
const MAX_RADIUS_M = 5000;

/**
 * Largest bounding box accepted for a building import, per axis.
 *
 * 0.5° is roughly 55 km of longitude at this latitude — tens of thousands of
 * footprints, and a query a shared Overpass instance will rightly refuse. A
 * planning view is a few kilometres across, so 0.15° (about 16 km) is generous
 * for the real workflow while staying inside what the service will serve.
 */
const MAX_IMPORT_SPAN_DEG = 0.15;

/**
 * Cap on the client-rendered coverage image embedded in a PDF report.
 *
 * Sized against the TRANSPORT, not against pdfkit: the image arrives
 * base64-encoded inside a JSON body, which inflates it by 4/3, and both
 * express.json (10mb) and nginx's /api/ client_max_body_size (10m) reject the
 * whole request above that — before this handler runs, so the operator would
 * get an opaque 413 instead of the explanation below. 4 MB raw is ~5.4 MB
 * encoded, leaving ample headroom for the rest of the payload. A real
 * 1200x900 coverage raster is a few hundred KB, so this is already generous.
 */
const MAX_REPORT_IMAGE_BYTES = 4_000_000;

interface CellInput {
  id?: string;
  name?: string;
  latitude: number;
  longitude: number;
  azimuthDeg?: number;
  technology?: RadioTechnology;
  frequencyGhz?: number;
  bandwidthMhz?: number;
  subcarrierSpacingKhz?: SubcarrierSpacingKhz;
  txPowerDbm?: number;
  txAntennaGainDbi?: number;
  rxAntennaGainDbi?: number;
  systemLossDb?: number;
  polarizationLossDb?: number;
  antennaHeightM?: number;
  receiverHeightM?: number;
  beamWidthDeg?: number;
  verticalBeamwidthDeg?: number;
  frontToBackDb?: number;
  mechanicalDowntiltDeg?: number;
  /**
   * Electrical downtilt built into the antenna (fixed or RET-set), separate
   * from how the bracket is physically angled. The two add, and the engine
   * only wants the total — see profileFor().
   */
  electricalDowntiltDeg?: number;
  /** Which catalogue antenna supplied the pattern numbers, for the record. */
  antennaModelId?: string;
  receiverSensitivityDbm?: number;
  loadFactor?: number;
  /** Pin this cell's azimuth during optimisation. */
  locked?: boolean;
}

/**
 * Defaults are a realistic CBRS B48/n48 small cell, because that is what this
 * deployment runs. They are explicit here rather than buried so the response
 * can echo exactly what was assumed.
 */
const CELL_DEFAULTS = {
  technology: '5g' as RadioTechnology,
  frequencyGhz: 3.6,
  bandwidthMhz: 20,
  txPowerDbm: 27,
  txAntennaGainDbi: 6,
  rxAntennaGainDbi: 0,
  systemLossDb: 0,
  polarizationLossDb: 0,
  antennaHeightM: 25,
  receiverHeightM: 1.5,
  beamWidthDeg: 90,
  verticalBeamwidthDeg: 10,
  frontToBackDb: DEFAULT_FRONT_TO_BACK_DB,
  mechanicalDowntiltDeg: 5,
  electricalDowntiltDeg: 0,
  receiverSensitivityDbm: -110,
  azimuthDeg: 0,
  loadFactor: 0.7,
};

interface ModelSelection {
  model: SimulationModel;
  modelOptions: RayTraceModelOptions;
}

/**
 * Representative rooftop height, for the models that need one.
 *
 * Only measured/derived heights count — an ASSUMED height is this engine's own
 * placeholder for "we don't know", and averaging placeholders would produce a
 * confident-looking number built from nothing. Returns null when the footprints
 * carry no real height evidence, which the caller surfaces as a blocking
 * reason rather than quietly defaulting.
 */
function representativeBuildingHeightM(buildings: BuildingIndex): number | null {
  const heights: number[] = [];
  for (const building of buildings.buildings()) {
    const resolved = resolveBuildingHeightM(building);
    if (resolved.evidence !== 'assumed') heights.push(resolved.heightM);
  }
  if (heights.length === 0) return null;
  heights.sort((a, b) => a - b);
  const mid = Math.floor(heights.length / 2);
  const median = heights.length % 2 === 0 ? (heights[mid - 1] + heights[mid]) / 2 : heights[mid];
  return Number(median.toFixed(1));
}

function resolveModelSelection(body: Record<string, unknown>, buildings: BuildingIndex): ModelSelection {
  const requested = body.propagationModel;
  const model: SimulationModel = isSimulationModel(requested) ? requested : DEFAULT_SIMULATION_MODEL;
  const raw = (body.modelOptions ?? {}) as Record<string, unknown>;
  const modelOptions: RayTraceModelOptions = {};

  if (typeof raw.pathLossExponent === 'number' && Number.isFinite(raw.pathLossExponent)) {
    modelOptions.pathLossExponent = raw.pathLossExponent;
  }
  if (typeof raw.logDistanceEnvironment === 'string') {
    modelOptions.logDistanceEnvironment = raw.logDistanceEnvironment as RayTraceModelOptions['logDistanceEnvironment'];
  }
  if (typeof raw.hataEnvironment === 'string') {
    modelOptions.hataEnvironment = raw.hataEnvironment as RayTraceModelOptions['hataEnvironment'];
  }
  if (typeof raw.cityType === 'string') {
    modelOptions.cityType = raw.cityType as RayTraceModelOptions['cityType'];
  }
  if (raw.walfischIkegamiMode === 'los' || raw.walfischIkegamiMode === 'nlos') {
    modelOptions.walfischIkegamiMode = raw.walfischIkegamiMode;
  }
  for (const key of ['streetWidthM', 'buildingSeparationM', 'streetOrientationDeg'] as const) {
    if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) modelOptions[key] = raw[key] as number;
  }
  if (typeof raw.buildingHeightM === 'number' && Number.isFinite(raw.buildingHeightM)) {
    modelOptions.buildingHeightM = raw.buildingHeightM;
  } else if (model === 'walfisch-ikegami') {
    // Measure it from the real footprints rather than asking for a number the
    // operator would have to invent.
    const measured = representativeBuildingHeightM(buildings);
    if (measured !== null) modelOptions.buildingHeightM = measured;
  }
  return { model, modelOptions };
}

/**
 * Gate the whole run on the model's own published validity.
 *
 * Hata, COST-231 and Walfisch-Ikegami hard-reject out-of-range inputs per
 * point instead of extrapolating. Without this gate, choosing Hata for a
 * 3.6 GHz CBRS cell returns a technically-successful run with a completely
 * empty map and no stated reason. Refusing up front, with the real numbers and
 * a list of models that DO cover this scenario, is the honest failure.
 */
function checkModelApplicable(
  cells: CellInput[], selection: ModelSelection, radiusM: number,
): { ok: true; warnings: string[] } | { ok: false; reason: string; suggested: SimulationModel[] } {
  const warnings = new Set<string>();
  for (const cell of cells) {
    const check = modelApplicability(selection.model, {
      frequencyGhz: num(cell.frequencyGhz, CELL_DEFAULTS.frequencyGhz),
      txHeightM: num(cell.antennaHeightM, CELL_DEFAULTS.antennaHeightM),
      rxHeightM: num(cell.receiverHeightM, CELL_DEFAULTS.receiverHeightM),
      radiusM,
      walfischIkegamiMode: selection.modelOptions.walfischIkegamiMode,
      buildingHeightM: selection.modelOptions.buildingHeightM,
    });
    for (const warning of check.warnings) warnings.add(warning);
    if (!check.applicable) {
      const names = check.suggested.map(m => modelLabel(m));
      return {
        ok: false,
        suggested: check.suggested,
        reason:
          `${check.blocking.join(' ')} ` +
          (names.length > 0
            ? `Valid for this scenario: ${names.join(', ')}.`
            : 'No available model covers this scenario as configured.'),
      };
    }
  }
  return { ok: true, warnings: [...warnings] };
}

/**
 * Worked example at the run's own radius, for the non-UMa models.
 *
 * Reports the model, its source and the inputs that produced the number rather
 * than restating each model's algebra — those derivations already live in the
 * model modules, and duplicating them here is how two copies of a formula
 * start to disagree. UMa keeps its own richer umaEquation() record.
 */
function modelWorkedExample(selection: ModelSelection, cell: CellInput, radiusM: number) {
  const info = SIMULATION_MODEL_INFO[selection.model];
  const frequencyGhz = num(cell.frequencyGhz, CELL_DEFAULTS.frequencyGhz);
  const txHeightM = num(cell.antennaHeightM, CELL_DEFAULTS.antennaHeightM);
  const rxHeightM = num(cell.receiverHeightM, CELL_DEFAULTS.receiverHeightM);
  const pathLossDb = simulationPathLossDb(selection.model, {
    ...selection.modelOptions,
    distanceM: radiusM, frequencyGhz, txHeightM, rxHeightM, lineOfSight: false,
  });
  return {
    name: `${info.label} path loss at ${radiusM} m (NLOS)`,
    formula: `L = f(d, f_c, h_tx, h_rx) per ${info.source}`,
    variables: {
      d:    { description: 'Ground distance', unit: 'm', value: radiusM },
      f_c:  { description: 'Carrier frequency', unit: 'GHz', value: frequencyGhz },
      h_tx: { description: 'Transmit antenna height', unit: 'm', value: txHeightM },
      h_rx: { description: 'Receiver height', unit: 'm', value: rxHeightM },
      L:    { description: 'Path loss', unit: 'dB', value: pathLossDb === null ? Number.NaN : Number(pathLossDb.toFixed(2)) },
    },
    source: info.source,
    applicableConditions: [
      info.frequencyRangeGhz ? `${info.frequencyRangeGhz[0]}-${info.frequencyRangeGhz[1]} GHz` : 'no frequency restriction',
      info.distanceRangeM ? `${info.distanceRangeM[0]}-${info.distanceRangeM[1]} m` : 'no distance restriction',
    ].join('; '),
    limitations: info.blurb,
  };
}

function profileFor(cell: CellInput, selection?: ModelSelection): RayTraceProfile {
  return {
    model: selection?.model ?? DEFAULT_SIMULATION_MODEL,
    modelOptions: selection?.modelOptions ?? {},
    frequencyGhz: num(cell.frequencyGhz, CELL_DEFAULTS.frequencyGhz),
    txPowerDbm: num(cell.txPowerDbm, CELL_DEFAULTS.txPowerDbm),
    txAntennaGainDbi: num(cell.txAntennaGainDbi, CELL_DEFAULTS.txAntennaGainDbi),
    rxAntennaGainDbi: num(cell.rxAntennaGainDbi, CELL_DEFAULTS.rxAntennaGainDbi),
    systemLossDb: num(cell.systemLossDb, CELL_DEFAULTS.systemLossDb),
    polarizationLossDb: num(cell.polarizationLossDb, CELL_DEFAULTS.polarizationLossDb),
    antennaHeightM: num(cell.antennaHeightM, CELL_DEFAULTS.antennaHeightM),
    receiverHeightM: num(cell.receiverHeightM, CELL_DEFAULTS.receiverHeightM),
    beamWidthDeg: num(cell.beamWidthDeg, CELL_DEFAULTS.beamWidthDeg),
    verticalBeamwidthDeg: num(cell.verticalBeamwidthDeg, CELL_DEFAULTS.verticalBeamwidthDeg),
    frontToBackDb: num(cell.frontToBackDb, CELL_DEFAULTS.frontToBackDb),
    // Total downtilt. A panel's electrical tilt and its bracket's mechanical
    // tilt point the same beam further down by the same mechanism, so the
    // engine takes one number — summing here keeps the two separately
    // editable in the UI (one comes off the antenna's spec sheet, the other
    // is an install decision) without the engine needing to know the
    // difference.
    mechanicalDowntiltDeg:
      num(cell.mechanicalDowntiltDeg, CELL_DEFAULTS.mechanicalDowntiltDeg) +
      num(cell.electricalDowntiltDeg, CELL_DEFAULTS.electricalDowntiltDeg),
    receiverSensitivityDbm: num(cell.receiverSensitivityDbm, CELL_DEFAULTS.receiverSensitivityDbm),
  };
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function originFor(cell: CellInput): Point {
  return { lon: cell.longitude, lat: cell.latitude };
}

/** Validate the request's cells, returning a reason string on failure. */
function validateCells(cells: unknown): { ok: true; cells: CellInput[] } | { ok: false; reason: string } {
  if (!Array.isArray(cells) || cells.length === 0) {
    return { ok: false, reason: 'at least one cell is required — drop a radio on the map first' };
  }
  if (cells.length > MAX_CELLS) {
    return { ok: false, reason: `at most ${MAX_CELLS} cells per simulation (got ${cells.length})` };
  }
  for (const [index, raw] of cells.entries()) {
    const cell = raw as CellInput;
    if (typeof cell?.latitude !== 'number' || typeof cell?.longitude !== 'number') {
      return { ok: false, reason: `cell ${index + 1} is missing a latitude/longitude` };
    }
    if (cell.latitude < -90 || cell.latitude > 90 || cell.longitude < -180 || cell.longitude > 180) {
      return { ok: false, reason: `cell ${index + 1} has coordinates outside the valid range` };
    }
  }
  return { ok: true, cells: cells as CellInput[] };
}

function buildingsFrom(raw: unknown): BuildingIndex {
  if (!Array.isArray(raw)) return new BuildingIndex([]);
  const footprints: BuildingFootprint[] = [];
  for (const entry of raw) {
    const b = entry as Record<string, unknown>;
    const ring = b.ring as [number, number][] | undefined;
    if (!Array.isArray(ring) || ring.length < 3) continue;
    footprints.push({
      id: String(b.id ?? `b${footprints.length}`),
      ring,
      heightM: typeof b.heightM === 'number' ? b.heightM : undefined,
      heightSource: b.heightSource as BuildingFootprint['heightSource'],
      demandWeight: typeof b.demandWeight === 'number' ? b.demandWeight : 0,
      residentialDemand: typeof b.residentialDemand === 'number' ? b.residentialDemand : 0,
      densityScore: typeof b.densityScore === 'number' ? b.densityScore : 0,
      tags: (b.tags as Record<string, string>) ?? undefined,
    });
  }
  return new BuildingIndex(footprints);
}

export function createRfSimulationRouter(logger: pino.Logger): Router {
  const router = Router();

  /**
   * POST /simulate — the one call behind the Simulate button.
   *
   * Body: { cells: [...], radiusM, rays, buildings?, serviceThresholdDbm?,
   *         includeRays?, includeGaps? }
   */
  router.post('/simulate', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const parsed = validateCells(body.cells);
      if (!parsed.ok) {
        res.status(400).json({ ok: false, error: { reason: parsed.reason, missingInputs: ['cells'] } });
        return;
      }
      const cells = parsed.cells;
      const radiusM = Math.min(num(body.radiusM, 400), MAX_RADIUS_M);
      const rays = Math.min(Math.max(Math.floor(num(body.rays, 60)), 1), MAX_RAYS);
      const includeRays = body.includeRays !== false;
      const buildings = buildingsFrom(body.buildings);
      const selection = resolveModelSelection(body, buildings);

      const applicable = checkModelApplicable(cells, selection, radiusM);
      if (!applicable.ok) {
        res.status(400).json({
          ok: false,
          error: {
            reason: applicable.reason,
            missingInputs: [],
            suggestedModels: applicable.suggested,
          },
        });
        return;
      }

      const traces: { cell: CellInput; profile: RayTraceProfile; trace: RayTraceResult }[] = [];
      for (const cell of cells) {
        const profile = profileFor(cell, selection);
        traces.push({
          cell, profile,
          trace: traceBeam({
            origin: originFor(cell),
            azimuthDeg: num(cell.azimuthDeg, CELL_DEFAULTS.azimuthDeg),
            rays, radiusM, profile, buildings,
            collectSegments: includeRays,
          }),
        });
      }

      // Interference-aware radio quality per building: the serving cell is the
      // strongest, every other illuminating cell is an interferer. This is why
      // /simulate takes the whole cell set rather than one cell at a time —
      // SINR/RSRQ are properties of the network, not of a radio.
      const perBuilding = new Map<string, { cellId: string; rxDbm: number }[]>();
      traces.forEach(({ cell, trace }, index) => {
        const cellId = String(cell.id ?? cell.name ?? `cell-${index + 1}`);
        for (const [buildingId, rxDbm] of trace.buildingCoverage) {
          const list = perBuilding.get(buildingId);
          if (list) list.push({ cellId, rxDbm }); else perBuilding.set(buildingId, [{ cellId, rxDbm }]);
        }
      });

      const first = cells[0];
      const grid = resolveResourceGrid(
        (first.technology ?? CELL_DEFAULTS.technology),
        num(first.bandwidthMhz, CELL_DEFAULTS.bandwidthMhz),
        (first.subcarrierSpacingKhz ?? defaultSubcarrierSpacingKhz(first.technology ?? CELL_DEFAULTS.technology)),
      );

      const quality = [...perBuilding.entries()].map(([buildingId, contributors]) => {
        const sorted = [...contributors].sort((a, b) => b.rxDbm - a.rxDbm);
        const serving = sorted[0];
        const interferers = sorted.slice(1);
        const result = computeRadioQuality({
          rsrpDbm: serving.rxDbm,
          interfererRsrpDbm: interferers.map(i => i.rxDbm),
          grid,
          noiseFigureDb: 7,
          loadFactors: interferers.map(i => {
            const match = cells.find((c, idx) => String(c.id ?? c.name ?? `cell-${idx + 1}`) === i.cellId);
            return num(match?.loadFactor, CELL_DEFAULTS.loadFactor);
          }),
        });
        return {
          buildingId,
          servingCellId: serving.cellId,
          interfererCount: interferers.length,
          rsrpDbm: Number(result.rsrpDbm.toFixed(1)),
          sinrDb: Number(result.sinrDb.toFixed(1)),
          rsrqDb: Number(result.rsrqDb.toFixed(1)),
          rssiDbm: Number(result.rssiDbm.toFixed(1)),
          qualityClass: classifyRadioQuality(result),
          interferenceLimited: isInterferenceLimited(result),
        };
      });

      const perCell = traces.map(({ cell, profile, trace }, index) => {
        const check = modelApplicability(selection.model, {
          frequencyGhz: profile.frequencyGhz,
          txHeightM: profile.antennaHeightM,
          rxHeightM: profile.receiverHeightM,
          radiusM,
          walfischIkegamiMode: selection.modelOptions.walfischIkegamiMode,
          buildingHeightM: selection.modelOptions.buildingHeightM,
        });
        const warnings = [...check.warnings];
        // A partial decline is not a failure, but it IS a hole in the result,
        // so say so in the same breath as the numbers rather than leaving the
        // operator to wonder why one sector's map is sparse.
        if (trace.stats.declinedSamples > 0) {
          warnings.push(
            `${modelLabel(selection.model)} declined ${trace.stats.declinedSamples} sample(s) as outside its published validity; ` +
            `those points are left empty rather than estimated with a different model` +
            (trace.stats.declinedRays > 0 ? `, and ${trace.stats.declinedRays} ray(s) produced no usable sample at all` : '') + '.',
          );
        }
        return {
          cellId: String(cell.id ?? cell.name ?? `cell-${index + 1}`),
          name: cell.name ?? null,
          azimuthDeg: num(cell.azimuthDeg, CELL_DEFAULTS.azimuthDeg),
          stats: trace.stats,
          rays: includeRays ? raySegmentsToGeoJson(trace) : null,
          applicability: { applicable: check.applicable, warnings },
        };
      });

      const gaps = body.includeGaps !== false && buildings.size > 0
        ? traces.map(({ cell, profile, trace }, index) => ({
            cellId: String(cell.id ?? cell.name ?? `cell-${index + 1}`),
            ...findCoverageGaps({
              origin: originFor(cell),
              azimuthDeg: num(cell.azimuthDeg, CELL_DEFAULTS.azimuthDeg),
              rays, radiusM, profile, buildings,
              serviceThresholdDbm: typeof body.serviceThresholdDbm === 'number' ? body.serviceThresholdDbm : undefined,
              precomputed: trace,
            }),
          }))
        : null;

      res.json({
        ok: true,
        result: {
          cells: perCell,
          quality,
          gaps,
          resourceGrid: grid,
          buildingsConsidered: buildings.size,
          settings: {
            radiusM, rays, includeRays,
            propagationModel: selection.model,
            modelLabel: modelLabel(selection.model),
            modelOptions: selection.modelOptions,
          },
          warnings: applicable.warnings,
          defaultsApplied: CELL_DEFAULTS,
        },
        calculation: [
          // The worked example has to be the model actually used. Showing a UMa
          // derivation next to a Hata result would misattribute the numbers.
          ...(selection.model === 'uma'
            ? [umaEquation(radiusM, num(first.frequencyGhz, CELL_DEFAULTS.frequencyGhz), num(first.antennaHeightM, CELL_DEFAULTS.antennaHeightM), num(first.receiverHeightM, CELL_DEFAULTS.receiverHeightM), 'nlos')]
            : [modelWorkedExample(selection, first, radiusM)]),
          ...(quality.length ? [radioQualityEquation(computeRadioQuality({ rsrpDbm: quality[0].rsrpDbm, interfererRsrpDbm: [], grid, noiseFigureDb: 7 }))] : []),
        ],
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning: simulate failed');
      res.status(500).json({ ok: false, error: { reason: String(err), missingInputs: [] } });
    }
  });

  /** POST /buildings/import — real OSM footprints for a bounding box. */
  router.post('/buildings/import', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, number>;
      const bounds: [number, number, number, number] = [
        body.minLon, body.minLat, body.maxLon, body.maxLat,
      ];
      if (bounds.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
        res.status(400).json({ ok: false, error: { reason: 'minLon, minLat, maxLon and maxLat are required', missingInputs: ['bounds'] } });
        return;
      }
      // Guard the area: Overpass is a shared public service and a careless
      // bbox can ask for a whole country.
      const spanLon = Math.abs(bounds[2] - bounds[0]);
      const spanLat = Math.abs(bounds[3] - bounds[1]);
      if (spanLon > MAX_IMPORT_SPAN_DEG || spanLat > MAX_IMPORT_SPAN_DEG) {
        res.status(400).json({
          ok: false,
          error: {
            reason:
              `This view spans ${spanLon.toFixed(2)}° x ${spanLat.toFixed(2)}°, over the ${MAX_IMPORT_SPAN_DEG}° limit. ` +
              'Overpass is donated public infrastructure and a request this size will be throttled or time out. ' +
              'Zoom in to the area you are actually planning and import again.',
            missingInputs: [],
          },
        });
        return;
      }
      const osm = await fetchOsmBuildings(bounds);
      res.json({
        ok: true,
        result: {
          endpoint: osm.endpoint,
          cached: osm.cached === true,
          count: osm.features.length,
          attribution: '© OpenStreetMap contributors, ODbL 1.0',
          buildings: osm.features.map(f => {
            const geometry = (f as any).geometry;
            const properties = (f as any).properties ?? {};
            return {
              id: (f as any).id,
              ring: geometry?.coordinates?.[0] ?? [],
              heightM: properties.height ? Number(String(properties.height).replace(/[^\d.]/g, '')) || undefined : undefined,
              demandWeight: properties.demand_weight ?? 0,
              residentialDemand: properties.residential_demand ?? 0,
              densityScore: properties.density_score ?? 0,
              tags: properties,
            };
          }),
        },
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning: building import failed');
      res.status(502).json({ ok: false, error: { reason: String(err), missingInputs: [] } });
    }
  });

  /** POST /building-entry — O2I entry loss at the facade. */
  router.post('/building-entry', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const frequencyGhz = num(body.frequencyGhz, CELL_DEFAULTS.frequencyGhz);
      const tagProfile = buildingEntryProfileFromTags(body.tags as Record<string, string> | undefined);
      const profileId = ((body.profileId as BuildingEntryProfileId) ?? tagProfile ?? 'low_loss');
      const result = buildingEntryLoss(frequencyGhz, profileId, num(body.indoorDepthM, 0));
      res.json({
        ok: true,
        result: { ...result, profileSource: body.profileId ? 'requested' : tagProfile ? 'osm_material_tags' : 'default_low_loss' },
        calculation: [buildingEntryEquation(result)],
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning: building-entry failed');
      res.status(500).json({ ok: false, error: { reason: String(err), missingInputs: [] } });
    }
  });

  /** POST /optimize — azimuth optimisation with a Pareto frontier. */
  router.post('/optimize', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const parsed = validateCells(body.cells);
      if (!parsed.ok) {
        res.status(400).json({ ok: false, error: { reason: parsed.reason, missingInputs: ['cells'] } });
        return;
      }
      const buildings = buildingsFrom(body.buildings);
      if (buildings.size === 0) {
        res.status(400).json({
          ok: false,
          error: { reason: 'optimisation needs building footprints to have any demand to optimise against — import buildings first', missingInputs: ['buildings'] },
        });
        return;
      }
      const cells: OptimizationCell[] = parsed.cells.map((cell, index) => ({
        id: String(cell.id ?? cell.name ?? `cell-${index + 1}`),
        origin: originFor(cell),
        profile: profileFor(cell),
        lockedAzimuthDeg: cell.locked === true ? num(cell.azimuthDeg, 0) : undefined,
      }));
      const result = optimizeNetwork({
        cells, buildings,
        radiusM: Math.min(num(body.radiusM, 400), MAX_RADIUS_M),
        rays: Math.min(Math.max(Math.floor(num(body.rays, 24)), 1), MAX_RAYS),
        azimuthStepDeg: num(body.azimuthStepDeg, 15),
        serviceThresholdDbm: typeof body.serviceThresholdDbm === 'number' ? body.serviceThresholdDbm : undefined,
        overlapWeight: num(body.overlapWeight, 0.5),
      });
      res.json({ ok: true, result });
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning: optimize failed');
      res.status(500).json({ ok: false, error: { reason: String(err), missingInputs: [] } });
    }
  });

  /** POST /recommend-sites — rank candidate positions by marginal demand. */
  router.post('/recommend-sites', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const candidatesRaw = body.candidates;
      if (!Array.isArray(candidatesRaw) || candidatesRaw.length === 0) {
        res.status(400).json({ ok: false, error: { reason: 'at least one candidate site is required', missingInputs: ['candidates'] } });
        return;
      }
      const buildings = buildingsFrom(body.buildings);
      if (buildings.size === 0) {
        res.status(400).json({ ok: false, error: { reason: 'site ranking needs building footprints for demand — import buildings first', missingInputs: ['buildings'] } });
        return;
      }
      const existingParsed = validateCells(body.cells ?? []);
      const existing: OptimizationCell[] = existingParsed.ok
        ? existingParsed.cells.map((cell, index) => ({
            id: String(cell.id ?? `cell-${index + 1}`),
            origin: originFor(cell),
            profile: profileFor(cell),
            lockedAzimuthDeg: num(cell.azimuthDeg, 0),
          }))
        : [];
      const result = recommendSites(
        (candidatesRaw as CellInput[]).map((c, i) => ({
          id: String(c.id ?? `candidate-${i + 1}`),
          origin: originFor(c),
        })),
        existing,
        {
          buildings,
          radiusM: Math.min(num(body.radiusM, 400), MAX_RADIUS_M),
          rays: Math.min(Math.max(Math.floor(num(body.rays, 24)), 1), MAX_RAYS),
          azimuthStepDeg: num(body.azimuthStepDeg, 30),
          serviceThresholdDbm: typeof body.serviceThresholdDbm === 'number' ? body.serviceThresholdDbm : undefined,
          defaultProfile: profileFor((body.defaultCell as CellInput) ?? {} as CellInput),
          maxResults: Math.floor(num(body.maxResults, 5)),
        },
      );
      res.json({ ok: true, result: { recommendations: result, note: 'RF ranking only — says nothing about site availability, cost, backhaul, power or permitting' } });
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning: recommend-sites failed');
      res.status(500).json({ ok: false, error: { reason: String(err), missingInputs: [] } });
    }
  });

  /** POST /validate-measurements — compare predictions with real RSRP. */
  router.post('/validate-measurements', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const raw = body.samples;
      if (!Array.isArray(raw) || raw.length === 0) {
        res.status(400).json({ ok: false, error: { reason: 'at least one measurement sample is required', missingInputs: ['samples'] } });
        return;
      }
      const samples: MeasurementSample[] = [];
      for (const entry of raw as Record<string, number>[]) {
        if (![entry.latitude, entry.longitude, entry.measuredDbm, entry.predictedDbm].every(v => typeof v === 'number' && Number.isFinite(v))) continue;
        samples.push({
          point: { lon: entry.longitude, lat: entry.latitude },
          measuredDbm: entry.measuredDbm,
          predictedDbm: entry.predictedDbm,
        });
      }
      if (samples.length === 0) {
        res.status(400).json({ ok: false, error: { reason: 'no sample had a usable latitude, longitude, measuredDbm and predictedDbm', missingInputs: ['samples'] } });
        return;
      }
      const blockSizeM = num(body.blockSizeM, 250);
      const validation = spatiallyBlockedValidation(samples, blockSizeM, Math.floor(num(body.foldCount, 5)));
      const calibration = holdoutCheckedCalibrationOffset(samples, blockSizeM, Math.floor(num(body.foldCount, 5)));
      res.json({
        ok: true,
        result: {
          ...validation,
          calibration,
          methodology:
            'Error is reported on spatially blocked folds, not a random split: drive-test samples metres apart are ' +
            'strongly correlated, so a random hold-out leaks neighbours into the test set and understates real error.',
        },
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning: validate-measurements failed');
      res.status(500).json({ ok: false, error: { reason: String(err), missingInputs: [] } });
    }
  });


  /**
   * POST /coverage-heatmap — the continuous best-server raster.
   *
   * Separate from /simulate because it is a different question with a very
   * different cost profile: rays answer "why is this street dark" and are
   * cheap; the raster answers "how good is it everywhere" over tens of
   * thousands of points. Keeping them apart lets an operator re-colour the map
   * without re-tracing, and re-trace without paying for a raster.
   */
  router.post('/coverage-heatmap', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const parsed = validateCells(body.cells);
      if (!parsed.ok) {
        res.status(400).json({ ok: false, error: { reason: parsed.reason, missingInputs: ['cells'] } });
        return;
      }
      const cells = parsed.cells;
      const radiusM = Math.min(num(body.radiusM, 400), MAX_RADIUS_M);
      const buildings = buildingsFrom(body.buildings);
      const selection = resolveModelSelection(body, buildings);

      const applicable = checkModelApplicable(cells, selection, radiusM);
      if (!applicable.ok) {
        res.status(400).json({
          ok: false,
          error: { reason: applicable.reason, missingInputs: [], suggestedModels: applicable.suggested },
        });
        return;
      }

      const grid = resolveResourceGrid(
        cells[0].technology ?? CELL_DEFAULTS.technology,
        num(cells[0].bandwidthMhz, CELL_DEFAULTS.bandwidthMhz),
        cells[0].subcarrierSpacingKhz ?? defaultSubcarrierSpacingKhz(cells[0].technology ?? CELL_DEFAULTS.technology),
      );

      const heatmapCells: HeatmapCellInput[] = cells.map((cell, index) => ({
        id: String(cell.id ?? cell.name ?? `cell-${index + 1}`),
        origin: originFor(cell),
        azimuthDeg: num(cell.azimuthDeg, CELL_DEFAULTS.azimuthDeg),
        profile: profileFor(cell, selection),
        loadFactor: num(cell.loadFactor, CELL_DEFAULTS.loadFactor),
        radiusM,
      }));

      const result = computeCoverageHeatmap({
        cells: heatmapCells,
        bounds: boundsForCells(heatmapCells),
        cellSizeM: num(body.cellSizeM, 20),
        buildings: buildings.size > 0 ? buildings : undefined,
        grid,
        includeWallLoss: body.includeWallLoss !== false,
      });

      res.json({
        ok: true,
        result: {
          ...result,
          cellIds: heatmapCells.map(c => c.id),
          propagationModel: selection.model,
          modelLabel: modelLabel(selection.model),
          sampleCeiling: MAX_HEATMAP_SAMPLES,
          warnings: applicable.warnings,
        },
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning: coverage-heatmap failed');
      res.status(500).json({ ok: false, error: { reason: String(err), missingInputs: [] } });
    }
  });

  /**
   * GET /antennas — the selectable antenna models.
   *
   * Served rather than hardcoded in the frontend so the catalogue has exactly
   * one definition, which is also the one the tests assert against and the one
   * a report can name. `defaultFrontToBackDb` travels with it because an entry
   * whose vendor does not publish a front-to-back ratio inherits the engine's
   * own figure, and the UI has to be able to say which number it is using.
   */
  router.get('/antennas', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      result: {
        defaultFrontToBackDb: DEFAULT_FRONT_TO_BACK_DB,
        antennas: ANTENNA_CATALOG.map((a: AntennaModel) => ({
          ...a,
          // Precomputed so the UI never has to re-derive the pattern geometry
          // and risk disagreeing with the engine about it.
          tenDbWidthDeg: Math.round(patternWidthDeg(a.beamWidthDeg, 10) * 10) / 10,
          crossover3SectorDb:
            Math.round(crossoverLossDb(a.beamWidthDeg, 120, a.frontToBackDb ?? DEFAULT_FRONT_TO_BACK_DB) * 10) / 10,
          crossover4SectorDb:
            Math.round(crossoverLossDb(a.beamWidthDeg, 90, a.frontToBackDb ?? DEFAULT_FRONT_TO_BACK_DB) * 10) / 10,
        })),
      },
    });
  });

  /** GET /models — the selectable models and their published validity. */
  router.get('/models', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      result: {
        defaultModel: DEFAULT_SIMULATION_MODEL,
        models: SIMULATION_MODELS.map(id => ({ id, ...SIMULATION_MODEL_INFO[id] })),
      },
    });
  });

  /**
   * POST /report.pdf — the current plan as a document.
   *
   * Takes the already-computed result rather than re-running the simulation:
   * a report must describe exactly what the operator was looking at when they
   * pressed the button, and a re-run could legitimately differ (a different
   * model selection, an edited radio) and silently document something else.
   */
  router.post('/report.pdf', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const radios = Array.isArray(body.radios) ? (body.radios as Record<string, unknown>[]) : [];
      if (radios.length === 0) {
        res.status(400).json({ ok: false, error: { reason: 'a report needs at least one radio', missingInputs: ['radios'] } });
        return;
      }
      const model: SimulationModel = isSimulationModel(body.propagationModel) ? body.propagationModel : DEFAULT_SIMULATION_MODEL;
      const info = SIMULATION_MODEL_INFO[model];
      const settings = (body.settings ?? {}) as Record<string, number>;

      let heatmap: ReportInput['heatmap'];
      const rawPng = body.heatmapPngBase64;
      if (typeof rawPng === 'string' && rawPng.length > 0) {
        const stripped = rawPng.replace(/^data:image\/png;base64,/, '');
        const png = Buffer.from(stripped, 'base64');
        // Size-cap and magic-byte check: this is the one client-supplied blob
        // in the request, so it is validated before pdfkit ever parses it.
        if (png.length > MAX_REPORT_IMAGE_BYTES) {
          res.status(413).json({ ok: false, error: { reason: `coverage image is ${(png.length / 1e6).toFixed(1)} MB, over the ${MAX_REPORT_IMAGE_BYTES / 1e6} MB limit`, missingInputs: [] } });
          return;
        }
        if (!isPng(png)) {
          res.status(400).json({ ok: false, error: { reason: 'coverage image is not a PNG', missingInputs: [] } });
          return;
        }
        const meta = (body.heatmapMeta ?? {}) as Record<string, unknown>;
        heatmap = {
          png,
          metric: typeof meta.metric === 'string' ? meta.metric : 'signal strength',
          legend: Array.isArray(meta.legend) ? (meta.legend as { label: string; color: string }[]) : [],
          coveredPct: typeof meta.coveredPct === 'number' ? meta.coveredPct : 0,
          cellSizeM: typeof meta.cellSizeM === 'number' ? meta.cellSizeM : 0,
        };
      }

      const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'RF Coverage Plan';
      const input: ReportInput = {
        title,
        generatedAt: new Date(),
        model: { id: model, label: info.label, source: info.source, blurb: info.blurb },
        settings: {
          radiusM: num(settings.radiusM, 400),
          rays: num(settings.rays, 60),
          buildingsConsidered: num(settings.buildingsConsidered, 0),
        },
        warnings: Array.isArray(body.warnings) ? (body.warnings as string[]).filter(w => typeof w === 'string') : [],
        radios: radios.map((r, index) => ({
          id: String(r.id ?? `radio-${index + 1}`),
          name: String(r.name ?? `Radio ${index + 1}`),
          latitude: num(r.latitude, 0),
          longitude: num(r.longitude, 0),
          azimuthDeg: num(r.azimuthDeg, 0),
          beamWidthDeg: num(r.beamWidthDeg, CELL_DEFAULTS.beamWidthDeg),
          technology: String(r.technology ?? CELL_DEFAULTS.technology),
          frequencyGhz: num(r.frequencyGhz, CELL_DEFAULTS.frequencyGhz),
          bandwidthMhz: num(r.bandwidthMhz, CELL_DEFAULTS.bandwidthMhz),
          txPowerDbm: num(r.txPowerDbm, CELL_DEFAULTS.txPowerDbm),
          antennaHeightM: num(r.antennaHeightM, CELL_DEFAULTS.antennaHeightM),
          mechanicalDowntiltDeg: num(r.mechanicalDowntiltDeg, CELL_DEFAULTS.mechanicalDowntiltDeg),
          sectorOf: typeof r.siteId === 'string' ? r.siteId : null,
        })),
        cells: Array.isArray(body.cells) ? (body.cells as ReportInput['cells']) : [],
        quality: Array.isArray(body.quality) ? (body.quality as ReportInput['quality']) : [],
        resourceGrid: (body.resourceGrid ?? null) as ReportInput['resourceGrid'],
        gaps: (body.gaps ?? null) as ReportInput['gaps'],
        heatmap,
        attribution: typeof body.attribution === 'string' ? body.attribution : null,
        notes: typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null,
      };

      const filename = `${title.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'rf_plan'}.pdf`;
      const doc = new PDFDocument({ margin: 50, size: 'LETTER', info: { Title: title } });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      doc.pipe(res);
      writeSimulationReport(doc, input);
      doc.end();
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning: report generation failed');
      // Headers are already sent once piping has started, so the only honest
      // move at that point is to end the (truncated) stream.
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: { reason: String(err), missingInputs: [] } });
      } else {
        res.end();
      }
    }
  });

  return router;
}
