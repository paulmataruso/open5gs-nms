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
import { ValidateConfigUseCase } from './application/use-cases/validate-config';
import { ApplyConfigUseCase } from './application/use-cases/apply-config';
import { ServiceMonitorUseCase } from './application/use-cases/service-monitor';
import { SubscriberManagementUseCase } from './application/use-cases/subscriber-management';
import { TopologyUseCase } from './application/use-cases/topology';
import { BackupRestoreUseCase } from './application/use-cases/backup-restore';
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
import { createAuthMiddleware } from './interfaces/rest/middleware/auth-middleware';
import { UserManagementUseCase } from './application/use-cases/user-management';
import { createUsersRouter } from './interfaces/rest/users-controller';
import { createConfigRouter } from './interfaces/rest/config-controller';
import { createBackupRouter } from './interfaces/rest/backup-controller';
import { createFemtoRouter } from './interfaces/rest/femto-controller';
import { createAutoConfigRouter } from './interfaces/rest/auto-config-controller';
import { createServiceRouter } from './interfaces/rest/service-controller';
import { createSubscriberRouter } from './interfaces/rest/subscriber-controller';
import { createAuditRouter } from './interfaces/rest/audit-controller';
import { createInterfaceRouter } from './interfaces/rest/interface-controller';
import { ActiveSessionsUseCase } from './application/use-cases/active-sessions';
import { SuciManagementUseCase } from './application/use-cases/suci-management';
import { SyncSDUseCase } from './application/use-cases/sync-sd-usecase';
import { AutoAssignIPsUseCase } from './application/use-cases/auto-assign-ips-usecase';
import { SyncPrometheusConfigUseCase } from './application/use-cases/sync-prometheus-config';
import { createSuciRouter } from './interfaces/rest/suci-controller';
import { createDockerRouter } from './interfaces/rest/docker-controller';

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
  const auditLogger = new FileAuditLogger(config.logDir, logger);

  // Initialize audit logger
  await auditLogger.initialize();
  logger.info('Audit logger initialized');

  // Connect to MongoDB
  await subscriberRepo.connect();
  logger.info('MongoDB connected');

  // ── Auth setup ──
  const authRepo = new SqliteAuthRepository(config.authDbPath, logger);
  await seedAdminUser(authRepo, config.firstRunPassword, logger);
  const lucia = createLucia(authRepo.getLuciaAdapter(), config.sessionMaxAge, config.cookieSecure);
  const authLoginUseCase = new AuthLoginUseCase(authRepo, lucia, logger);
  const authLogoutUseCase = new AuthLogoutUseCase(lucia, logger);
  const userManagementUseCase = new UserManagementUseCase(authRepo, lucia, logger);
  const authMiddleware = createAuthMiddleware(lucia);
  logger.info({ dbPath: config.authDbPath }, 'Auth initialised');

  // Ensure backup directories exist
  try {
    await hostExecutor.createDirectory(config.backupPath);
    await hostExecutor.createDirectory(config.mongoBackupPath);
    logger.info({ configBackup: config.backupPath, mongoBackup: config.mongoBackupPath }, 'Backup directories initialized');
  } catch (err) {
    logger.warn({ err: String(err) }, 'Failed to create backup directories (may already exist)');
  }

  // Initialize WebSocket server
  const wss = new WebSocketServer({ port: config.wsPort });
  const wsBroadcaster = new WssBroadcaster(wss, logger);
  logger.info({ wsPort: config.wsPort }, 'WebSocket server started');

  // Initialize use cases
  const loadConfigUseCase = new LoadConfigUseCase(configRepo, auditLogger, logger);
  const validateConfigUseCase = new ValidateConfigUseCase(configRepo, logger);
  const syncPrometheusUseCase = new SyncPrometheusConfigUseCase(
    config.prometheusConfigPath,
    config.prometheusUrl,
    logger,
  );
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
  const subscriberManagementUseCase = new SubscriberManagementUseCase(
    subscriberRepo,
    auditLogger,
    logger,
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
  );

  // Initialize log streaming WebSocket handler
  const logStreamHandler = new LogStreamHandler(
    logStreamingUseCase,
    dockerLogStreamingUseCase,
    logger,
  );
  wss.on('connection', (ws) => {
    logStreamHandler.handleConnection(ws);
  });
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

  // Auth routes (public — login endpoint must be reachable before auth)
  app.use('/api/auth', createAuthRouter(authLoginUseCase, authLogoutUseCase, logger));

  // ── Auth middleware ── all routes below this line are protected
  app.use('/api', authMiddleware);

  // API Routes
  app.use('/api/users', createUsersRouter(userManagementUseCase, logger));
  app.use(
    '/api/config',
    createConfigRouter(
      loadConfigUseCase,
      validateConfigUseCase,
      applyConfigUseCase,
      topologyUseCase,
      serviceMonitorUseCase,
      syncSDUseCase,
      logger,
    ),
  );
  app.use(
    '/api/services',
    createServiceRouter(serviceMonitorUseCase, logger),
  );
  app.use(
    '/api/subscribers',
    createSubscriberRouter(subscriberManagementUseCase, autoAssignIPsUseCase, logger),
  );
  app.use('/api/audit', createAuditRouter(auditLogger, logger));
  app.use('/api/backup', createBackupRouter(backupRestoreUseCase, restoreDefaultsUseCase, logger));
  app.use('/api/femto', createFemtoRouter(logger));
  app.use('/api/auto-config', createAutoConfigRouter(autoConfigUseCase));
  app.use('/api/interface-status', createInterfaceRouter(hostExecutor, logger, activeSessionsUseCase, configRepo));
  app.use('/api/suci', createSuciRouter(suciManagementUseCase, logger));
  app.use('/api/docker', createDockerRouter(dockerLogStreamingUseCase, logger));

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
  app.listen(config.port, () => {
    logger.info({ port: config.port }, 'HTTP server started');
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down gracefully...');
    serviceMonitorUseCase.stopPolling();
    logStreamHandler.cleanup();
    await subscriberRepo.disconnect();
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
