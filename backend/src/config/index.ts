export interface AppConfig {
  port: number;
  wsPort: number;
  mongodbUri: string;
  configPath: string;
  backupPath: string;
  mongoBackupPath: string;
  logLevel: string;
  logDir: string;
  systemctlPath: string;
  // Auth
  authDbPath: string;
  sessionMaxAge: number;
  firstRunPassword: string | null;
  isProduction: boolean;
  cookieSecure: boolean;
  // Prometheus sync
  prometheusConfigPath: string;
  prometheusUrl: string;
  // GenieACS
  genieacsNbiUrl: string;
  // SASBench (CBRS SAS) — runs as its own container; the NMS only reads its REST API
  sasbenchApiUrl: string;
  sasbenchUiPort: number;
  sasbenchUser: string;
  sasbenchPassword: string;
  sasbenchDir: string;
  sasbenchContext: string;
  // Simlessly eSIM RSP API
  simlesslyAccessKey: string;
  simlesslySecretKey: string;
}

export function loadAppConfig(): AppConfig {
  const isProduction = process.env.NODE_ENV === 'production';

  return {
    port: parseInt(process.env.PORT || '3001', 10),
    wsPort: parseInt(process.env.WS_PORT || '3002', 10),
    mongodbUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/open5gs',
    configPath: process.env.CONFIG_PATH || '/etc/open5gs',
    backupPath: process.env.BACKUP_PATH || '/var/open5gs/backups/config',
    mongoBackupPath: process.env.MONGO_BACKUP_PATH || '/var/open5gs/backups/mongodb',
    logLevel: process.env.LOG_LEVEL || 'info',
    logDir: process.env.LOG_DIR || '/var/log/open5gs-nms',
    systemctlPath: process.env.HOST_SYSTEMCTL_PATH || '/usr/bin/systemctl',
    // Auth
    authDbPath: process.env.AUTH_DB_PATH || '/app/data/auth.db',
    sessionMaxAge: parseInt(process.env.SESSION_MAX_AGE || '86400', 10),
    firstRunPassword: process.env.FIRST_RUN_PASSWORD || null,
    isProduction,
    // COOKIE_SECURE controls the Secure flag on the session cookie.
    // Default false — the NMS runs over plain HTTP on a local LAN.
    // Only set to true if you are running behind HTTPS.
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    // Prometheus sync
    prometheusConfigPath: process.env.PROMETHEUS_CONFIG_PATH || './monitoring/prometheus.yml',
    prometheusUrl: process.env.PROMETHEUS_URL || `http://127.0.0.1:${process.env.PROMETHEUS_PORT || '9099'}`,
    // GenieACS NBI — internal, not exposed to users
    genieacsNbiUrl: process.env.GENIEACS_NBI_URL || 'http://127.0.0.1:7557',
    // SASBench — the CBRS SAS. It owns the SAS protocol ports directly; this
    // NMS never speaks SAS-CBSD itself, it only reads SASBench's REST API to
    // render a status page. SASBENCH_UI_PORT is also what the browser is told
    // to open for SASBench's own admin UI, so it must be the real host port.
    sasbenchApiUrl:
      process.env.SASBENCH_API_URL ||
      `http://127.0.0.1:${process.env.SASBENCH_UI_PORT || '8094'}`,
    sasbenchUiPort: parseInt(process.env.SASBENCH_UI_PORT || '8094', 10),
    // HTTP Basic against SASBench, kept server-side so no SAS credential is
    // ever handed to the browser. Matches SAS_ADMIN_PASSWORD in .env.
    sasbenchUser: process.env.SASBENCH_USER || 'admin',
    sasbenchPassword: process.env.SAS_ADMIN_PASSWORD || 'admin',
    // An OPTIONAL SASBench checkout on the HOST, outside this repository (it
    // is proprietary; this project is AGPL-3.0, so it must never be vendored
    // in). Nothing requires it to exist: the sasbench service builds from a
    // pinned remote git context by default. When it does exist, the SAS page
    // reports commit-level detail from it.
    sasbenchDir: process.env.SASBENCH_DIR || '/opt/sasbench',
    // What the sasbench service actually builds from, so the SAS page can
    // report which SASBench revision this deployment is pinned to. Keep this
    // default in step with docker-compose.yml's own.
    sasbenchContext:
      process.env.SASBENCH_CONTEXT
      || 'https://github.com/paulmataruso/SASBench.git#e244bb825178d57e3adeeaaebb2941b3fab5fea9',
    // Simlessly eSIM RSP API — obtained from the Developer module on the user's
    // Simlessly account; empty until the user supplies real values.
    simlesslyAccessKey: process.env.SIMLESSLY_ACCESS_KEY || '',
    simlesslySecretKey: process.env.SIMLESSLY_SECRET_KEY || '',
  };
}
