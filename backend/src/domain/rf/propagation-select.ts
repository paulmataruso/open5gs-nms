// Model selection for the simulate-driven planning workflow.
//
// This is the ONE place that maps a model name onto a path-loss formula for
// the ray tracer and the coverage heatmap, so those two can never disagree
// about what "Hata" means on the same screen. It holds no physics of its own
// — every branch calls the same model module the legacy link-budget and
// coverage-grid tools call.
//
// Why a second dispatcher exists at all, next to site-signal.ts's
// computeBasePathLossDb(): that one is async (ITM needs a resolved terrain
// profile) and positional. The inner loops here run tens of thousands of
// times per request and cannot await anything, so they need a synchronous
// entry point. site-signal.ts delegates to this function for every model the
// two have in common, which keeps the dispatch itself single-sourced; the
// only branch it still owns is ITM.
//
// ITM is deliberately absent from SimulationModel: its algorithm is
// profile-shaped, so it has no meaning without per-point terrain. It stays
// available on the legacy /point-analysis and /coverage-grid paths, which do
// resolve real profiles.

import { fsplDb } from './pathloss-fspl';
import { umaPathLossDb, UMA_DISTANCE_RANGE_M, UMA_FREQ_RANGE_GHZ, UMA_RX_HEIGHT_RANGE_M, type UmaLosState } from './uma-model';
import {
  closeInPathLossDb, UMI_SC_LOS_PLE, UMI_SC_NLOS_PLE, UMI_SC_FREQ_RANGE_GHZ,
} from './close-in-model';
import { logDistancePathLossDb, LOG_DISTANCE_ENVIRONMENT_PRESETS } from './log-distance-model';
import {
  hataPathLossDb, cost231HataPathLossDb,
  HATA_FREQ_RANGE_MHZ, HATA_TX_HEIGHT_RANGE_M, HATA_RX_HEIGHT_RANGE_M, HATA_DISTANCE_RANGE_KM,
  COST231_FREQ_RANGE_MHZ, COST231_DISTANCE_RANGE_KM,
} from './hata-model';
import {
  walfischIkegamiPathLossDb, WI_FREQ_RANGE_MHZ, WI_BASE_HEIGHT_RANGE_M, WI_MOBILE_HEIGHT_RANGE_M,
  WI_DISTANCE_RANGE_KM, WI_DEFAULT_BUILDING_SEPARATION_M, WI_DEFAULT_STREET_ORIENTATION_DEG,
  wiDefaultStreetWidthM,
} from './walfisch-ikegami-model';
import type {
  HataEnvironment, Cost231CityType, LogDistanceEnvironment, WalfischIkegamiMode,
} from './rf-types';

/** Models usable in the simulate workflow — every one is pure geometry/maths. */
export type SimulationModel =
  | 'uma' | 'fspl' | 'close-in' | 'log-distance' | 'hata' | 'cost231-hata' | 'walfisch-ikegami';

export const SIMULATION_MODELS: SimulationModel[] = [
  'uma', 'fspl', 'close-in', 'log-distance', 'hata', 'cost231-hata', 'walfisch-ikegami',
];

export const DEFAULT_SIMULATION_MODEL: SimulationModel = 'uma';

export interface SimulationModelParams {
  /** Ground (2D) distance. Models needing 3D slant distance derive it themselves. */
  distanceM: number;
  frequencyGhz: number;
  txHeightM: number;
  rxHeightM: number;
  /** Drives UMa's LOS/NLOS branch and close-in's exponent choice. */
  lineOfSight: boolean;
  /** 'close-in' and 'log-distance': overrides the preset exponent. */
  pathLossExponent?: number;
  logDistanceEnvironment?: LogDistanceEnvironment;
  hataEnvironment?: HataEnvironment;
  cityType?: Cost231CityType;
  walfischIkegamiMode?: WalfischIkegamiMode;
  /** Walfisch-Ikegami NLOS: representative rooftop height. No honest default. */
  buildingHeightM?: number;
  streetWidthM?: number;
  buildingSeparationM?: number;
  streetOrientationDeg?: number;
}

/**
 * Path loss for one point, or null when the model declines this input.
 *
 * null is a real answer, not an error: Hata genuinely has nothing to say
 * below 1 km, and fabricating a number there would be worse than a gap. Every
 * caller must propagate the gap rather than substituting another model — see
 * the declined-sample counters in ray-trace.ts and coverage-heatmap.ts.
 */
export function simulationPathLossDb(model: SimulationModel, p: SimulationModelParams): number | null {
  const distanceM = Math.max(p.distanceM, 1);
  const frequencyHz = p.frequencyGhz * 1e9;
  const frequencyMhz = p.frequencyGhz * 1000;
  const losState: UmaLosState = p.lineOfSight ? 'los' : 'nlos';

  switch (model) {
    case 'uma':
      return umaPathLossDb(distanceM, p.frequencyGhz, p.txHeightM, p.rxHeightM, losState);

    case 'fspl':
      return fsplDb(distanceM, frequencyHz);

    case 'close-in': {
      const n = p.pathLossExponent ?? (p.lineOfSight ? UMI_SC_LOS_PLE : UMI_SC_NLOS_PLE);
      return closeInPathLossDb(distanceM, frequencyHz, n);
    }

    case 'log-distance': {
      const n = p.pathLossExponent
        ?? LOG_DISTANCE_ENVIRONMENT_PRESETS[p.logDistanceEnvironment ?? 'urban'].pathLossExponent;
      return logDistancePathLossDb(distanceM, frequencyHz, n);
    }

    case 'hata': {
      const r = hataPathLossDb(frequencyMhz, p.txHeightM, p.rxHeightM, distanceM / 1000, p.hataEnvironment ?? 'urban');
      return r.ok ? r.pathLossDb : null;
    }

    case 'cost231-hata': {
      const r = cost231HataPathLossDb(frequencyMhz, p.txHeightM, p.rxHeightM, distanceM / 1000, p.cityType ?? 'medium');
      return r.ok ? r.pathLossDb : null;
    }

    case 'walfisch-ikegami': {
      const mode = p.walfischIkegamiMode ?? 'nlos';
      // NLOS is rooftop-diffraction-shaped, so it is meaningless without a
      // real rooftop height. Decline rather than invent one.
      if (mode === 'nlos' && p.buildingHeightM == null) return null;
      const separation = p.buildingSeparationM ?? WI_DEFAULT_BUILDING_SEPARATION_M;
      const r = walfischIkegamiPathLossDb(
        frequencyMhz, p.txHeightM, p.rxHeightM, distanceM / 1000, mode,
        p.buildingHeightM ?? 0,
        p.streetWidthM ?? wiDefaultStreetWidthM(separation),
        separation,
        p.streetOrientationDeg ?? WI_DEFAULT_STREET_ORIENTATION_DEG,
        p.cityType ?? 'medium',
      );
      return r.ok ? r.pathLossDb : null;
    }
  }
}

export interface SimulationModelInfo {
  label: string;
  /** One line, written for an operator choosing between them. */
  blurb: string;
  frequencyRangeGhz: [number, number] | null;
  distanceRangeM: [number, number] | null;
  txHeightRangeM: [number, number] | null;
  rxHeightRangeM: [number, number] | null;
  source: string;
  /** NLOS mode needs a real rooftop height from somewhere. */
  requiresBuildingHeight?: boolean;
}

export const SIMULATION_MODEL_INFO: Record<SimulationModel, SimulationModelInfo> = {
  'uma': {
    label: 'UMa (3GPP TR 38.901)',
    blurb: 'Urban macro, dual-slope LOS with a breakpoint plus a height-corrected NLOS floor. The right default for CBRS mid-band.',
    frequencyRangeGhz: UMA_FREQ_RANGE_GHZ,
    distanceRangeM: UMA_DISTANCE_RANGE_M,
    txHeightRangeM: null,
    rxHeightRangeM: UMA_RX_HEIGHT_RANGE_M,
    source: '3GPP TR 38.901 Table 7.4.1-1',
  },
  'fspl': {
    label: 'Free-space path loss',
    blurb: 'Pure inverse-square spreading, no clutter at all. A best-case bound and a sanity check, not a plan.',
    frequencyRangeGhz: null, distanceRangeM: null, txHeightRangeM: null, rxHeightRangeM: null,
    source: 'Friis transmission equation',
  },
  'close-in': {
    label: 'Close-in (UMi street canyon)',
    blurb: 'Measured 1 m reference with a street-canyon exponent. Valid across mid-band and mmWave, good for small cells.',
    frequencyRangeGhz: UMI_SC_FREQ_RANGE_GHZ,
    distanceRangeM: null, txHeightRangeM: null, rxHeightRangeM: null,
    source: 'Rappaport et al., close-in free-space reference distance model',
  },
  'log-distance': {
    label: 'Log-distance (configurable exponent)',
    blurb: 'Generic power law. Use when you have a measured exponent for the area; otherwise it is a guess with a formula around it.',
    frequencyRangeGhz: null, distanceRangeM: null, txHeightRangeM: null, rxHeightRangeM: null,
    source: 'Log-distance path loss model',
  },
  'hata': {
    label: 'Hata',
    blurb: 'Classic macro-cell empirical fit for VHF/UHF. Needs a tall tower and at least a kilometre of distance.',
    frequencyRangeGhz: [HATA_FREQ_RANGE_MHZ[0] / 1000, HATA_FREQ_RANGE_MHZ[1] / 1000],
    distanceRangeM: [HATA_DISTANCE_RANGE_KM[0] * 1000, HATA_DISTANCE_RANGE_KM[1] * 1000],
    txHeightRangeM: HATA_TX_HEIGHT_RANGE_M,
    rxHeightRangeM: HATA_RX_HEIGHT_RANGE_M,
    source: 'Okumura-Hata empirical model',
  },
  'cost231-hata': {
    label: 'COST-231-Hata',
    blurb: 'Hata extended to PCS bands. Still a macro-cell model: 1 km minimum, 30 m minimum tower.',
    frequencyRangeGhz: [COST231_FREQ_RANGE_MHZ[0] / 1000, COST231_FREQ_RANGE_MHZ[1] / 1000],
    distanceRangeM: [COST231_DISTANCE_RANGE_KM[0] * 1000, COST231_DISTANCE_RANGE_KM[1] * 1000],
    txHeightRangeM: HATA_TX_HEIGHT_RANGE_M,
    rxHeightRangeM: HATA_RX_HEIGHT_RANGE_M,
    source: 'COST-231 extension to the Hata model',
  },
  'walfisch-ikegami': {
    label: 'Walfisch-Ikegami',
    blurb: 'Street-level urban model with explicit rooftop diffraction. Needs a representative building height.',
    frequencyRangeGhz: [WI_FREQ_RANGE_MHZ[0] / 1000, WI_FREQ_RANGE_MHZ[1] / 1000],
    distanceRangeM: [WI_DISTANCE_RANGE_KM[0] * 1000, WI_DISTANCE_RANGE_KM[1] * 1000],
    txHeightRangeM: WI_BASE_HEIGHT_RANGE_M,
    rxHeightRangeM: WI_MOBILE_HEIGHT_RANGE_M,
    source: 'COST-231 Walfisch-Ikegami model',
    requiresBuildingHeight: true,
  },
};

export interface ModelScenario {
  frequencyGhz: number;
  txHeightM: number;
  rxHeightM: number;
  /** Largest distance the run will evaluate. */
  radiusM: number;
  walfischIkegamiMode?: WalfischIkegamiMode;
  buildingHeightM?: number;
}

export interface ModelApplicability {
  model: SimulationModel;
  /** False means this run would produce nothing — reject it up front. */
  applicable: boolean;
  /** Reasons the model cannot run at all, each naming the real published range. */
  blocking: string[];
  /** Reasons to distrust the result without stopping the run. */
  warnings: string[];
  /** Models that ARE valid for this scenario, for an actionable error message. */
  suggested: SimulationModel[];
}

function outside(value: number, range: [number, number] | null): boolean {
  return range != null && (value < range[0] || value > range[1]);
}

/**
 * Check a model against the scenario BEFORE running it.
 *
 * This exists because three of these models hard-reject out-of-range inputs
 * per point rather than extrapolating (correctly — see hata-model.ts's own
 * rangeCheck). Without an up-front check, picking Hata for a 3.6 GHz CBRS
 * cell produces a technically-successful run with an empty map and no stated
 * reason. Far better to refuse with the actual numbers and name the models
 * that do cover this band.
 */
export function modelApplicability(model: SimulationModel, scenario: ModelScenario): ModelApplicability {
  const { blocking, warnings } = evaluateModel(model, scenario);
  // Suggestions are computed with evaluateModel, NOT by recursing into this
  // function: each candidate would then compute its OWN suggestions, and two
  // mutually-inapplicable models recurse until the stack dies. That is the
  // normal case here, not an edge one — at CBRS 3.6 GHz, Hata, COST-231 and
  // Walfisch-Ikegami are all out of band simultaneously.
  const suggested = blocking.length > 0
    ? SIMULATION_MODELS.filter(m => m !== model && evaluateModel(m, scenario).blocking.length === 0)
    : [];
  return { model, applicable: blocking.length === 0, blocking, warnings, suggested };
}

/** Blocking/warning evaluation for one model. Deliberately suggestion-free. */
function evaluateModel(
  model: SimulationModel, scenario: ModelScenario,
): { blocking: string[]; warnings: string[] } {
  const info = SIMULATION_MODEL_INFO[model];
  const blocking: string[] = [];
  const warnings: string[] = [];

  if (outside(scenario.frequencyGhz, info.frequencyRangeGhz)) {
    const [lo, hi] = info.frequencyRangeGhz!;
    blocking.push(
      `${info.label} is specified for ${lo}-${hi} GHz; this radio is at ${scenario.frequencyGhz} GHz.`,
    );
  }
  if (outside(scenario.txHeightM, info.txHeightRangeM)) {
    const [lo, hi] = info.txHeightRangeM!;
    blocking.push(
      `${info.label} needs a transmit height of ${lo}-${hi} m; this radio is at ${scenario.txHeightM} m.`,
    );
  }
  if (outside(scenario.rxHeightM, info.rxHeightRangeM)) {
    const [lo, hi] = info.rxHeightRangeM!;
    blocking.push(
      `${info.label} needs a receiver height of ${lo}-${hi} m; this run uses ${scenario.rxHeightM} m.`,
    );
  }

  // Distance is a range over the run, not one value: a radius below the
  // model's minimum means EVERY sample is declined, which is blocking. A
  // radius above its maximum only truncates the far edge, which is a warning.
  if (info.distanceRangeM) {
    const [lo, hi] = info.distanceRangeM;
    if (scenario.radiusM < lo) {
      blocking.push(
        `${info.label} is only valid from ${lo} m outward; this run's radius is ${scenario.radiusM} m, so every sample would fall inside its minimum.`,
      );
    } else if (scenario.radiusM > hi) {
      warnings.push(
        `${info.label} is specified out to ${hi} m; samples beyond that (radius ${scenario.radiusM} m) will be left empty.`,
      );
    }
  }

  if (info.requiresBuildingHeight && (scenario.walfischIkegamiMode ?? 'nlos') === 'nlos' && scenario.buildingHeightM == null) {
    blocking.push(
      `${info.label} in NLOS mode needs a representative rooftop height — import buildings so one can be measured, enter it directly, or switch the model to LOS mode.`,
    );
  }

  return { blocking, warnings };
}

/** Human-readable name, for reports and response echoes. */
export function modelLabel(model: SimulationModel): string {
  return SIMULATION_MODEL_INFO[model].label;
}

export function isSimulationModel(value: unknown): value is SimulationModel {
  return typeof value === 'string' && (SIMULATION_MODELS as string[]).includes(value);
}
