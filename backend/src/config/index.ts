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
  };
}
