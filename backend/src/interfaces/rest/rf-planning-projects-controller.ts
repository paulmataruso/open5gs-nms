import { Router, Request, Response } from 'express';
import pino from 'pino';
import { randomUUID } from 'crypto';
import { IRfPlanningProjectRepository } from '../../domain/interfaces/rf-planning-project-repository';
import { RfPlanningProject, RfPlanningSite, RfPlanningSurveyPoint } from '../../domain/entities/rf-planning-project';
import {
  calculateCoverageGrid, CoverageGridInput, LatLon,
  calculateMultiSiteInterference, InterferenceGridInput,
  calculateCalibrationOffset, resolveSite, Assumption,
} from '../../domain/rf';

// Whole-document replace on PUT (no granular per-site sub-endpoints) — this
// project's simplest-shape-that-works convention, since unlike GenieACS
// there's no session-limit fragility here forcing a diffing save.
export function createRfPlanningProjectsRouter(repo: IRfPlanningProjectRepository, logger: pino.Logger): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const projects = await repo.findAll();
      res.json({ success: true, projects });
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning-projects: list failed');
      res.status(500).json({ success: false, error: 'Failed to list projects' });
    }
  });

  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const project = await repo.findById(req.params.id);
      if (!project) { res.status(404).json({ success: false, error: 'Project not found' }); return; }
      res.json({ success: true, project });
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning-projects: get failed');
      res.status(500).json({ success: false, error: 'Failed to load project' });
    }
  });

  router.post('/', async (req: Request, res: Response) => {
    try {
      const body = req.body as { name?: string; description?: string };
      if (!body.name) { res.status(400).json({ success: false, error: 'name is required' }); return; }
      const now = new Date().toISOString();
      const project: RfPlanningProject = {
        id: randomUUID(), name: body.name, description: body.description,
        createdAt: now, updatedAt: now, sites: [],
      };
      await repo.create(project);
      res.status(201).json({ success: true, project });
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning-projects: create failed');
      res.status(500).json({ success: false, error: 'Failed to create project' });
    }
  });

  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const existing = await repo.findById(req.params.id);
      if (!existing) { res.status(404).json({ success: false, error: 'Project not found' }); return; }

      const body = req.body as Partial<RfPlanningProject>;
      const sites: RfPlanningSite[] | undefined = body.sites?.map(s => ({ ...s, id: s.id || randomUUID() }));

      const update: Partial<RfPlanningProject> = { ...body, updatedAt: new Date().toISOString() };
      if (sites) update.sites = sites;
      delete (update as Partial<Record<'id' | 'createdAt', unknown>>).id;
      delete (update as Partial<Record<'id' | 'createdAt', unknown>>).createdAt;

      await repo.update(req.params.id, update);
      const project = await repo.findById(req.params.id);
      res.json({ success: true, project });
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning-projects: update failed');
      res.status(500).json({ success: false, error: 'Failed to update project' });
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      await repo.delete(req.params.id);
      res.json({ success: true });
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning-projects: delete failed');
      res.status(500).json({ success: false, error: 'Failed to delete project' });
    }
  });

  // "Reverse planning," scoped honestly: not an automatic solver — for
  // every site already saved in this project, reuses the coverage-grid
  // engine's own coverageRequirement solve against the SAME drawn target
  // polygon, so an operator gets a side-by-side "here's the TX power each
  // candidate site would need" comparison built entirely from already-
  // verified math, not a new optimizer.
  router.post('/:id/compare-sites', async (req: Request, res: Response) => {
    try {
      const project = await repo.findById(req.params.id);
      if (!project) { res.status(404).json({ success: false, error: 'Project not found' }); return; }

      const body = req.body as { targetPolygon?: LatLon[]; minAcceptableSignalDbm?: number; radiusM?: number; resolution?: number };
      const targetPolygon = body.targetPolygon ?? project.targetPolygon;
      const minAcceptableSignalDbm = body.minAcceptableSignalDbm ?? project.minAcceptableSignalDbm;
      if (!targetPolygon || targetPolygon.length < 3 || minAcceptableSignalDbm == null) {
        res.status(400).json({ success: false, error: 'targetPolygon (>=3 points) and minAcceptableSignalDbm are required (either in the request body or already saved on the project)' });
        return;
      }
      if (project.sites.length === 0) {
        res.status(400).json({ success: false, error: 'This project has no saved sites to compare' });
        return;
      }

      const results = await Promise.all(project.sites.map(async site => {
        const input: CoverageGridInput = {
          ...site,
          radiusM: body.radiusM ?? 5000,
          resolution: body.resolution ?? 40,
          targetPolygon,
          minAcceptableSignalDbm,
        };
        const result = await calculateCoverageGrid(input, logger);
        return {
          siteId: site.id,
          siteName: site.name,
          ok: result.ok,
          coverageRequirement: result.ok ? result.result?.coverageRequirement : undefined,
          warnings: result.warnings,
          error: result.ok ? undefined : result.error,
        };
      }));

      res.json({ success: true, results });
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning-projects: compare-sites failed');
      res.status(500).json({ success: false, error: 'Failed to compare sites' });
    }
  });

  // Multi-sector interference/SINR over every site saved in this project —
  // deliberately works over saved sites, not a live pull from registered
  // radios (see interference.ts's own header comment for why).
  router.post('/:id/interference', async (req: Request, res: Response) => {
    try {
      const project = await repo.findById(req.params.id);
      if (!project) { res.status(404).json({ success: false, error: 'Project not found' }); return; }
      if (project.sites.length === 0) { res.status(400).json({ success: false, error: 'This project has no saved sites' }); return; }

      const body = req.body as { centerLat?: number; centerLon?: number; radiusM?: number; resolution?: number; bandwidthHz?: number; noiseFigureDb?: number; temperatureK?: number };
      const centerLat = body.centerLat ?? project.sites.reduce((s, x) => s + x.siteLat, 0) / project.sites.length;
      const centerLon = body.centerLon ?? project.sites.reduce((s, x) => s + x.siteLon, 0) / project.sites.length;

      const input: InterferenceGridInput = {
        sites: project.sites,
        centerLat, centerLon,
        radiusM: body.radiusM ?? 5000,
        resolution: body.resolution ?? 40,
        bandwidthHz: body.bandwidthHz ?? 20_000_000,
        noiseFigureDb: body.noiseFigureDb,
        temperatureK: body.temperatureK,
      };
      const result = await calculateMultiSiteInterference(input, logger);
      res.json(result);
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning-projects: interference failed');
      res.status(500).json({ success: false, error: 'Failed to compute interference grid' });
    }
  });

  // Field-survey calibration — add a real measured reading to a site.
  router.post('/:id/sites/:siteId/survey-points', async (req: Request, res: Response) => {
    try {
      const project = await repo.findById(req.params.id);
      if (!project) { res.status(404).json({ success: false, error: 'Project not found' }); return; }
      const site = project.sites.find(s => s.id === req.params.siteId);
      if (!site) { res.status(404).json({ success: false, error: 'Site not found' }); return; }

      const body = req.body as { lat?: number; lon?: number; measuredDbm?: number; timestamp?: string };
      if (body.lat == null || body.lon == null || body.measuredDbm == null) {
        res.status(400).json({ success: false, error: 'lat, lon, and measuredDbm are required' });
        return;
      }
      const point: RfPlanningSurveyPoint = { lat: body.lat, lon: body.lon, measuredDbm: body.measuredDbm, timestamp: body.timestamp ?? new Date().toISOString() };
      const sites = project.sites.map(s => (s.id === site.id ? { ...s, surveyPoints: [...(s.surveyPoints ?? []), point] } : s));
      await repo.update(project.id, { sites, updatedAt: new Date().toISOString() });
      const updated = await repo.findById(project.id);
      res.json({ success: true, project: updated });
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning-projects: add survey point failed');
      res.status(500).json({ success: false, error: 'Failed to add survey point' });
    }
  });

  router.delete('/:id/sites/:siteId/survey-points/:index', async (req: Request, res: Response) => {
    try {
      const project = await repo.findById(req.params.id);
      if (!project) { res.status(404).json({ success: false, error: 'Project not found' }); return; }
      const site = project.sites.find(s => s.id === req.params.siteId);
      if (!site) { res.status(404).json({ success: false, error: 'Site not found' }); return; }
      const index = Number(req.params.index);
      const remaining = (site.surveyPoints ?? []).filter((_, i) => i !== index);
      const sites = project.sites.map(s => (s.id === site.id ? { ...s, surveyPoints: remaining } : s));
      await repo.update(project.id, { sites, updatedAt: new Date().toISOString() });
      const updated = await repo.findById(project.id);
      res.json({ success: true, project: updated });
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning-projects: remove survey point failed');
      res.status(500).json({ success: false, error: 'Failed to remove survey point' });
    }
  });

  // Computed fresh every time from the site's current config + its
  // persisted survey points — never cached, so it can't go stale if the
  // site's config changes after survey points were recorded.
  router.get('/:id/sites/:siteId/calibration', async (req: Request, res: Response) => {
    try {
      const project = await repo.findById(req.params.id);
      if (!project) { res.status(404).json({ success: false, error: 'Project not found' }); return; }
      const site = project.sites.find(s => s.id === req.params.siteId);
      if (!site) { res.status(404).json({ success: false, error: 'Site not found' }); return; }

      const assumptions: Assumption[] = [];
      const resolved = resolveSite(site, assumptions);
      if ('error' in resolved) { res.status(400).json({ success: false, error: resolved.error }); return; }

      const result = await calculateCalibrationOffset(site.surveyPoints ?? [], resolved.params, logger);
      res.json({ success: true, result, assumptions });
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning-projects: calibration failed');
      res.status(500).json({ success: false, error: 'Failed to compute calibration' });
    }
  });

  return router;
}
