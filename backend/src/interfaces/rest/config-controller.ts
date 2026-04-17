import { Router, Request, Response } from 'express';
import pino from 'pino';
import { LoadConfigUseCase } from '../../application/use-cases/load-config';
import { ValidateConfigUseCase } from '../../application/use-cases/validate-config';
import { ApplyConfigUseCase } from '../../application/use-cases/apply-config';
import { TopologyUseCase } from '../../application/use-cases/topology';
import { ServiceMonitorUseCase } from '../../application/use-cases/service-monitor';
import { SyncSDUseCase } from '../../application/use-cases/sync-sd-usecase';

export function createConfigRouter(
  loadConfigUseCase: LoadConfigUseCase,
  validateConfigUseCase: ValidateConfigUseCase,
  applyConfigUseCase: ApplyConfigUseCase,
  topologyUseCase: TopologyUseCase,
  serviceMonitorUseCase: ServiceMonitorUseCase,
  syncSDUseCase: SyncSDUseCase,
  logger: pino.Logger,
): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      logger.info('Loading all configurations');
      const configs = await loadConfigUseCase.execute();
      logger.info({ configKeys: Object.keys(configs) }, 'Configurations loaded successfully');
      res.json({ success: true, data: configs });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      logger.error({ err: msg, stack }, 'Failed to load configs');
      res.status(500).json({ success: false, error: msg });
    }
  });

  router.get('/topology/graph', async (_req: Request, res: Response) => {
    try {
      logger.info('Fetching network function data for topology');
      const configs = await loadConfigUseCase.execute();
      const statuses = serviceMonitorUseCase.getStatusCache();
      
      // Build node list with all 16 services
      const services = [
        'nrf', 'scp', 'amf', 'smf', 'upf', 'ausf', 'udm', 'udr',
        'pcf', 'nssf', 'bsf', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu'
      ];
      
      const nodes = services.map(service => {
        const config = (configs as any)[service];
        let address = '0.0.0.0';
        let port = 0;
        
        // Extract address and port from config
        if (config?.sbi?.addr) {
          address = Array.isArray(config.sbi.addr) ? config.sbi.addr[0] : config.sbi.addr;
          port = config.sbi.port || 7777;
        } else if (config?.pfcp?.addr) {
          address = config.pfcp.addr;
          port = config.pfcp.port || 8805;
        } else if (config?.gtpc?.addr) {
          address = config.gtpc.addr;
          port = config.gtpc.port || 2123;
        } else if (config?.diameter?.addr) {
          address = config.diameter.addr;
          port = config.diameter.port || 3868;
        }
        
        return {
          id: service,
          address,
          port,
          active: statuses?.[service]?.active ?? false,
        };
      });
      
      logger.info({ nodeCount: nodes.length }, 'Topology node data prepared');
      res.json({ success: true, data: { nodes, edges: [] } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Failed to get topology');
      res.status(500).json({ success: false, error: msg });
    }
  });

  router.get('/:service', async (req: Request, res: Response) => {
    const service = req.params.service;
    const validServices = [
      'nrf', 'scp', 'amf', 'smf', 'upf', 'ausf', 'udm', 'udr',
      'pcf', 'nssf', 'bsf', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu'
    ];
    if (!validServices.includes(service)) {
      logger.warn({ service, validServices }, 'Invalid service requested');
      res.status(400).json({ success: false, error: `Invalid service: ${service}` });
      return;
    }
    try {
      logger.info({ service }, 'Loading service config');
      const config = await loadConfigUseCase.executeForService(service as any);
      logger.info({ service }, 'Service config loaded');
      res.json({ success: true, data: config });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, service }, 'Failed to load service config');
      res.status(500).json({ success: false, error: msg });
    }
  });

  router.post('/validate', async (req: Request, res: Response) => {
    try {
      logger.info('Validating current configurations');
      const result = await validateConfigUseCase.validateCurrent();
      logger.info({ valid: result.valid, errorCount: result.errors.length }, 'Validation complete');
      res.json({ success: true, data: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Validation failed');
      res.status(500).json({ success: false, error: msg });
    }
  });

  router.post('/apply', async (req: Request, res: Response) => {
    try {
      logger.info('Applying configuration changes');
      const configs = req.body;
      const result = await applyConfigUseCase.execute(configs);
      logger.info({ success: result.success, rollback: result.rollback }, 'Apply complete');
      res.json({ success: true, data: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Apply failed');
      res.status(500).json({ success: false, error: msg });
    }
  });

  router.post('/sync-sd', async (req: Request, res: Response) => {
    try {
      const { sd, sst } = req.body;
      
      if (!sd || typeof sd !== 'string') {
        res.status(400).json({ success: false, error: 'SD value is required' });
        return;
      }
      
      logger.info({ sd, sst }, 'Syncing SD across SMF and subscribers');
      const result = await syncSDUseCase.execute(sd, sst);
      
      if (result.success) {
        logger.info(result.updated, 'SD sync completed successfully');
        res.json({ success: true, data: result.updated });
      } else {
        logger.error({ error: result.error }, 'SD sync failed');
        res.status(500).json({ success: false, error: result.error });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'SD sync failed with exception');
      res.status(500).json({ success: false, error: msg });
    }
  });

  return router;
}
