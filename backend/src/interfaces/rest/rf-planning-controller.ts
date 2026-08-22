import { Router, Request, Response } from 'express';
import pino from 'pino';
import {
  LinkBudgetInput, PointAnalysisInput, CoverageGridInput, InterferenceGridInput,
  calculateLinkBudget, calculatePointAnalysis, calculateCoverageGrid, calculateMultiSiteInterference,
  fsplDb, fsplEquation,
  LTE_BANDS,
} from '../../domain/rf';

// Thin REST wrapper over backend/src/domain/rf/ — pure calculation, no I/O,
// no side effects, so this needs no host-executor/audit-logger dependency
// (matches createFemtoRouter(logger)'s minimal shape). The domain layer is
// authoritative; this layer only does request/response marshalling.
export function createRfPlanningRouter(logger: pino.Logger): Router {
  const router = Router();

  router.post('/link-budget', (req: Request, res: Response) => {
    try {
      const result = calculateLinkBudget(req.body as LinkBudgetInput);
      res.json(result);
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning: link-budget failed');
      res.status(500).json({ ok: false, error: { reason: String(err), missingInputs: [] } });
    }
  });

  router.post('/point-analysis', async (req: Request, res: Response) => {
    try {
      const result = await calculatePointAnalysis(req.body as PointAnalysisInput, logger);
      res.json(result);
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning: point-analysis failed');
      res.status(500).json({ ok: false, error: { reason: String(err), missingInputs: [] } });
    }
  });

  // Thin standalone wrapper around pathloss-fspl.ts alone — useful for a
  // future caller (CLI, test harness, or an eventual engineering-assistant
  // integration) that only wants the propagation number in isolation,
  // without supplying a full radio configuration.
  router.post('/path-loss', (req: Request, res: Response) => {
    try {
      const { distanceM, frequencyMhz } = req.body as { distanceM?: number; frequencyMhz?: number };
      if (distanceM == null || frequencyMhz == null) {
        res.status(400).json({ ok: false, error: { reason: 'distanceM and frequencyMhz are both required', missingInputs: ['distanceM', 'frequencyMhz'].filter(k => (req.body as any)[k] == null) } });
        return;
      }
      const frequencyHz = frequencyMhz * 1_000_000;
      const pathLossDb = fsplDb(distanceM, frequencyHz);
      res.json({
        ok: true,
        result: { pathLossDb },
        calculation: [fsplEquation(distanceM, frequencyHz, pathLossDb)],
        assumptions: [],
        warnings: [],
        model: 'Free-Space Path Loss',
        references: [fsplEquation(distanceM, frequencyHz, pathLossDb).source],
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning: path-loss failed');
      res.status(500).json({ ok: false, error: { reason: String(err), missingInputs: [] } });
    }
  });

  router.post('/coverage-grid', async (req: Request, res: Response) => {
    try {
      const result = await calculateCoverageGrid(req.body as CoverageGridInput, logger);
      res.json(result);
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning: coverage-grid failed');
      res.status(500).json({ ok: false, error: { reason: String(err), missingInputs: [] } });
    }
  });

  router.post('/interference-grid', async (req: Request, res: Response) => {
    try {
      const result = await calculateMultiSiteInterference(req.body as InterferenceGridInput, logger);
      res.json(result);
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning: interference-grid failed');
      res.status(500).json({ ok: false, error: { reason: String(err), missingInputs: [] } });
    }
  });

  // Returns the band/EARFCN table as data, so both the frontend RF Planning
  // page and (as a future cleanup, not required for Phase 1) BaicellsAcsTab.tsx
  // can consume one canonical source instead of hand-duplicating the math.
  router.get('/lte-bands', (_req: Request, res: Response) => {
    res.json({ success: true, bands: LTE_BANDS });
  });

  return router;
}
