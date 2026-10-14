import { BuildingIndex, Point } from './building-index';
import { traceBeam, type RayTraceProfile } from './ray-trace';
import { DEFAULT_BUILDING_SERVICE_THRESHOLD_DBM } from './coverage-gap';

// Network optimization: pick azimuths (and rank candidate sites) against
// demand rather than against raw coverage area.
//
// Two design decisions worth stating, because they are what make the output
// usable rather than merely optimal:
//
//   1. The objective is DEMAND served, not area covered. Maximising area
//      rewards pointing sectors at empty fields. Maximising demand rewards
//      pointing them at premises, which is what the network is for.
//
//   2. We return the PARETO SET, not one winner. "Best" depends on a weighting
//      between demand served and overlap that only the operator can choose,
//      and a single blended score hides that choice. Returning the frontier
//      lets them see the trade and pick; the normalised 0-100 score is a
//      convenience for ordering, not an authority.
//
// Overlap is penalised because two sectors illuminating the same building buy
// nothing in coverage terms and cost interference (see radio-quality.ts). It is
// a soft penalty, not a hard constraint: some overlap is legitimate for
// handover.

/** Azimuth candidates per cell, degrees. 15 deg is finer than real mounts allow. */
export const DEFAULT_AZIMUTH_STEP_DEG = 15;

export interface OptimizationCell {
  id: string;
  origin: Point;
  profile: RayTraceProfile;
  /** Fixed azimuth, if this cell must not move. */
  lockedAzimuthDeg?: number;
}

export interface OptimizationOptions {
  cells: OptimizationCell[];
  buildings: BuildingIndex;
  radiusM: number;
  /** Rays per evaluation. Lower is faster and coarser; 24-36 is a good search value. */
  rays?: number;
  azimuthStepDeg?: number;
  serviceThresholdDbm?: number;
  /** Weight on the overlap penalty when computing the convenience score. */
  overlapWeight?: number;
}

export interface CellContribution {
  cellId: string;
  azimuthDeg: number;
  /** Demand this cell serves that no other cell in the set does. */
  exclusiveDemand: number;
  /** Demand this cell serves that is also served by another cell. */
  sharedDemand: number;
  buildingsServed: number;
}

export interface NetworkEvaluation {
  azimuths: Record<string, number>;
  servedDemand: number;
  totalDemand: number;
  demandServedPct: number;
  buildingsServed: number;
  /** Demand counted more than once across cells — the overlap cost. */
  overlapDemand: number;
  /** 0-100 convenience ordering. Not an authority; see module header. */
  score: number;
  contributions: CellContribution[];
}

interface CellCoverage {
  cellId: string;
  azimuthDeg: number;
  /** Building ids this cell serves above threshold. */
  served: Set<string>;
}

/** Evaluate one cell at one azimuth, returning the buildings it serves. */
function coverageFor(
  cell: OptimizationCell,
  azimuthDeg: number,
  options: OptimizationOptions,
): CellCoverage {
  const threshold = options.serviceThresholdDbm ?? DEFAULT_BUILDING_SERVICE_THRESHOLD_DBM;
  const trace = traceBeam({
    origin: cell.origin,
    azimuthDeg,
    rays: options.rays ?? 24,
    radiusM: options.radiusM,
    profile: cell.profile,
    buildings: options.buildings,
    collectSegments: false,
  });
  const served = new Set<string>();
  for (const [buildingId, rxDbm] of trace.buildingCoverage) {
    if (rxDbm > threshold) served.add(buildingId);
  }
  return { cellId: cell.id, azimuthDeg, served };
}

function demandOf(index: BuildingIndex): Map<string, number> {
  const map = new Map<string, number>();
  for (const building of index.buildings()) {
    map.set(building.id, (building.demandWeight ?? 0) + (building.residentialDemand ?? 0));
  }
  return map;
}

export function evaluateNetwork(
  coverages: CellCoverage[],
  demand: Map<string, number>,
  overlapWeight: number,
): NetworkEvaluation {
  // How many cells serve each building?
  const servedBy = new Map<string, string[]>();
  for (const coverage of coverages) {
    for (const buildingId of coverage.served) {
      const list = servedBy.get(buildingId);
      if (list) list.push(coverage.cellId); else servedBy.set(buildingId, [coverage.cellId]);
    }
  }

  let servedDemand = 0;
  let overlapDemand = 0;
  for (const [buildingId, cells] of servedBy) {
    const weight = demand.get(buildingId) ?? 0;
    servedDemand += weight;
    // Each extra cell beyond the first is redundant coverage.
    if (cells.length > 1) overlapDemand += weight * (cells.length - 1);
  }

  let totalDemand = 0;
  for (const weight of demand.values()) totalDemand += weight;

  const contributions: CellContribution[] = coverages.map(coverage => {
    let exclusive = 0, shared = 0;
    for (const buildingId of coverage.served) {
      const weight = demand.get(buildingId) ?? 0;
      if ((servedBy.get(buildingId)?.length ?? 0) > 1) shared += weight; else exclusive += weight;
    }
    return {
      cellId: coverage.cellId,
      azimuthDeg: coverage.azimuthDeg,
      exclusiveDemand: Number(exclusive.toFixed(2)),
      sharedDemand: Number(shared.toFixed(2)),
      buildingsServed: coverage.served.size,
    };
  });

  const demandServedPct = totalDemand > 0 ? (servedDemand / totalDemand) * 100 : 0;
  // Convenience score: served demand fraction, minus a weighted overlap cost.
  const overlapFraction = totalDemand > 0 ? overlapDemand / totalDemand : 0;
  const score = Math.max(0, Math.min(100, demandServedPct - overlapWeight * overlapFraction * 100));

  return {
    azimuths: Object.fromEntries(coverages.map(c => [c.cellId, c.azimuthDeg])),
    servedDemand: Number(servedDemand.toFixed(2)),
    totalDemand: Number(totalDemand.toFixed(2)),
    demandServedPct: Number(demandServedPct.toFixed(1)),
    buildingsServed: servedBy.size,
    overlapDemand: Number(overlapDemand.toFixed(2)),
    score: Number(score.toFixed(1)),
    contributions,
  };
}

export interface OptimizationResult {
  /** Highest-scoring configuration found. */
  best: NetworkEvaluation;
  /** Non-dominated configurations on the (served demand, overlap) frontier. */
  pareto: NetworkEvaluation[];
  baseline?: NetworkEvaluation;
  /** How the baseline improved, when one was supplied. */
  improvement?: { demandServedPctDelta: number; overlapDemandDelta: number };
  evaluations: number;
  azimuthStepDeg: number;
}

/**
 * Coordinate-descent azimuth search.
 *
 * An exhaustive joint search is (360/step)^cells evaluations — 24^8 for eight
 * cells, which is not happening. Coordinate descent re-optimises one cell at a
 * time against the others held fixed, repeating until nothing improves. It is
 * a local optimum, not a global one, and that is stated rather than implied:
 * sector azimuth objectives are smooth enough in practice that this lands
 * close, and the Pareto set carries the alternatives worth considering.
 */
export function optimizeNetwork(options: OptimizationOptions): OptimizationResult {
  const step = options.azimuthStepDeg ?? DEFAULT_AZIMUTH_STEP_DEG;
  const overlapWeight = options.overlapWeight ?? 0.5;
  const demand = demandOf(options.buildings);
  const candidateAzimuths = (cell: OptimizationCell): number[] => {
    if (cell.lockedAzimuthDeg !== undefined) return [cell.lockedAzimuthDeg];
    const out: number[] = [];
    for (let a = 0; a < 360; a += step) out.push(a);
    return out;
  };

  let evaluations = 0;
  const cache = new Map<string, CellCoverage>();
  const coverageCached = (cell: OptimizationCell, azimuth: number): CellCoverage => {
    const key = `${cell.id}@${azimuth}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const value = coverageFor(cell, azimuth, options);
    cache.set(key, value);
    evaluations++;
    return value;
  };

  // Start each cell at its locked azimuth, or at its individually best one.
  const current = new Map<string, CellCoverage>();
  for (const cell of options.cells) {
    let bestCoverage: CellCoverage | null = null;
    let bestDemand = -Infinity;
    for (const azimuth of candidateAzimuths(cell)) {
      const coverage = coverageCached(cell, azimuth);
      let sum = 0;
      for (const id of coverage.served) sum += demand.get(id) ?? 0;
      if (sum > bestDemand) { bestDemand = sum; bestCoverage = coverage; }
    }
    current.set(cell.id, bestCoverage!);
  }

  const frontier: NetworkEvaluation[] = [];
  const consider = (evaluation: NetworkEvaluation) => frontier.push(evaluation);
  consider(evaluateNetwork([...current.values()], demand, overlapWeight));

  // Coordinate descent, bounded so a pathological case cannot spin.
  const MAX_PASSES = 4;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let improved = false;
    for (const cell of options.cells) {
      if (cell.lockedAzimuthDeg !== undefined) continue;
      const others = [...current.entries()].filter(([id]) => id !== cell.id).map(([, c]) => c);
      let bestScore = -Infinity;
      let bestCoverage = current.get(cell.id)!;
      for (const azimuth of candidateAzimuths(cell)) {
        const coverage = coverageCached(cell, azimuth);
        const evaluation = evaluateNetwork([...others, coverage], demand, overlapWeight);
        consider(evaluation);
        if (evaluation.score > bestScore) { bestScore = evaluation.score; bestCoverage = coverage; }
      }
      if (bestCoverage.azimuthDeg !== current.get(cell.id)!.azimuthDeg) {
        current.set(cell.id, bestCoverage);
        improved = true;
      }
    }
    if (!improved) break;
  }

  const best = evaluateNetwork([...current.values()], demand, overlapWeight);
  consider(best);

  return {
    best,
    pareto: paretoFrontier(frontier),
    evaluations,
    azimuthStepDeg: step,
  };
}

/**
 * Non-dominated set on (served demand maximised, overlap demand minimised).
 * A configuration is dominated when another serves at least as much demand
 * with no more overlap, and is strictly better on one of the two.
 */
export function paretoFrontier(evaluations: NetworkEvaluation[]): NetworkEvaluation[] {
  // De-duplicate identical azimuth sets first, so the frontier is distinct
  // configurations rather than repeats from the search path.
  const unique = new Map<string, NetworkEvaluation>();
  for (const evaluation of evaluations) {
    const key = Object.entries(evaluation.azimuths).sort().map(([k, v]) => `${k}:${v}`).join('|');
    const existing = unique.get(key);
    if (!existing || evaluation.score > existing.score) unique.set(key, evaluation);
  }
  const list = [...unique.values()];
  return list
    .filter(candidate =>
      !list.some(other =>
        other !== candidate &&
        other.servedDemand >= candidate.servedDemand &&
        other.overlapDemand <= candidate.overlapDemand &&
        (other.servedDemand > candidate.servedDemand || other.overlapDemand < candidate.overlapDemand),
      ),
    )
    .sort((a, b) => b.servedDemand - a.servedDemand || a.overlapDemand - b.overlapDemand);
}

export interface SiteCandidate {
  id: string;
  origin: Point;
  profile?: RayTraceProfile;
}

export interface SiteRecommendation {
  candidateId: string;
  origin: Point;
  bestAzimuthDeg: number;
  /** Demand this candidate would add that the existing network does not serve. */
  marginalDemand: number;
  /** Demand it would serve that is already covered — wasted capability. */
  redundantDemand: number;
  newBuildingsServed: number;
  rank: number;
}

/**
 * Rank candidate sites by MARGINAL demand against the existing network.
 *
 * Ranking by absolute coverage picks the candidate in the densest area, which
 * is usually already served. Ranking by marginal gain picks the one that adds
 * the most that is currently missing, which is the actual siting question.
 *
 * This says nothing about site availability, cost, backhaul, power or
 * permitting — it is an RF ranking only.
 */
export function recommendSites(
  candidates: SiteCandidate[],
  existing: OptimizationCell[],
  options: Omit<OptimizationOptions, 'cells'> & { defaultProfile: RayTraceProfile; maxResults?: number },
): SiteRecommendation[] {
  const demand = demandOf(options.buildings);
  const threshold = options.serviceThresholdDbm ?? DEFAULT_BUILDING_SERVICE_THRESHOLD_DBM;
  const step = options.azimuthStepDeg ?? DEFAULT_AZIMUTH_STEP_DEG;

  // What the current network already serves.
  const alreadyServed = new Set<string>();
  for (const cell of existing) {
    const azimuth = cell.lockedAzimuthDeg ?? 0;
    const coverage = coverageFor(cell, azimuth, { ...options, cells: existing });
    for (const id of coverage.served) alreadyServed.add(id);
  }

  const recommendations: SiteRecommendation[] = candidates.map(candidate => {
    const profile = candidate.profile ?? options.defaultProfile;
    let bestAzimuth = 0, bestMarginal = -Infinity, bestRedundant = 0, bestNew = 0;
    for (let azimuth = 0; azimuth < 360; azimuth += step) {
      const trace = traceBeam({
        origin: candidate.origin, azimuthDeg: azimuth, rays: options.rays ?? 24,
        radiusM: options.radiusM, profile, buildings: options.buildings, collectSegments: false,
      });
      let marginal = 0, redundant = 0, newCount = 0;
      for (const [buildingId, rxDbm] of trace.buildingCoverage) {
        if (rxDbm <= threshold) continue;
        const weight = demand.get(buildingId) ?? 0;
        if (alreadyServed.has(buildingId)) redundant += weight;
        else { marginal += weight; newCount++; }
      }
      if (marginal > bestMarginal) {
        bestMarginal = marginal; bestAzimuth = azimuth; bestRedundant = redundant; bestNew = newCount;
      }
    }
    return {
      candidateId: candidate.id,
      origin: candidate.origin,
      bestAzimuthDeg: bestAzimuth,
      marginalDemand: Number(Math.max(bestMarginal, 0).toFixed(2)),
      redundantDemand: Number(bestRedundant.toFixed(2)),
      newBuildingsServed: bestNew,
      rank: 0,
    };
  });

  recommendations.sort((a, b) => b.marginalDemand - a.marginalDemand || b.newBuildingsServed - a.newBuildingsServed);
  recommendations.forEach((r, i) => { r.rank = i + 1; });
  return options.maxResults ? recommendations.slice(0, options.maxResults) : recommendations;
}
