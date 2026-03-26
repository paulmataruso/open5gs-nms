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
}

export function loadAppConfig(): AppConfig {
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
  };
}
