import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { WebSocketServer } from 'ws';
import pino from 'pino';
import { loadAppConfig } from './config';
import { LocalHostExecutor } from './infrastructure/system/local-host-executor';
import { YamlConfigRepository } from './infrastructure/yaml/yaml-config-repository';
import { MongoSubscriberRepository } from './infrastructure/mongodb/mongo-subscriber-repository';
import { FileAuditLogger } from './infrastructure/logging/file-audit-logger';
import { WssBroadcaster } from './infrastructure/websocket/wss-broadcaster';
import { LoadConfigUseCase } from './application/use-cases/load-config';
import { ConfigMapper } from './application/use-cases/config-mapper';
import { ValidateConfigUseCase } from './application/use-cases/validate-config';
import { ApplyConfigUseCase } from './application/use-cases/apply-config';
import { buildMmeDupReleaseAccessBearersPatchScript } from './application/use-cases/mme-dup-release-access-bearers-patch';
import { ServiceMonitorUseCase } from './application/use-cases/service-monitor';
import { SubscriberManagementUseCase } from './application/use-cases/subscriber-management';
import { TopologyUseCase } from './application/use-cases/topology';
import { BackupRestoreUseCase } from './application/use-cases/backup-restore';
import { DnsMigrationUseCase } from './application/use-cases/dns-migration-usecase';
import { PlmnMigrationUseCase } from './application/use-cases/plmn-migration-usecase';
import { PcapUseCase } from './application/use-cases/pcap';
import { RestoreDefaultsUseCase } from './application/use-cases/restore-defaults';
import { AutoConfigUseCase } from './application/use-cases/auto-config';
import { LogStreamingUseCase } from './application/use-cases/log-streaming';
import { DockerLogStreamingUseCase } from './application/use-cases/docker-log-streaming';
import { DockerLogExecutor } from './infrastructure/docker/docker-log-executor';
import { LogStreamHandler } from './infrastructure/websocket/log-stream-handler';
import { SqliteAuthRepository, createLucia } from './infrastructure/auth/sqlite-auth-repository';
import { seedAdminUser } from './infrastructure/auth/seed-admin';
import { AuthLoginUseCase } from './application/use-cases/auth-login';
import { AuthLogoutUseCase } from './application/use-cases/auth-logout';
import { createAuthRouter } from './interfaces/rest/auth-controller';
import { createAuthMiddleware, requireAdmin } from './interfaces/rest/middleware/auth-middleware';
import { UserManagementUseCase } from './application/use-cases/user-management';
import { createUsersRouter } from './interfaces/rest/users-controller';
import { createConfigRouter } from './interfaces/rest/config-controller';
import { createSeppRouter } from './interfaces/rest/sepp-controller';
import { createBackupRouter } from './interfaces/rest/backup-controller';
import { createDnsMigrationRouter } from './interfaces/rest/dns-migration-controller';
import { createPlmnMigrationRouter } from './interfaces/rest/plmn-migration-controller';
import { createPcapRouter } from './interfaces/rest/pcap-controller';
import { EsimGeneratorUseCase } from './application/use-cases/esim-generator';
import { createEsimRouter } from './interfaces/rest/esim-controller';
import { createFemtoRouter } from './interfaces/rest/femto-controller';
import { createRfPlanningRouter } from './interfaces/rest/rf-planning-controller';
import { createRfPlanningProjectsRouter } from './interfaces/rest/rf-planning-projects-controller';
import { createApnProfileRouter } from './interfaces/rest/apn-profile-controller';
import { createRfPlanningReportsRouter } from './interfaces/rest/rf-planning-reports-controller';
import { MongoRfPlanningProjectRepository } from './infrastructure/mongodb/mongo-rf-project-repository';
import { MongoApnProfileRepository } from './infrastructure/mongodb/mongo-apn-profile-repository';
import { ApnProfileUseCase } from './application/use-cases/apn-profile-usecase';
import { createAutoConfigRouter } from './interfaces/rest/auto-config-controller';
import { createServiceRouter } from './interfaces/rest/service-controller';
import { createSubscriberRouter } from './interfaces/rest/subscriber-controller';
import { createAuditRouter } from './interfaces/rest/audit-controller';
import { createTunRouter } from './interfaces/rest/tun-controller';
import { TunManagementUseCase } from './application/use-cases/tun-management';
import { createInterfaceRouter } from './interfaces/rest/interface-controller';
import { GtpBandwidthMonitor } from './application/use-cases/interface-status/gtp-bandwidth';
import { ImsCallStatsMonitor } from './application/use-cases/ims/call-stats-monitor';
import { IpsecSaCleanup } from './application/use-cases/ims/ipsec-sa-cleanup';
import { ActiveSessionsUseCase } from './application/use-cases/active-sessions';
import { SuciManagementUseCase } from './application/use-cases/suci-management';
import { SyncSDUseCase } from './application/use-cases/sync-sd-usecase';
import { AutoAssignIPsUseCase } from './application/use-cases/auto-assign-ips-usecase';
import { SyncPrometheusConfigUseCase } from './application/use-cases/sync-prometheus-config';
import { SyncGenieacsProvisionsUseCase } from './application/use-cases/sync-genieacs-provisions';
import { createSuciRouter } from './interfaces/rest/suci-controller';
import { createDockerRouter } from './interfaces/rest/docker-controller';
import { SqliteRadioTagRepository } from './infrastructure/auth/sqlite-radio-tag-repository';
import { createRadioTagsRouter } from './interfaces/rest/radio-tags-controller';
import { createLogDownloadRouter } from './interfaces/rest/log-download-controller';
import { createGenieacsRouter } from './interfaces/rest/genieacs-controller';
import { createChronyRouter } from './interfaces/rest/chrony-controller';
import { createSyslogRouter } from './interfaces/rest/syslog-controller';
import { createSpeedtestRouter } from './interfaces/rest/speedtest-controller';
import { createFrrRouter } from './interfaces/rest/frr-controller';
import { createFrrSourceBuildRouter } from './interfaces/rest/frr-source-build-controller';
import { createSmsRouter } from './interfaces/rest/sms-controller';
import { createMmsRouter, MmsMsisdnMapRefresher } from './interfaces/rest/mms-controller';
import { createVectorcoreSmscRouter } from './interfaces/rest/vectorcore-smsc-controller';
import { createImsRouter } from './interfaces/rest/ims-controller';
import { createVowifiRouter } from './interfaces/rest/vowifi-controller';
import { createSecgwRouter } from './interfaces/rest/secgw-controller';
import { createSwuEmulatorRouter } from './interfaces/rest/swu-emulator-controller';
import { createPstnRouter } from './interfaces/rest/pstn-controller';
import { createBindRouter } from './interfaces/rest/bind-controller';
import { createValidationRouter } from './interfaces/rest/validation-controller';
import { createVolteValidationRouter } from './interfaces/rest/volte-validation-controller';
import { ImsTestNumberManager, createImsTestNumberRouter } from './interfaces/rest/ims-test-number-controller';
import { createVowifiValidationRouter } from './interfaces/rest/vowifi-validation-controller';
import * as http from 'http';
import { spawn } from 'child_process';
import { SasService } from './domain/sas/sas-service';
import { createSasProtocolRouter, createSasAdminRouter } from './interfaces/rest/sas-controller';
import { createSercommNRRouter } from './interfaces/rest/sercomm-nr-controller';
import { createSubscriberGroupsRouter } from './interfaces/rest/subscriber-groups-controller';
import { SubscriberIpAccounting } from './application/use-cases/traffic-history/subscriber-ip-accounting';
import { createTrafficMetricsRegistry } from './application/use-cases/traffic-history/prometheus-metrics';
import { createTrafficHistoryRouter } from './interfaces/rest/traffic-history-controller';
import * as promClient from 'prom-client';
import { TwampMonitor } from './application/use-cases/twamp/twamp-monitor';
import { createTwampMetricsRegistry } from './application/use-cases/twamp/twamp-metrics';
import { createTwampRouter } from './interfaces/rest/twamp-controller';
import { createModulesRouter } from './interfaces/rest/modules-controller';
import { ModuleFixAllUseCase } from './application/use-cases/module-fixall-usecase';
import { createRadioSignalRouter } from './interfaces/rest/radio-signal-controller';

async function main() {
  // Load configuration
  const config = loadAppConfig();

  // Initialize logger
  const logger = pino({
    level: config.logLevel,
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          },
  });

  logger.info({ config }, 'Starting Open5GS NMS Backend');

  // Initialize infrastructure components
  const hostExecutor = new LocalHostExecutor(logger, config.systemctlPath);
  const configRepo = new YamlConfigRepository(hostExecutor, config.configPath, logger);
  const subscriberRepo = new MongoSubscriberRepository(config.mongodbUri, logger);
  const rfPlanningProjectRepo = new MongoRfPlanningProjectRepository(config.mongodbUri, logger);
  const apnProfileRepo = new MongoApnProfileRepository(config.mongodbUri, logger);
  const auditLogger = new FileAuditLogger(config.logDir, logger);

  // Initialize audit logger
  await auditLogger.initialize();
  logger.info('Audit logger initialized');

  // Connect to MongoDB
  await subscriberRepo.connect();
  await rfPlanningProjectRepo.connect();
  await apnProfileRepo.connect();
  logger.info('MongoDB connected');

  const apnProfileUseCase = new ApnProfileUseCase(apnProfileRepo, configRepo, logger);

  // ── Traffic History ──
  // Per-subscriber nftables byte counters + a Prometheus exporter — storage,
  // retention, and rate computation are all owned by the Prometheus instance
  // already running in this stack (see prometheus-metrics.ts header comment).
  const subscriberIpAccounting = new SubscriberIpAccounting(hostExecutor, subscriberRepo, logger);
  subscriberIpAccounting.start();

  // Keeps the MM1 MSISDN header-injection proxy's UE-IP -> MSISDN map fresh
  // (see mms-controller.ts) so a new subscriber or a reassigned Framed Route
  // IP doesn't require a manual MMS Configure re-run.
  const mmsMsisdnMapRefresher = new MmsMsisdnMapRefresher(subscriberRepo, logger);
  mmsMsisdnMapRefresher.start();
  const trafficMetricsGtpMonitor = new GtpBandwidthMonitor(hostExecutor, configRepo, logger);
  const trafficMetricsRegistry = createTrafficMetricsRegistry(trafficMetricsGtpMonitor, subscriberIpAccounting);

  // TWAMP reflector testing (Nokia radios + any other configured target) —
  // background poller caches the latest result per target; both the
  // Prometheus exporter and GET /api/twamp/targets read from it.
  const twampMonitor = new TwampMonitor(subscriberRepo.getDb(), hostExecutor, logger);
  const twampMetricsRegistry = createTwampMetricsRegistry(twampMonitor, hostExecutor);

  // ── IMS call stats ──
  // Background sampler for the Dashboard's IMS Status card — live active-call
  // count plus a durable cumulative "total calls placed" counter (S-CSCF's own
  // dialog_ng:processed stat resets on every kamailio-scscf restart, which
  // happens often; see call-stats-monitor.ts header for the accumulation scheme).
  const imsCallStatsMonitor = new ImsCallStatsMonitor(hostExecutor, logger);
  imsCallStatsMonitor.start();

  // Workaround for a real bug in ims_ipsec_pcscf (kamailio-ims-modules,
  // third-party, not part of this repo): its own stale-SA cleanup
  // (delete_unused_sa()) never actually finds anything to delete, so a
  // UE's old IPsec SA quadruplet survives every re-registration and piles
  // up without bound — see ipsec-sa-cleanup.ts header for the full
  // investigation. Runs unconditionally like the other pollers above;
  // it's a safe no-op on any host where IMS isn't configured.
  const ipsecSaCleanup = new IpsecSaCleanup(hostExecutor, logger);
  ipsecSaCleanup.start();

  // ── SAS service ──
  // Create a child logger tagged with module:'sas' so the log stream can filter SAS-only messages
  const sasLogger = logger.child({ module: 'sas' });
  const sasService = new SasService(config.mongodbUri, sasLogger);
  await sasService.initialize();
  sasService.startGrantKeeper(200_000);
  sasService.startSummaryLogger(30_000);
  logger.info('SAS grant keeper and summary logger started');

  // ── Auth setup ──
  const authRepo = new SqliteAuthRepository(config.authDbPath, logger);
  await seedAdminUser(authRepo, config.firstRunPassword, logger);
  const lucia = createLucia(authRepo.getLuciaAdapter(), config.sessionMaxAge, config.cookieSecure);
  const authLoginUseCase = new AuthLoginUseCase(authRepo, lucia, logger);
  const authLogoutUseCase = new AuthLogoutUseCase(lucia, logger);
  const userManagementUseCase = new UserManagementUseCase(authRepo, lucia, logger);
  const authMiddleware = createAuthMiddleware(lucia);
  logger.info({ dbPath: config.authDbPath }, 'Auth initialised');

  const radioTagRepo = new SqliteRadioTagRepository(authRepo.getDb());

  // Ensure backup directories exist
  try {
    await hostExecutor.createDirectory(config.backupPath);
    await hostExecutor.createDirectory(config.mongoBackupPath);
    logger.info({ configBackup: config.backupPath, mongoBackup: config.mongoBackupPath }, 'Backup directories initialized');
  } catch (err) {
    logger.warn({ err: String(err) }, 'Failed to create backup directories (may already exist)');
  }

  // Initialize WebSocket server
  // noServer: true — we handle the HTTP upgrade manually so we can validate the
  // Lucia session cookie before handing the socket to the log stream handler.
  const wss = new WebSocketServer({ noServer: true });
  const wsBroadcaster = new WssBroadcaster(wss, logger);
  logger.info({ wsPort: config.wsPort }, 'WebSocket server started (session-authenticated)');

  // Initialize use cases
  const loadConfigUseCase = new LoadConfigUseCase(configRepo, auditLogger, logger);
  const validateConfigUseCase = new ValidateConfigUseCase(configRepo, logger);
  const syncPrometheusUseCase = new SyncPrometheusConfigUseCase(
    config.prometheusConfigPath,
    config.prometheusUrl,
    logger,
    config.port,
  );

  // Regenerate prometheus.yml on every startup, not just on "Apply Config".
  // Migration note: an existing install upgrading straight from a version
  // that predates Traffic History would otherwise keep whatever
  // prometheus.yml an earlier "Apply Config" run last wrote — missing the
  // open5gs-nms-backend scrape job added below — until the user happened to
  // click Apply Config again. Traffic History would silently show no data
  // until then. Syncing here removes that gap entirely.
  try {
    const currentConfigs = ConfigMapper.toAllDto(await configRepo.loadAll());
    const promSyncResult = await syncPrometheusUseCase.execute(currentConfigs);
    logger.info({ result: promSyncResult }, 'Prometheus config synced on startup');
  } catch (err) {
    logger.warn({ err: String(err) }, 'Prometheus config sync on startup failed (non-fatal)');
  }

  // Regenerate GenieACS's default/inform provisions on every startup, same
  // reasoning as the Prometheus sync above — see sync-genieacs-provisions.ts
  // for the full incident writeup (GenieACS's stock provisions assumed a
  // TR-098 data model none of this deployment's radios actually use, which
  // was perpetually faulting every Inform for all Baicells radios).
  const syncGenieacsProvisionsUseCase = new SyncGenieacsProvisionsUseCase(config.genieacsNbiUrl, logger);
  const genieacsSyncResult = await syncGenieacsProvisionsUseCase.execute();
  logger.info({ result: genieacsSyncResult }, 'GenieACS provisions synced on startup');

  const applyConfigUseCase = new ApplyConfigUseCase(
    configRepo,
    hostExecutor,
    auditLogger,
    wsBroadcaster,
    validateConfigUseCase,
    logger,
    config.backupPath,
    syncPrometheusUseCase,
  );
  // FIXED: Correct parameter order for ServiceMonitorUseCase
  // constructor(hostExecutor, wsBroadcaster, auditLogger, logger)
  const serviceMonitorUseCase = new ServiceMonitorUseCase(
    hostExecutor,
    wsBroadcaster,
    auditLogger,
    logger,
  );
  const tunUseCase = new TunManagementUseCase(hostExecutor, logger, configRepo);
  const subscriberManagementUseCase = new SubscriberManagementUseCase(
    subscriberRepo,
    auditLogger,
    logger,
    tunUseCase,
    configRepo,
    subscriberRepo.getDb(),
  );
  const topologyUseCase = new TopologyUseCase(configRepo, logger);
  const backupRestoreUseCase = new BackupRestoreUseCase(
    hostExecutor,
    configRepo,
    logger,
    config.backupPath,
    config.mongoBackupPath,
  );
  const restoreDefaultsUseCase = new RestoreDefaultsUseCase(
    hostExecutor,
    configRepo,
    auditLogger,
    logger,
    config.backupPath,
  );
  const dnsMigrationUseCase = new DnsMigrationUseCase(
    hostExecutor,
    configRepo,
    auditLogger,
    logger,
  );
  const plmnMigrationUseCase = new PlmnMigrationUseCase(
    hostExecutor,
    configRepo,
    dnsMigrationUseCase,
    auditLogger,
    logger,
  );
  const moduleFixAllUseCase = new ModuleFixAllUseCase(
    subscriberRepo,
    hostExecutor,
    config.mongodbUri,
    logger,
    auditLogger,
  );
  const pcapUseCase = new PcapUseCase(hostExecutor, configRepo, logger);
  const esimGeneratorUseCase = new EsimGeneratorUseCase(
    config.simlesslyAccessKey,
    config.simlesslySecretKey,
    logger,
  );
  const autoConfigUseCase = new AutoConfigUseCase(
    hostExecutor,
    configRepo,
    auditLogger,
    logger,
    config.backupPath,
  );
  const logStreamingUseCase = new LogStreamingUseCase(hostExecutor, logger);
  const dockerLogExecutor = new DockerLogExecutor(logger);
  const dockerLogStreamingUseCase = new DockerLogStreamingUseCase(dockerLogExecutor, logger);
  const activeSessionsUseCase = new ActiveSessionsUseCase(
    hostExecutor,
    configRepo,
    subscriberRepo,
    logger,
  );
  const suciManagementUseCase = new SuciManagementUseCase(
    hostExecutor,
    configRepo,
    logger,
  );
  const syncSDUseCase = new SyncSDUseCase(
    configRepo,
    subscriberRepo,
    logger,
  );
  const autoAssignIPsUseCase = new AutoAssignIPsUseCase(
    subscriberRepo,
    configRepo,
    logger,
    apnProfileRepo,
  );

  // Initialize log streaming WebSocket handler
  const logStreamHandler = new LogStreamHandler(
    logStreamingUseCase,
    dockerLogStreamingUseCase,
    logger,
  );
  // The wss itself handles connections — the authenticated upgrade
  // is wired onto the HTTP server after app.listen() below.
  logger.info('Log streaming handler initialized');

  // Start service monitoring
  serviceMonitorUseCase.startPolling(5000);
  logger.info('Service monitoring started');

  // Create Express app
  const app = express();

  // Trust the nginx reverse proxy — required for express-rate-limit to
  // correctly identify client IPs from X-Forwarded-For headers
  app.set('trust proxy', 1);

  // Middleware
  app.use(helmet());
  app.use(cors());
  app.use(compression());
  app.use(express.json({ limit: '10mb' }));

  // Health check (public — no auth)
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      wsConnections: wsBroadcaster.getConnectionCount(),
    });
  });

  // Traffic History Prometheus exporter (public, unauthenticated — scraped
  // directly by the host-networked Prometheus container, same trust model as
  // each NF's own :9090/metrics endpoint). Deliberately outside /api so it's
  // never caught by the auth middleware below.
  app.get('/metrics', async (_req, res) => {
    try {
      const merged = promClient.Registry.merge([trafficMetricsRegistry, twampMetricsRegistry]);
      res.set('Content-Type', merged.contentType);
      res.send(await merged.metrics());
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to render /metrics');
      res.status(500).send('');
    }
  });

  // Auth routes (public — login endpoint must be reachable before auth)
  app.use('/api/auth', createAuthRouter(authLoginUseCase, authLogoutUseCase, logger, authMiddleware));

  // ── Auth middleware ── all routes below this line are protected
  app.use('/api', authMiddleware);

  // API Routes — GET routes open to all authenticated users
  // requireAdmin middleware applied before routers that have write operations
  app.use('/api/users', createUsersRouter(userManagementUseCase, logger));
  app.use('/api/config', createConfigRouter(loadConfigUseCase, validateConfigUseCase, applyConfigUseCase, topologyUseCase, serviceMonitorUseCase, syncSDUseCase, logger));
  app.use('/api/sepp', createSeppRouter(hostExecutor, auditLogger, logger));
  app.use('/api/services', createServiceRouter(serviceMonitorUseCase, logger));
  app.use('/api/subscribers', createSubscriberRouter(subscriberManagementUseCase, autoAssignIPsUseCase, logger));
  app.use('/api/audit', createAuditRouter(auditLogger, logger));
  app.use('/api/backup', createBackupRouter(backupRestoreUseCase, restoreDefaultsUseCase, logger));
  app.use('/api/dns-migration', createDnsMigrationRouter(dnsMigrationUseCase));
  app.use('/api/plmn-migration', createPlmnMigrationRouter(plmnMigrationUseCase));
  app.use('/api/pcap', createPcapRouter(pcapUseCase, auditLogger, logger));
  app.use('/api/esim', createEsimRouter(esimGeneratorUseCase, auditLogger, logger));
  app.use('/api/femto', createFemtoRouter(logger));
  app.use('/api/rf-planning', createRfPlanningRouter(logger));
  app.use('/api/rf-planning/projects', createRfPlanningProjectsRouter(rfPlanningProjectRepo, logger));
  app.use('/api/rf-planning/projects', createRfPlanningReportsRouter(rfPlanningProjectRepo, logger));
  app.use('/api/apn-profiles', createApnProfileRouter(apnProfileUseCase, logger, auditLogger));
  app.use('/api/femto/nr', createSercommNRRouter(config.genieacsNbiUrl, logger, auditLogger, config.backupPath));
  app.use('/api/auto-config', createAutoConfigRouter(autoConfigUseCase));
  app.use('/api/tun-interfaces', createTunRouter(tunUseCase, logger));

  app.use('/api/interface-status', createInterfaceRouter(hostExecutor, logger, activeSessionsUseCase, configRepo));
  app.use('/api/suci', createSuciRouter(suciManagementUseCase, logger));
  app.use('/api/radio-tags', createRadioTagsRouter(radioTagRepo, logger));
  app.use('/api/docker', createDockerRouter(dockerLogStreamingUseCase, logger));
  app.use('/api/logs', createLogDownloadRouter(hostExecutor, config, logger));
  app.use('/api/genieacs', createGenieacsRouter(config.genieacsNbiUrl, logger, auditLogger, config.backupPath));
  app.use('/api/chrony',   createChronyRouter(logger, auditLogger));
  app.use('/api/syslog',   createSyslogRouter(logger, auditLogger));
  app.use('/api/speedtest', createSpeedtestRouter(logger, auditLogger));
  app.use('/api/frr/source-build', createFrrSourceBuildRouter(logger, auditLogger));
  app.use('/api/frr',      createFrrRouter(logger, auditLogger));
  app.use('/api/sms',        createSmsRouter(subscriberRepo, logger, auditLogger));
  app.use('/api/mms',        createMmsRouter(subscriberRepo, logger, auditLogger));
  app.use('/api/vectorcore-smsc', createVectorcoreSmscRouter(logger, auditLogger));
  app.use('/api/ims',        createImsRouter(subscriberRepo, logger, auditLogger, imsCallStatsMonitor));
  app.use('/api/vowifi',     createVowifiRouter(logger, auditLogger));
  app.use('/api/secgw',      createSecgwRouter(logger, auditLogger));
  app.use('/api/pstn',       createPstnRouter(subscriberRepo, config.mongodbUri, logger, auditLogger));
  app.use('/api/swu-emulator', createSwuEmulatorRouter(subscriberRepo, logger, auditLogger));
  app.use('/api/bind', createBindRouter(logger, auditLogger));
  app.use('/api/validation/volte', createVolteValidationRouter(logger, auditLogger));
  const imsTestNumberManager = new ImsTestNumberManager(logger);
  app.use('/api/validation/ims-test-numbers', createImsTestNumberRouter(imsTestNumberManager, auditLogger));
  await imsTestNumberManager.reconcile().catch((err) => logger.warn({ err: String(err) }, 'ims-test-number: reconcile failed at startup'));
  app.use('/api/validation/vowifi', createVowifiValidationRouter(subscriberRepo, logger, auditLogger));
  app.use('/api/validation', createValidationRouter(subscriberRepo, logger));
  app.use('/api/subscriber-groups', createSubscriberGroupsRouter(subscriberRepo.getDb(), logger));
  app.use('/api/traffic-history', createTrafficHistoryRouter(config.prometheusUrl, subscriberRepo, logger));
  app.use('/api/twamp', createTwampRouter(subscriberRepo.getDb(), hostExecutor, twampMonitor, logger, auditLogger));
  app.use('/api/modules', createModulesRouter(moduleFixAllUseCase, logger));
  app.use('/api/radio-signal', createRadioSignalRouter(authRepo.getDb(), subscriberRepo, activeSessionsUseCase, logger));

  // SAS endpoints — WinnForum CBSD protocol (unauthenticated, CBSDs connect directly)
  // IMPORTANT: contains NO admin routes — those are in createSasAdminRouter below
  app.use('/sas', createSasProtocolRouter(sasService, sasLogger));
  // SAS admin endpoints — authenticated + admin-only, mounted under /api
  app.use('/api/sas', createSasAdminRouter(sasService, sasLogger, config.genieacsNbiUrl));

  // Error handler
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      logger.error({ err }, 'Unhandled error');
      res.status(500).json({
        success: false,
        error: 'Internal server error',
      });
    },
  );

  // Start HTTP server
  const httpServer = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'HTTP server started');
  });

  // Fire-and-forget: build+install the MME duplicate-release-access-bearers
  // patch (see mme-dup-release-access-bearers-patch.ts for the full root
  // cause) on every backend startup. MME is a core, always-on NF — not an
  // optional module with its own Install button — so this is the one place
  // guaranteed to run on both a fresh install (first boot) and an existing
  // deployment (its next backend restart, already this project's standard
  // "redeploy backend" step) without requiring a manual trigger anywhere in
  // the UI. Non-blocking: never delays HTTP readiness. The script itself is
  // idempotent (marker-file short-circuit), so every startup after the
  // first is an instant no-op.
  {
    const mmePatchLogger = logger.child({ task: 'mme-dup-release-access-bearers-patch' });
    mmePatchLogger.info('Checking Open5GS MME duplicate-release-access-bearers patch');
    const child = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', '--',
      'bash', '-c', buildMmeDupReleaseAccessBearersPatchScript()], { stdio: ['ignore', 'pipe', 'pipe'] });
    const logLine = (line: string) => { if (line.trim()) mmePatchLogger.info(line.trim()); };
    let stdoutBuf = '';
    child.stdout.on('data', (d: Buffer) => {
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      lines.forEach(logLine);
    });
    let stderrBuf = '';
    child.stderr.on('data', (d: Buffer) => {
      stderrBuf += d.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() ?? '';
      lines.forEach(logLine);
    });
    child.on('close', (code) => {
      if (stdoutBuf.trim()) logLine(stdoutBuf);
      if (stderrBuf.trim()) logLine(stderrBuf);
      if (code === 0) {
        mmePatchLogger.info('MME patch check complete');
      } else {
        mmePatchLogger.warn({ exitCode: code }, 'MME patch check exited non-zero — see log lines above, will retry on next backend restart');
      }
    });
    child.on('error', (err) => {
      mmePatchLogger.warn({ err: String(err) }, 'Failed to spawn MME patch check');
    });
  }

  // SAS proxy on port 8899 — Sercomm NR radios send HTTP/1.1 without Host header,
  // which nginx 1.31 rejects before location matching. This separate server uses
  // insecureHTTPParser to accept the malformed requests and route them to the SAS handler.
  const sasProxyApp = express();
  sasProxyApp.use(express.json({ limit: '1mb' }));
  sasProxyApp.use(express.urlencoded({ extended: false }));
  sasProxyApp.use('/sas', createSasProtocolRouter(sasService, sasLogger));
  const sasProxyServer = http.createServer({ insecureHTTPParser: true } as any, sasProxyApp);
  sasProxyServer.listen(8899, '0.0.0.0', () => {
    logger.info('SAS proxy listening on 0.0.0.0:8899 (Sercomm NR Host-less HTTP/1.1 workaround)');
  });

  // ── Authenticated WebSocket upgrade ──────────────────────────────────────────
  // The WebSocket server uses noServer:true so we can validate the Lucia session
  // cookie on the HTTP upgrade request BEFORE the socket is accepted.
  // Unauthenticated upgrades are rejected with 401 and the socket is destroyed.
  httpServer.on('upgrade', async (req, socket, head) => {
    try {
      const cookieHeader = req.headers.cookie ?? '';
      const sessionId = lucia.readSessionCookie(cookieHeader);

      if (!sessionId) {
        logger.warn({ ip: req.socket.remoteAddress }, 'WS upgrade rejected: no session cookie');
        socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\nUnauthorized');
        socket.destroy();
        return;
      }

      const { session } = await lucia.validateSession(sessionId);

      if (!session) {
        logger.warn({ ip: req.socket.remoteAddress }, 'WS upgrade rejected: invalid or expired session');
        socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\nUnauthorized');
        socket.destroy();
        return;
      }

      // Session valid — hand off to the WS server
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
        logStreamHandler.handleConnection(ws);
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'WS upgrade error');
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    }
  });
  logger.info({ port: config.port }, 'Authenticated WebSocket upgrade handler registered');

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down gracefully...');
    serviceMonitorUseCase.stopPolling();
    sasService.stopGrantKeeper();
    sasService.stopSummaryLogger();
    logStreamHandler.cleanup();
    subscriberIpAccounting.stop();
    mmsMsisdnMapRefresher.stop();
    await imsTestNumberManager.stopAll();
    await subscriberRepo.disconnect();
    await rfPlanningProjectRepo.disconnect();
    await apnProfileRepo.disconnect();
    httpServer.close();
    sasProxyServer.close();
    wss.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
