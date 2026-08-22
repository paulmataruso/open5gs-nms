// Field-survey calibration: a simple, explainable mean-offset correction,
// not an opaque model fit. Given real measured signal readings tagged with
// lat/lon, computes offsetDb = mean(measured − predicted) across every
// survey point for a site — an honest summary of how far off this engine's
// prediction runs for THIS specific deployment, not a re-fit of the
// underlying propagation model's own parameters (that would be a much
// harder statistical problem this feature deliberately doesn't attempt).

import pino from 'pino';
import { computeSiteSignalAtPoint, ResolvedSiteParams } from './site-signal';

export interface SurveyPoint {
  lat: number;
  lon: number;
  measuredDbm: number;
  timestamp?: string;
}

export interface CalibrationPointResult extends SurveyPoint {
  predictedDbm: number;
  errorDb: number; // measured - predicted
}

export interface CalibrationResult {
  offsetDb: number;
  pointCount: number;
  skippedCount: number;
  meanAbsErrorDb: number;
  points: CalibrationPointResult[];
}

export async function calculateCalibrationOffset(
  surveyPoints: SurveyPoint[], siteParams: ResolvedSiteParams, logger?: pino.Logger,
): Promise<CalibrationResult | null> {
  if (surveyPoints.length === 0) return null;

  const points: CalibrationPointResult[] = [];
  let skippedCount = 0;
  for (const sp of surveyPoints) {
    const signal = await computeSiteSignalAtPoint(siteParams, sp.lat, sp.lon, logger);
    if (!signal) { skippedCount++; continue; } // out of the base model's valid range at this point
    points.push({ ...sp, predictedDbm: signal.totalReceivedPowerDbm, errorDb: sp.measuredDbm - signal.totalReceivedPowerDbm });
  }
  if (points.length === 0) return null;

  const offsetDb = points.reduce((s, p) => s + p.errorDb, 0) / points.length;
  const meanAbsErrorDb = points.reduce((s, p) => s + Math.abs(p.errorDb), 0) / points.length;

  return { offsetDb, pointCount: points.length, skippedCount, meanAbsErrorDb, points };
}
