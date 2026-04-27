import pino from 'pino';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { IConfigRepository } from '../../domain/interfaces/config-repository';

export interface BackupListItem {
  name: string;
  path: string;
  timestamp: Date;
  type: 'config' | 'mongodb' | 'combined';
  size?: string;
}

export interface BackupSettings {
  configBackupsToKeep: number;
  mongoBackupsToKeep: number;
}

export class BackupRestoreUseCase {
  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly configRepo: IConfigRepository,
    private readonly logger: pino.Logger,
    private readonly configBackupPath: string,
    private readonly mongoBackupPath: string,
  ) {}

  async createFullBackup(): Promise<{ success: boolean; archivePath: string; error?: string }> {
    let tmpDir = '';
    try {
      const now = new Date();
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
      const dirName = `open5gs-full-backup-${dateStr}`;
      tmpDir = `/tmp/${dirName}`;
      const archivePath = `/tmp/${dirName}.tar.gz`;

      this.logger.info({ tmpDir, archivePath }, 'Creating full backup archive');

      // Create temp working directory structure
      await this.hostExecutor.executeLocalCommand('mkdir', ['-p', `${tmpDir}/mongodb`, `${tmpDir}/config`]);

      // Dump MongoDB into temp dir
      const mongoResult = await this.hostExecutor.executeLocalCommand('mongodump', ['-o', `${tmpDir}/mongodb`]);
      if (mongoResult.exitCode !== 0) {
        throw new Error(`mongodump failed: ${mongoResult.stderr}`);
      }
      this.logger.info('MongoDB dump complete');

      // Copy all NF config YAMLs into temp dir
      const services = ['nrf', 'scp', 'amf', 'smf', 'upf', 'ausf', 'udm', 'udr', 'pcf', 'nssf', 'bsf', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu'];
      for (const service of services) {
        try {
          const src = `/etc/open5gs/${service}.yaml`;
          const dst = `${tmpDir}/config/${service}.yaml`;
          await this.hostExecutor.copyFile(src, dst);
        } catch {
          this.logger.warn({ service }, 'Config file not found, skipping');
        }
      }
      this.logger.info('Config files copied');

      // Write a manifest so restore knows what's inside
      const manifest = JSON.stringify({
        version: '1.0',
        createdAt: now.toISOString(),
        contents: ['mongodb', 'config'],
      }, null, 2);
      const fs = await import('fs/promises');
      await fs.writeFile(`${tmpDir}/manifest.json`, manifest, 'utf8');

      // Create the tarball — use the exact directory name relative to /tmp
      const tarResult = await this.hostExecutor.executeLocalCommand('tar', [
        '-czf', archivePath,
        '-C', '/tmp',
        dirName,
      ]);
      if (tarResult.exitCode !== 0) {
        throw new Error(`tar failed: ${tarResult.stderr}`);
      }

      // Cleanup temp dir
      await this.hostExecutor.executeLocalCommand('rm', ['-rf', tmpDir]);

      this.logger.info({ archivePath }, 'Full backup archive created successfully');
      return { success: true, archivePath };
    } catch (err) {
      await this.hostExecutor.executeLocalCommand('rm', ['-rf', tmpDir]).catch(() => {});
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error }, 'Full backup failed');
      return { success: false, archivePath: '', error };
    }
  }

  async restoreFullBackup(archivePath: string): Promise<{ success: boolean; error?: string }> {
    const tmpDir = `/tmp/open5gs-full-restore-${Date.now()}`;
    try {
      this.logger.info({ archivePath, tmpDir }, 'Restoring full backup archive');

      // Extract archive
      await this.hostExecutor.executeLocalCommand('mkdir', ['-p', tmpDir]);
      const tarResult = await this.hostExecutor.executeLocalCommand('tar', [
        '-xzf', archivePath,
        '-C', tmpDir,
        '--strip-components=1',  // strip the top-level directory
      ]);
      if (tarResult.exitCode !== 0) {
        throw new Error(`tar extract failed: ${tarResult.stderr}`);
      }

      // Restore MongoDB
      const mongoResult = await this.hostExecutor.executeLocalCommand('mongorestore', [
        '--drop',
        `${tmpDir}/mongodb`,
      ]);
      if (mongoResult.exitCode !== 0) {
        throw new Error(`mongorestore failed: ${mongoResult.stderr}`);
      }
      this.logger.info('MongoDB restored from full backup');

      // Restore config YAMLs
      const services = ['nrf', 'scp', 'amf', 'smf', 'upf', 'ausf', 'udm', 'udr', 'pcf', 'nssf', 'bsf', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu'];
      for (const service of services) {
        try {
          const src = `${tmpDir}/config/${service}.yaml`;
          const dst = `/etc/open5gs/${service}.yaml`;
          await this.hostExecutor.copyFile(src, dst);
        } catch {
          this.logger.warn({ service }, 'Config file missing from archive, skipping');
        }
      }
      this.logger.info('Config files restored from full backup');

      // Cleanup
      await this.hostExecutor.executeLocalCommand('rm', ['-rf', tmpDir]);
      await this.hostExecutor.executeLocalCommand('rm', ['-f', archivePath]).catch(() => {});

      this.logger.info('Full backup restore complete');
      return { success: true };
    } catch (err) {
      await this.hostExecutor.executeLocalCommand('rm', ['-rf', tmpDir]).catch(() => {});
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error }, 'Full backup restore failed');
      return { success: false, error };
    }
  }

  async createMongoBackup(): Promise<{ success: boolean; backupName: string; error?: string }> {
    try {
      const dateStr = new Date().toISOString().split('T')[0].split('-').reverse().join('-'); // dd-mm-yyyy
      const backupName = `Open5Gs_${dateStr}`;
      const backupPath = `${this.mongoBackupPath}/${backupName}`;

      this.logger.info({ backupName, backupPath }, 'Creating MongoDB backup');

      // Run mongodump locally in the container so it writes to the container-mounted volume
      const result = await this.hostExecutor.executeLocalCommand('mongodump', ['-o', backupPath]);
      
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `mongodump failed with exit code ${result.exitCode}`);
      }

      this.logger.info({ backupName }, 'MongoDB backup created successfully');
      return { success: true, backupName };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error }, 'MongoDB backup failed');
      return { success: false, backupName: '', error };
    }
  }

  async restoreMongoBackup(backupName: string): Promise<{ success: boolean; error?: string }> {
    try {
      const backupPath = `${this.mongoBackupPath}/${backupName}`;
      
      this.logger.info({ backupName, backupPath }, 'Restoring MongoDB backup');

      // Check if backup exists
      const exists = await this.hostExecutor.fileExists(backupPath);
      if (!exists) {
        throw new Error(`Backup not found: ${backupName}`);
      }

      // Run mongorestore locally in the container
      const result = await this.hostExecutor.executeLocalCommand('mongorestore', ['--drop', backupPath]);
      
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `mongorestore failed with exit code ${result.exitCode}`);
      }

      this.logger.info({ backupName }, 'MongoDB backup restored successfully');
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error, backupName }, 'MongoDB restore failed');
      return { success: false, error };
    }
  }

  async createConfigBackup(): Promise<{ success: boolean; backupName: string; error?: string }> {
    try {
      const now = new Date();
      const backupName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
      const backupPath = `${this.configBackupPath}/${backupName}`;

      this.logger.info({ backupName, backupPath }, 'Creating config backup');

      await this.configRepo.backupAll(backupPath);

      this.logger.info({ backupName }, 'Config backup created successfully');
      return { success: true, backupName };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error }, 'Config backup failed');
      return { success: false, backupName: '', error };
    }
  }

  async restoreConfigBackup(backupName: string): Promise<{ success: boolean; error?: string }> {
    try {
      const backupPath = `${this.configBackupPath}/${backupName}`;
      
      this.logger.info({ backupName, backupPath }, 'Restoring config backup');

      await this.configRepo.restoreBackup(backupPath);

      this.logger.info({ backupName }, 'Config backup restored successfully');
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error, backupName }, 'Config restore failed');
      return { success: false, error };
    }
  }

  async listMongoBackups(): Promise<BackupListItem[]> {
    try {
      const entries = await this.hostExecutor.listDirectory(this.mongoBackupPath);

      const backups = entries
        .filter(name => name.trim().length > 0 && name.startsWith('Open5Gs_'))
        .map(name => {
          // Parse date from Open5Gs_dd-mm-yyyy format
          const datePart = name.replace('Open5Gs_', '');
          const [day, month, year] = datePart.split('-');
          const timestamp = new Date(`${year}-${month}-${day}`);
          
          return {
            name,
            path: `${this.mongoBackupPath}/${name}`,
            timestamp,
            type: 'mongodb' as const,
          };
        })
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      return backups;
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'No MongoDB backups found or directory does not exist');
      return [];
    }
  }

  async listConfigBackups(): Promise<BackupListItem[]> {
    try {
      const entries = await this.hostExecutor.listDirectory(this.configBackupPath);

      // Only match yyyy-mm-dd-hhmm format (e.g. 2026-03-04-1430)
      // This excludes pre-restore-* and any other non-backup directories
      const configBackupPattern = /^\d{4}-\d{2}-\d{2}-\d{4}$/;

      const backups = entries
        .filter(name => configBackupPattern.test(name.trim()))
        .map(name => {
          // Parse date from yyyy-mm-dd-hhmm format
          const parts = name.split('-');
          const year = parseInt(parts[0]);
          const month = parseInt(parts[1]) - 1;
          const day = parseInt(parts[2]);
          const hour = parseInt(parts[3]?.substring(0, 2) || '0');
          const minute = parseInt(parts[3]?.substring(2) || '0');
          const timestamp = new Date(year, month, day, hour, minute);

          // Skip if date parsing produced an invalid date
          if (isNaN(timestamp.getTime())) {
            this.logger.warn({ name }, 'Skipping backup with unparseable date');
            return null;
          }
          
          return {
            name,
            path: `${this.configBackupPath}/${name}`,
            timestamp,
            type: 'config' as const,
          };
        })
        .filter((b): b is NonNullable<typeof b> => b !== null)
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      return backups;
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'No config backups found or directory does not exist');
      return [];
    }
  }

  async cleanupOldBackups(settings: BackupSettings): Promise<void> {
    try {
      // Cleanup old MongoDB backups
      const mongoBackups = await this.listMongoBackups();
      if (mongoBackups.length > settings.mongoBackupsToKeep) {
        const toDelete = mongoBackups.slice(settings.mongoBackupsToKeep);
        for (const backup of toDelete) {
          await this.hostExecutor.executeCommand('rm', ['-rf', backup.path]);
          this.logger.info({ backup: backup.name }, 'Deleted old MongoDB backup');
        }
      }

      // Cleanup old config backups
      const configBackups = await this.listConfigBackups();
      if (configBackups.length > settings.configBackupsToKeep) {
        const toDelete = configBackups.slice(settings.configBackupsToKeep);
        for (const backup of toDelete) {
          await this.hostExecutor.executeCommand('rm', ['-rf', backup.path]);
          this.logger.info({ backup: backup.name }, 'Deleted old config backup');
        }
      }
    } catch (err) {
      this.logger.error({ err: String(err) }, 'Failed to cleanup old backups');
    }
  }

  async getLastConfigBackup(): Promise<string | null> {
    const backups = await this.listConfigBackups();
    return backups.length > 0 ? backups[0].name : null;
  }

  async restoreBoth(configBackupName: string, mongoBackupName: string): Promise<{ success: boolean; errors: string[] }> {
    const errors: string[] = [];

    // Restore config
    const configResult = await this.restoreConfigBackup(configBackupName);
    if (!configResult.success) {
      errors.push(`Config restore failed: ${configResult.error}`);
    }

    // Restore MongoDB
    const mongoResult = await this.restoreMongoBackup(mongoBackupName);
    if (!mongoResult.success) {
      errors.push(`MongoDB restore failed: ${mongoResult.error}`);
    }

    return {
      success: errors.length === 0,
      errors,
    };
  }

  async getConfigDiff(backupName: string): Promise<{ success: boolean; files?: Record<string, { current: string; backup: string; hasDiff: boolean }>; error?: string }> {
    try {
      const backupPath = `${this.configBackupPath}/${backupName}`;
      
      // Check if backup exists
      const exists = await this.hostExecutor.fileExists(backupPath);
      if (!exists) {
        throw new Error(`Backup not found: ${backupName}`);
      }

      const services = ['nrf', 'scp', 'amf', 'smf', 'upf', 'ausf', 'udm', 'udr', 'pcf', 'nssf', 'bsf', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu'];
      const files: Record<string, { current: string; backup: string; hasDiff: boolean }> = {};

      for (const service of services) {
        try {
          // Get current YAML
          const current = await this.configRepo.getRawYaml(service);
          
          // Get backup YAML
          const backupFilePath = `${backupPath}/${service}.yaml`;
          const backup = await this.hostExecutor.readFile(backupFilePath);
          
          files[service] = {
            current,
            backup,
            hasDiff: current.trim() !== backup.trim(),
          };
        } catch (err) {
          this.logger.warn({ service, err: String(err) }, 'Failed to load config for diff');
          // Skip this service if it doesn't exist
        }
      }

      return { success: true, files };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error, backupName }, 'Failed to generate config diff');
      return { success: false, error };
    }
  }

  async restoreSelectedConfigs(backupName: string, services: string[]): Promise<{ success: boolean; restored: string[]; errors: Record<string, string> }> {
    try {
      const backupPath = `${this.configBackupPath}/${backupName}`;
      
      // Check if backup exists
      const exists = await this.hostExecutor.fileExists(backupPath);
      if (!exists) {
        throw new Error(`Backup not found: ${backupName}`);
      }

      const restored: string[] = [];
      const errors: Record<string, string> = {};

      for (const service of services) {
        try {
          const backupFilePath = `${backupPath}/${service}.yaml`;
          const currentFilePath = `/etc/open5gs/${service}.yaml`;
          
          // Copy backup file to current location
          await this.hostExecutor.copyFile(backupFilePath, currentFilePath);
          restored.push(service);
          this.logger.info({ service }, 'Config file restored');
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          errors[service] = error;
          this.logger.error({ service, err: error }, 'Failed to restore config file');
        }
      }

      return {
        success: Object.keys(errors).length === 0,
        restored,
        errors,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error, backupName }, 'Selective config restore failed');
      throw err;
    }
  }
}
