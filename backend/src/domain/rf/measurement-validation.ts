import type { Point } from './building-index';
import { groundDistanceM } from './building-index';

// Validate a prediction against real measurements.
//
// This is the only part of the engine that can tell you whether any of the
// rest is right. Everything else is a model; this compares the model to
// measured RSRP and reports how wrong it is.
//
// The one methodological point that matters more than all the statistics:
// VALIDATE ON SPATIALLY BLOCKED FOLDS, not a random split. Drive-test samples
// taken metres apart are strongly correlated, so a random hold-out leaks
// neighbours of every training point into the test set and reports an error
// far lower than the model will actually achieve at an unvisited location.
// Blocking by geography is the difference between an honest number and a
// flattering one.

export interface MeasurementSample {
  point: Point;
  /** Measured RSRP, dBm. */
  measuredDbm: number;
  /** Model prediction at the same point, dBm. */
  predictedDbm: number;
}

export interface ResidualStats {
  count: number;
  /** Mean absolute error, dB. */
  maeDb: number;
  /** Root mean squared error, dB. */
  rmseDb: number;
  /** Mean signed error (predicted − measured). Positive = model is optimistic. */
  biasDb: number;
  /** Standard deviation of the residuals, dB. */
  stdDevDb: number;
  /** Largest absolute residual, dB. */
  maxAbsErrorDb: number;
  /** Pearson correlation between predicted and measured. */
  correlation: number;
}

export function residualStats(samples: MeasurementSample[]): ResidualStats {
  const n = samples.length;
  if (n === 0) {
    return { count: 0, maeDb: 0, rmseDb: 0, biasDb: 0, stdDevDb: 0, maxAbsErrorDb: 0, correlation: 0 };
  }
  const residuals = samples.map(s => s.predictedDbm - s.measuredDbm);
  const bias = residuals.reduce((a, b) => a + b, 0) / n;
  const mae = residuals.reduce((a, b) => a + Math.abs(b), 0) / n;
  const rmse = Math.sqrt(residuals.reduce((a, b) => a + b * b, 0) / n);
  const variance = residuals.reduce((a, b) => a + (b - bias) ** 2, 0) / n;
  const maxAbs = residuals.reduce((a, b) => Math.max(a, Math.abs(b)), 0);

  // Pearson r between predicted and measured.
  const meanP = samples.reduce((a, s) => a + s.predictedDbm, 0) / n;
  const meanM = samples.reduce((a, s) => a + s.measuredDbm, 0) / n;
  let cov = 0, varP = 0, varM = 0;
  for (const s of samples) {
    const dp = s.predictedDbm - meanP;
    const dm = s.measuredDbm - meanM;
    cov += dp * dm; varP += dp * dp; varM += dm * dm;
  }
  const correlation = varP > 0 && varM > 0 ? cov / Math.sqrt(varP * varM) : 0;

  return {
    count: n,
    maeDb: round2(mae),
    rmseDb: round2(rmse),
    biasDb: round2(bias),
    stdDevDb: round2(Math.sqrt(variance)),
    maxAbsErrorDb: round2(maxAbs),
    correlation: round2(correlation),
  };
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

/**
 * Assign samples to spatial blocks of the given size.
 *
 * The grid is anchored at the south-west corner of the sample bounding box,
 * NOT at the first sample. Anchoring on a sample places that sample exactly on
 * a block boundary, so its immediate neighbours fall into different blocks —
 * confirmed live: two samples 8 m apart landed in blocks 0 and 1 under a 250 m
 * block size, which defeats the entire purpose of blocking. Anchoring at the
 * bounding-box corner also makes every offset non-negative, which removes the
 * sign handling that caused the straddle in the first place.
 */
export function spatialBlocks(samples: MeasurementSample[], blockSizeM: number): number[] {
  if (samples.length === 0) return [];
  const minLon = Math.min(...samples.map(s => s.point.lon));
  const minLat = Math.min(...samples.map(s => s.point.lat));
  const anchor: Point = { lon: minLon, lat: minLat };
  return samples.map(sample => {
    // Non-negative east/north offsets from the bounding-box corner.
    const east = groundDistanceM({ lon: anchor.lon, lat: sample.point.lat }, sample.point);
    const north = groundDistanceM({ lon: sample.point.lon, lat: anchor.lat }, sample.point);
    const bx = Math.floor(east / blockSizeM);
    const by = Math.floor(north / blockSizeM);
    // Cantor pairing to a single non-negative block id.
    return ((bx + by) * (bx + by + 1)) / 2 + by;
  });
}

export interface BlockedValidationResult {
  overall: ResidualStats;
  /** Per-fold held-out statistics. */
  folds: { fold: number; heldOutSamples: number; stats: ResidualStats }[];
  /** Mean of the per-fold held-out MAE — the honest headline number. */
  blockedMaeDb: number;
  blockedRmseDb: number;
  blockSizeM: number;
  foldCount: number;
  /** Set when there were too few distinct blocks to fold meaningfully. */
  warning?: string;
}

export function spatiallyBlockedValidation(
  samples: MeasurementSample[],
  blockSizeM = 250,
  foldCount = 5,
): BlockedValidationResult {
  const overall = residualStats(samples);
  const blocks = spatialBlocks(samples, blockSizeM);
  const distinct = [...new Set(blocks)];

  if (distinct.length < 2) {
    return {
      overall, folds: [], blockedMaeDb: overall.maeDb, blockedRmseDb: overall.rmseDb,
      blockSizeM, foldCount: 0,
      warning:
        `all ${samples.length} sample(s) fall in a single ${blockSizeM} m block, so blocked validation is not ` +
        'possible — the reported error is in-sample and will understate real-world error',
    };
  }

  const folds = Math.min(foldCount, distinct.length);
  // Assign whole blocks to folds, so no block spans two folds.
  const blockFold = new Map<number, number>();
  distinct.forEach((block, index) => blockFold.set(block, index % folds));

  const foldStats: BlockedValidationResult['folds'] = [];
  for (let fold = 0; fold < folds; fold++) {
    const heldOut = samples.filter((_, i) => blockFold.get(blocks[i]) === fold);
    if (heldOut.length === 0) continue;
    foldStats.push({ fold, heldOutSamples: heldOut.length, stats: residualStats(heldOut) });
  }

  const maeMean = foldStats.reduce((a, f) => a + f.stats.maeDb, 0) / Math.max(foldStats.length, 1);
  const rmseMean = foldStats.reduce((a, f) => a + f.stats.rmseDb, 0) / Math.max(foldStats.length, 1);

  return {
    overall, folds: foldStats,
    blockedMaeDb: round2(maeMean),
    blockedRmseDb: round2(rmseMean),
    blockSizeM, foldCount: folds,
  };
}

export interface CalibrationOffsetResult {
  offsetDb: number;
  applied: boolean;
  /** Blocked MAE before and after, so the gain is visible rather than asserted. */
  beforeMaeDb: number;
  afterMaeDb: number;
  detail: string;
}

/**
 * A single global dB offset that removes the measured bias.
 *
 * Only offered when it is holdout-CHECKED: the offset is derived from the
 * training folds and its benefit measured on the held-out ones. An offset
 * fitted and reported on the same samples always looks like an improvement,
 * which is how a model gets quietly tuned into overfitting.
 */
export function holdoutCheckedCalibrationOffset(
  samples: MeasurementSample[],
  blockSizeM = 250,
  foldCount = 5,
  minimumSamples = 30,
): CalibrationOffsetResult {
  if (samples.length < minimumSamples) {
    return {
      offsetDb: 0, applied: false, beforeMaeDb: residualStats(samples).maeDb, afterMaeDb: residualStats(samples).maeDb,
      detail: `need at least ${minimumSamples} samples to fit a calibration offset; got ${samples.length}`,
    };
  }
  const blocks = spatialBlocks(samples, blockSizeM);
  const distinct = [...new Set(blocks)];
  if (distinct.length < 2) {
    return {
      offsetDb: 0, applied: false, beforeMaeDb: residualStats(samples).maeDb, afterMaeDb: residualStats(samples).maeDb,
      detail: 'samples occupy a single spatial block, so an offset cannot be holdout-checked',
    };
  }
  const folds = Math.min(foldCount, distinct.length);
  const blockFold = new Map<number, number>();
  distinct.forEach((block, index) => blockFold.set(block, index % folds));

  let beforeAbs = 0, afterAbs = 0, count = 0;
  const offsets: number[] = [];
  for (let fold = 0; fold < folds; fold++) {
    const train = samples.filter((_, i) => blockFold.get(blocks[i]) !== fold);
    const test = samples.filter((_, i) => blockFold.get(blocks[i]) === fold);
    if (train.length === 0 || test.length === 0) continue;
    // Offset that zeroes the training bias.
    const offset = -residualStats(train).biasDb;
    offsets.push(offset);
    for (const sample of test) {
      beforeAbs += Math.abs(sample.predictedDbm - sample.measuredDbm);
      afterAbs += Math.abs(sample.predictedDbm + offset - sample.measuredDbm);
      count++;
    }
  }
  const beforeMae = count ? beforeAbs / count : 0;
  const afterMae = count ? afterAbs / count : 0;
  const meanOffset = offsets.length ? offsets.reduce((a, b) => a + b, 0) / offsets.length : 0;
  const helps = afterMae < beforeMae;

  return {
    offsetDb: round2(meanOffset),
    applied: helps,
    beforeMaeDb: round2(beforeMae),
    afterMaeDb: round2(afterMae),
    detail: helps
      ? `a ${round2(meanOffset)} dB global offset reduced held-out MAE from ${round2(beforeMae)} to ${round2(afterMae)} dB; this is a FITTED correction, not a physical term`
      : `a global offset did not improve held-out MAE (${round2(beforeMae)} -> ${round2(afterMae)} dB), so none is applied`,
  };
}
