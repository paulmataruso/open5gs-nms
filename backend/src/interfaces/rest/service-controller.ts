import { Router, Request, Response } from 'express';
import pino from 'pino';
import { ServiceMonitorUseCase } from '../../application/use-cases/service-monitor';
import { ServiceName } from '../../domain/entities/service-status';
import { requireAdmin } from './middleware/auth-middleware';

export function createServiceRouter(
  serviceMonitorUseCase: ServiceMonitorUseCase,
  logger: pino.Logger,
): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      logger.info('Getting all service statuses');
      const statuses = await serviceMonitorUseCase.getAll();
      logger.info({ count: statuses.length }, 'Retrieved service statuses');
      res.json({ success: true, data: statuses });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Failed to get service statuses');
      res.status(500).json({ success: false, error: msg });
    }
  });

  router.get('/:name', async (req: Request, res: Response) => {
    const name = req.params.name as ServiceName;
    const validServices: ServiceName[] = [
      'mongodb',
      'nrf', 'scp', 'amf', 'smf', 'upf', 'ausf', 'udm', 'udr',
      'pcf', 'nssf', 'bsf', 'sepp1', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu',
      'osmo-stp', 'osmo-hlr', 'osmo-msc',
    ];

    if (!validServices.includes(name)) {
      logger.warn({ name, validServices }, 'Invalid service name requested');
      res.status(400).json({ success: false, error: `Invalid service: ${name}` });
      return;
    }
    
    try {
      logger.info({ service: name }, 'Getting service status');
      const status = await serviceMonitorUseCase.getOne(name);
      res.json({ success: true, data: status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, service: name }, 'Failed to get service status');
      res.status(500).json({ success: false, error: msg });
    }
  });

  // ── Bulk action — must be registered BEFORE /:name/:action or Express
  // matches 'all' as a service name and returns 400 Invalid service.
  router.post('/all/:action', requireAdmin, async (req: Request, res: Response) => {
    const action = req.params.action as 'start' | 'stop' | 'restart';
    const validActions = ['start', 'stop', 'restart'];
    const { services: serviceFilter } = req.body as { services?: string[] };

    if (!validActions.includes(action)) {
      res.status(400).json({ success: false, error: `Invalid action: ${action}` });
      return;
    }

    try {
      logger.info({ action, serviceFilter }, 'Executing bulk service action');
      const result = await serviceMonitorUseCase.executeAllAction(action, serviceFilter);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, action }, 'Bulk action failed');
      res.status(500).json({ success: false, error: msg });
    }
  });

  router.post('/:name/:action', requireAdmin, async (req: Request, res: Response) => {
    const name = req.params.name as ServiceName;
    const action = req.params.action as 'start' | 'stop' | 'restart' | 'enable' | 'disable';
    const validServices: ServiceName[] = [
      'mongodb',
      'nrf', 'scp', 'amf', 'smf', 'upf', 'ausf', 'udm', 'udr',
      'pcf', 'nssf', 'bsf', 'sepp1', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu',
      'osmo-stp', 'osmo-hlr', 'osmo-msc',
    ];
    const validActions = ['start', 'stop', 'restart', 'enable', 'disable'];

    if (!validServices.includes(name)) {
      logger.warn({ name, validServices }, 'Invalid service name for action');
      res.status(400).json({ success: false, error: `Invalid service: ${name}` });
      return;
    }
    if (!validActions.includes(action)) {
      logger.warn({ action, validActions }, 'Invalid action');
      res.status(400).json({ success: false, error: `Invalid action: ${action}` });
      return;
    }

    try {
      logger.info({ service: name, action }, 'Executing service action');
      const result = await serviceMonitorUseCase.executeAction({ service: name, action });
      logger.info({ service: name, action, success: result.success, message: result.message }, 'Service action completed');
      res.json({ success: result.success, message: result.message });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, service: name, action }, 'Service action failed');
      res.status(500).json({ success: false, error: msg });
    }
  });

  return router;
}
