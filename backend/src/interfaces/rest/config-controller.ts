import { Router, Request, Response } from 'express';
import pino from 'pino';
import { LoadConfigUseCase } from '../../application/use-cases/load-config';
import { ValidateConfigUseCase } from '../../application/use-cases/validate-config';
import { ApplyConfigUseCase } from '../../application/use-cases/apply-config';
import { TopologyUseCase } from '../../application/use-cases/topology';
import { ServiceMonitorUseCase } from '../../application/use-cases/service-monitor';
import { SyncSDUseCase } from '../../application/use-cases/sync-sd-usecase';
import { requireAdmin } from './middleware/auth-middleware';
import { MmeMobilitySupportUseCase } from '../../application/use-cases/mme-mobility-support';

/**
 * An endpoint as it appears in a parsed Open5GS config document:
 * `{ server: [{ address, port }] }`.
 */
interface YamlServerList {
  server?: Array<{ address?: string | string[]; port?: number }>;
}

/** First configured address of an endpoint, or undefined if it has none. */
function endpointOf(
  endpoint: YamlServerList | undefined,
  defaultPort: number,
): { address: string; port: number } | undefined {
  const first = endpoint?.server?.[0];
  const addr = first?.address;
  const address = Array.isArray(addr) ? addr[0] : addr;
  if (address === undefined || address === '') return undefined;
  return { address, port: first?.port ?? defaultPort };
}

/** First candidate that is actually configured. */
function firstEndpoint(
  ...candidates: Array<{ address: string; port: number } | undefined>
): { address: string; port: number } {
  return candidates.find(candidate => candidate !== undefined) ?? { address: '0.0.0.0', port: 0 };
}

export function createConfigRouter(
  loadConfigUseCase: LoadConfigUseCase,
  validateConfigUseCase: ValidateConfigUseCase,
  applyConfigUseCase: ApplyConfigUseCase,
  topologyUseCase: TopologyUseCase,
  serviceMonitorUseCase: ServiceMonitorUseCase,
  syncSDUseCase: SyncSDUseCase,
  logger: pino.Logger,
  mobilitySupport?: MmeMobilitySupportUseCase,
): Router {
  const router = Router();

  // Not an `async` handler: express ignores the promise one returns
  // (@typescript-eslint/no-misused-promises), so a rejection escaping it is an
  // unhandled rejection and the request simply never answers. The inner task
  // therefore owns its own try/catch and always sends exactly one response.
  // MmeMobilitySupportUseCase.execute() already resolves to 'unknown' rather
  // than throwing on a host failure, so this catch is the backstop, not the
  // expected path.
  router.get('/mme/mobility-support', (_req: Request, res: Response) => {
    if (!mobilitySupport) {
      res.status(503).json({ success: false, error: 'MME compatibility detection is unavailable' });
      return;
    }
    void (async (): Promise<void> => {
      try {
        res.json({ success: true, data: await mobilitySupport.execute() });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg }, 'Failed to check inter-MME mobility support');
        res.status(500).json({ success: false, error: msg });
      }
    })();
  });

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

      // For MongoDB: do a live check rather than relying on cache
      // This ensures Docker-hosted MongoDB shows green immediately
      let mongoActive = statuses?.['mongodb']?.active ?? false;
      try {
        const mongoStatus = await serviceMonitorUseCase.getMongoStatus();
        mongoActive = mongoStatus.active;
      } catch {
        // Fall back to cached value
      }
      
      // Build node list — all 17 NFs plus mongodb.
      //
      // `configs` is the WIRE payload: each entry is the whole parsed YAML
      // document, so an NF's endpoints sit one level down under the NF's own
      // key (`configs.amf.amf.sbi`), and an endpoint is `server: [{ address }]`
      // rather than a flat `addr`. This block previously did
      // `(configs as any)[service]` and then read `config.sbi.addr` /
      // `config.pfcp.addr` / `config.gtpc.addr` / `config.diameter.addr` —
      // entity-shaped field names that do not exist on a document at all, and
      // a `diameter` field that exists nowhere in this codebase. Every branch
      // therefore missed and EVERY node reported 0.0.0.0:0, confirmed against
      // the live endpoint on 2026-11-26. Not user-visible: TopologyPage.tsx
      // reads only `active` from these nodes.
      //
      // sepp1's document key is `sepp`, not `sepp1`. HSS and PCRF genuinely
      // declare no service endpoint (their Diameter address lives in the
      // freeDiameter .conf the file points at), so `metrics` is the only
      // address either one has, and its port is the metrics port.
      const nrf = configs.nrf?.nrf;
      const scp = configs.scp?.scp;
      const amf = configs.amf?.amf;
      const smf = configs.smf?.smf;
      const upf = configs.upf?.upf;
      const ausf = configs.ausf?.ausf;
      const udm = configs.udm?.udm;
      const udr = configs.udr?.udr;
      const pcf = configs.pcf?.pcf;
      const nssf = configs.nssf?.nssf;
      const bsf = configs.bsf?.bsf;
      const sepp = configs.sepp1?.sepp;
      const mme = configs.mme?.mme;
      const hss = configs.hss?.hss;
      const pcrf = configs.pcrf?.pcrf;
      const sgwc = configs.sgwc?.sgwc;
      const sgwu = configs.sgwu?.sgwu;

      const SBI = 7777, PFCP = 8805, GTPC = 2123, GTPU = 2152, NGAP = 38412, S1AP = 36412;

      const endpoints: Array<[string, { address: string; port: number }]> = [
        ['nrf', firstEndpoint(endpointOf(nrf?.sbi, SBI))],
        ['scp', firstEndpoint(endpointOf(scp?.sbi, SBI))],
        ['amf', firstEndpoint(endpointOf(amf?.sbi, SBI), endpointOf(amf?.ngap, NGAP))],
        ['smf', firstEndpoint(endpointOf(smf?.sbi, SBI), endpointOf(smf?.pfcp, PFCP), endpointOf(smf?.gtpc, GTPC))],
        ['upf', firstEndpoint(endpointOf(upf?.pfcp, PFCP), endpointOf(upf?.gtpu, GTPU))],
        ['ausf', firstEndpoint(endpointOf(ausf?.sbi, SBI))],
        ['udm', firstEndpoint(endpointOf(udm?.sbi, SBI))],
        ['udr', firstEndpoint(endpointOf(udr?.sbi, SBI))],
        ['pcf', firstEndpoint(endpointOf(pcf?.sbi, SBI))],
        ['nssf', firstEndpoint(endpointOf(nssf?.sbi, SBI))],
        ['bsf', firstEndpoint(endpointOf(bsf?.sbi, SBI))],
        ['sepp1', firstEndpoint(endpointOf(sepp?.sbi, SBI))],
        ['mme', firstEndpoint(endpointOf(mme?.s1ap, S1AP), endpointOf(mme?.gtpc, GTPC))],
        ['hss', firstEndpoint(endpointOf(hss?.metrics, 9090))],
        ['pcrf', firstEndpoint(endpointOf(pcrf?.metrics, 9090))],
        ['sgwc', firstEndpoint(endpointOf(sgwc?.pfcp, PFCP), endpointOf(sgwc?.gtpc, GTPC))],
        ['sgwu', firstEndpoint(endpointOf(sgwu?.pfcp, PFCP), endpointOf(sgwu?.gtpu, GTPU))],
        ['mongodb', firstEndpoint()],
      ];

      const nodes = endpoints.map(([service, { address, port }]) => ({
        id: service,
        address,
        port,
        // Use live MongoDB status for mongodb, cache for everything else
        active: service === 'mongodb' ? mongoActive : (statuses?.[service]?.active ?? false),
        source: service === 'mongodb' ? (statuses?.['mongodb']?.source || 'direct') : undefined,
      }));
      
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
      'pcf', 'nssf', 'bsf', 'sepp1', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu'
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

  router.post('/validate', requireAdmin, async (req: Request, res: Response) => {
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

  router.post('/apply', requireAdmin, async (req: Request, res: Response) => {
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

  router.post('/sync-sd', requireAdmin, async (req: Request, res: Response) => {
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
