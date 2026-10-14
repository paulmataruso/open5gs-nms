// Coverage heatmap: best-server signal and SINR over a regular grid.
//
// This is the continuous raster the ray tracer deliberately is not. The two
// answer different questions and both belong on the map: the raster answers
// "how good is it here", the rays answer "why". They share
// receivedPowerAtPoint() so they can never disagree about the same geometry.
//
// Multi-cell by construction, because the useful version of this layer is
// best-server: every grid point is evaluated against every cell, the
// strongest becomes the serving cell and the rest become interference. A
// per-cell heatmap drawn independently would overpaint neighbours and show
// coverage the network does not actually deliver.

import { BuildingIndex, type Point, groundDistanceM } from './building-index';
import { initialBearingDeg } from './geometry';
import {
  receivedPowerAtPoint, penetrationLossDb, signedAngleDelta,
  type RayTraceProfile,
} from './ray-trace';
import {
  computeRadioQuality, classifyRadioQuality, type ResourceGrid, type QualityClass,
} from './radio-quality';
import { DEFAULT_SIMULATION_MODEL, type SimulationModel } from './propagation-select';

/**
 * Sample ceiling for one request. 160x160 is a 25,600-point grid; at 16 cells
 * that is ~410k power evaluations plus their wall tests, which is seconds of
 * single-threaded work and a response in the low megabytes. The resolution is
 * reduced to fit rather than the request being refused, and the result says
 * what it actually used.
 */
export const MAX_HEATMAP_SAMPLES = 25_600;

/** Floor on grid spacing. Finer than this is below the models' own precision. */
export const MIN_HEATMAP_CELL_SIZE_M = 5;

export interface HeatmapCellInput {
  id: string;
  origin: Point;
  azimuthDeg: number;
  profile: RayTraceProfile;
  /** 0-1 share of resources in use, scaling this cell's interference. */
  loadFactor: number;
  /** Beyond this, the cell is treated as contributing nothing. */
  radiusM: number;
}

export interface HeatmapBounds {
  minLon: number; minLat: number; maxLon: number; maxLat: number;
}

export interface CoverageHeatmapOptions {
  cells: HeatmapCellInput[];
  /** Omit to derive from the cells' own coverage radii. */
  bounds?: HeatmapBounds;
  cellSizeM?: number;
  buildings?: BuildingIndex;
  grid: ResourceGrid;
  noiseFigureDb?: number;
  /** Charge wall penetration between cell and sample point. Dominates cost. */
  includeWallLoss?: boolean;
}

export interface CoverageHeatmapResult {
  bounds: HeatmapBounds;
  cols: number;
  rows: number;
  cellSizeM: number;
  /**
   * Row-major, north-to-south (row 0 is maxLat) so the client can push the
   * array straight into an ImageData buffer without flipping it.
   * null means no cell reached this point, or the model declined it.
   */
  rsrpDbm: (number | null)[];
  sinrDb: (number | null)[];
  /** Index into `cells` of the serving cell, for a server-colouring layer. */
  servingCell: (number | null)[];
  qualityClass: (QualityClass | null)[];
  stats: {
    model: SimulationModel;
    samples: number;
    covered: number;
    declined: number;
    minRsrpDbm: number | null;
    maxRsrpDbm: number | null;
    /** Share of sampled points with any usable signal at all. */
    coveredPct: number;
  };
}

/** Metres per degree of latitude. Local flat-earth is fine at these spans. */
const METRES_PER_DEG_LAT = 111_132.92;

function metresPerDegLonAt(latitudeDeg: number): number {
  return 111_320 * Math.cos((latitudeDeg * Math.PI) / 180);
}

/** Union of every cell's coverage circle, so no sector is clipped. */
export function boundsForCells(cells: HeatmapCellInput[]): HeatmapBounds {
  if (cells.length === 0) return { minLon: -0.01, minLat: -0.01, maxLon: 0.01, maxLat: 0.01 };
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const cell of cells) {
    const dLat = cell.radiusM / METRES_PER_DEG_LAT;
    const dLon = cell.radiusM / Math.max(metresPerDegLonAt(cell.origin.lat), 1);
    minLat = Math.min(minLat, cell.origin.lat - dLat);
    maxLat = Math.max(maxLat, cell.origin.lat + dLat);
    minLon = Math.min(minLon, cell.origin.lon - dLon);
    maxLon = Math.max(maxLon, cell.origin.lon + dLon);
  }
  return { minLon, minLat, maxLon, maxLat };
}

export function computeCoverageHeatmap(options: CoverageHeatmapOptions): CoverageHeatmapResult {
  const { cells, grid, buildings } = options;
  const bounds = options.bounds ?? boundsForCells(cells);
  const includeWallLoss = options.includeWallLoss !== false;

  const centreLat = (bounds.minLat + bounds.maxLat) / 2;
  const mPerDegLon = Math.max(metresPerDegLonAt(centreLat), 1);
  const widthM = Math.max((bounds.maxLon - bounds.minLon) * mPerDegLon, 1);
  const heightM = Math.max((bounds.maxLat - bounds.minLat) * METRES_PER_DEG_LAT, 1);

  // Resolution: honour the request, but shrink it until the grid fits the
  // sample ceiling. Refusing outright would be worse — the operator asked for
  // a picture of this area, and a coarser picture is still the right answer.
  let cellSizeM = Math.max(options.cellSizeM ?? 20, MIN_HEATMAP_CELL_SIZE_M);
  let cols = Math.max(Math.ceil(widthM / cellSizeM), 1);
  let rows = Math.max(Math.ceil(heightM / cellSizeM), 1);
  if (cols * rows > MAX_HEATMAP_SAMPLES) {
    const scale = Math.sqrt((cols * rows) / MAX_HEATMAP_SAMPLES);
    cellSizeM = cellSizeM * scale;
    cols = Math.max(Math.ceil(widthM / cellSizeM), 1);
    rows = Math.max(Math.ceil(heightM / cellSizeM), 1);
  }

  const samples = cols * rows;
  const rsrpDbm: (number | null)[] = new Array(samples).fill(null);
  const sinrDb: (number | null)[] = new Array(samples).fill(null);
  const servingCell: (number | null)[] = new Array(samples).fill(null);
  const qualityClass: (QualityClass | null)[] = new Array(samples).fill(null);

  const wallLossPerCrossing = cells.map(c => penetrationLossDb(c.profile.frequencyGhz));
  let covered = 0;
  let declined = 0;
  let minRsrp: number | null = null;
  let maxRsrp: number | null = null;

  const lonStep = (bounds.maxLon - bounds.minLon) / Math.max(cols - 1, 1);
  const latStep = (bounds.maxLat - bounds.minLat) / Math.max(rows - 1, 1);

  // Reused across every sample: allocating these per point would dominate.
  const contributions: { cellIndex: number; rxDbm: number }[] = [];

  for (let row = 0; row < rows; row++) {
    // Row 0 is the NORTH edge, matching the array-order contract above.
    const lat = bounds.maxLat - row * latStep;
    for (let col = 0; col < cols; col++) {
      const lon = bounds.minLon + col * lonStep;
      const point: Point = { lon, lat };
      contributions.length = 0;
      let declinedHere = false;

      for (let index = 0; index < cells.length; index++) {
        const cell = cells[index];
        const distance = groundDistanceM(cell.origin, point);
        // Outside this cell's own radius it contributes nothing. This is the
        // single biggest saving on a multi-site plan, where most of the
        // bounding box is out of range of most cells.
        if (distance > cell.radiusM) continue;

        let wallLossDb = 0;
        let lineOfSight = true;
        if (includeWallLoss && buildings) {
          const crossings = buildings.segmentIntersections(cell.origin, point);
          if (crossings.length > 0) {
            wallLossDb = crossings.length * wallLossPerCrossing[index];
            lineOfSight = false;
          }
        }

        const bearing = initialBearingDeg(cell.origin.lat, cell.origin.lon, lat, lon);
        const power = receivedPowerAtPoint(
          cell.profile, distance, lineOfSight ? 'los' : 'nlos', wallLossDb,
          signedAngleDelta(cell.azimuthDeg, bearing),
        );
        if (power === null) { declinedHere = true; continue; }
        contributions.push({ cellIndex: index, rxDbm: power.rxDbm });
      }

      const flat = row * cols + col;
      if (contributions.length === 0) {
        // Declined only counts where the model refused — not where the point
        // is simply out of every cell's range, which is an ordinary gap.
        if (declinedHere) declined++;
        continue;
      }

      let serving = contributions[0];
      for (const entry of contributions) if (entry.rxDbm > serving.rxDbm) serving = entry;

      const interferers = contributions.filter(c => c !== serving);
      const quality = computeRadioQuality({
        rsrpDbm: serving.rxDbm,
        interfererRsrpDbm: interferers.map(i => i.rxDbm),
        grid,
        noiseFigureDb: options.noiseFigureDb ?? 7,
        loadFactors: interferers.map(i => cells[i.cellIndex].loadFactor),
      });

      rsrpDbm[flat] = Number(serving.rxDbm.toFixed(1));
      sinrDb[flat] = Number(quality.sinrDb.toFixed(1));
      servingCell[flat] = serving.cellIndex;
      qualityClass[flat] = classifyRadioQuality(quality);
      covered++;
      if (minRsrp === null || serving.rxDbm < minRsrp) minRsrp = serving.rxDbm;
      if (maxRsrp === null || serving.rxDbm > maxRsrp) maxRsrp = serving.rxDbm;
    }
  }

  return {
    bounds, cols, rows,
    cellSizeM: Number(cellSizeM.toFixed(2)),
    rsrpDbm, sinrDb, servingCell, qualityClass,
    stats: {
      model: cells[0]?.profile.model ?? DEFAULT_SIMULATION_MODEL,
      samples, covered, declined,
      minRsrpDbm: minRsrp === null ? null : Number(minRsrp.toFixed(1)),
      maxRsrpDbm: maxRsrp === null ? null : Number(maxRsrp.toFixed(1)),
      coveredPct: samples > 0 ? Number(((covered / samples) * 100).toFixed(1)) : 0,
    },
  };
}
