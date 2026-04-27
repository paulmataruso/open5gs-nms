import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { BackupRestoreUseCase } from '../../application/use-cases/backup-restore';
import { RestoreDefaultsUseCase } from '../../application/use-cases/restore-defaults';
import type {
  BackupListResponseDto,
  BackupSettingsDto,
  CreateBackupResponseDto,
  RestoreBackupResponseDto,
  RestoreBothResponseDto,
} from '../../application/dto';

export function createBackupRouter(
  backupRestoreUseCase: BackupRestoreUseCase,
  restoreDefaultsUseCase?: RestoreDefaultsUseCase,
  logger?: import('pino').Logger,
): Router {
  const router = Router();

  // POST /api/backup/mongo - Create MongoDB backup
  router.post('/mongo', async (req, res) => {
    try {
      const result = await backupRestoreUseCase.createMongoBackup();
      const response: CreateBackupResponseDto = result;
      res.json(response);
    } catch (err) {
      res.status(500).json({
        success: false,
        backupName: '',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // POST /api/backup/config - Create config backup
  router.post('/config', async (req, res) => {
    try {
      const result = await backupRestoreUseCase.createConfigBackup();
      const response: CreateBackupResponseDto = result;
      res.json(response);
    } catch (err) {
      res.status(500).json({
        success: false,
        backupName: '',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // POST /api/backup/restore/mongo - Restore MongoDB backup
  router.post('/restore/mongo', async (req, res) => {
    try {
      const { backupName } = req.body;
      if (!backupName) {
        return res.status(400).json({
          success: false,
          error: 'backupName is required',
        });
      }
      const result = await backupRestoreUseCase.restoreMongoBackup(backupName);
      const response: RestoreBackupResponseDto = result;
      res.json(response);
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // POST /api/backup/restore/config - Restore config backup
  router.post('/restore/config', async (req, res) => {
    try {
      const { backupName } = req.body;
      if (!backupName) {
        return res.status(400).json({
          success: false,
          error: 'backupName is required',
        });
      }
      const result = await backupRestoreUseCase.restoreConfigBackup(backupName);
      const response: RestoreBackupResponseDto = result;
      res.json(response);
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // POST /api/backup/restore/both - Restore both MongoDB and config
  router.post('/restore/both', async (req, res) => {
    try {
      const { configBackupName, mongoBackupName } = req.body;
      if (!configBackupName || !mongoBackupName) {
        return res.status(400).json({
          success: false,
          errors: ['configBackupName and mongoBackupName are required'],
        });
      }
      const result = await backupRestoreUseCase.restoreBoth(configBackupName, mongoBackupName);
      const response: RestoreBothResponseDto = result;
      res.json(response);
    } catch (err) {
      res.status(500).json({
        success: false,
        errors: [err instanceof Error ? err.message : 'Unknown error'],
      });
    }
  });

  // GET /api/backup/list - List all backups
  router.get('/list', async (req, res) => {
    try {
      const [mongoBackups, configBackups] = await Promise.all([
        backupRestoreUseCase.listMongoBackups(),
        backupRestoreUseCase.listConfigBackups(),
      ]);

      const response: BackupListResponseDto = {
        mongoBackups: mongoBackups.map(b => ({
          name: b.name,
          timestamp: b.timestamp.toISOString(),
          type: 'mongodb' as const,
        })),
        configBackups: configBackups.map(b => ({
          name: b.name,
          timestamp: b.timestamp.toISOString(),
          type: 'config' as const,
        })),
      };
      res.json(response);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger?.error({ err: errorMsg }, 'Failed to list backups');
      res.status(500).json({
        mongoBackups: [],
        configBackups: [],
        error: errorMsg,
      });
    }
  });

  // GET /api/backup/settings - Get backup settings
  router.get('/settings', async (req, res) => {
    try {
      const settings: BackupSettingsDto = {
        configBackupsToKeep: 10,
        mongoBackupsToKeep: 5,
      };
      res.json(settings);
    } catch (err) {
      res.status(500).json({
        configBackupsToKeep: 10,
        mongoBackupsToKeep: 5,
      });
    }
  });

  // PUT /api/backup/settings - Update backup settings
  router.put('/settings', async (req, res) => {
    try {
      const settings: BackupSettingsDto = req.body;
      
      if (settings.configBackupsToKeep < 1 || settings.mongoBackupsToKeep < 1) {
        return res.status(400).json({
          error: 'Backup retention must be at least 1',
        });
      }

      await backupRestoreUseCase.cleanupOldBackups(settings);
      
      res.json(settings);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // POST /api/backup/cleanup - Trigger manual cleanup
  router.post('/cleanup', async (req, res) => {
    try {
      const settings: BackupSettingsDto = req.body || {
        configBackupsToKeep: 10,
        mongoBackupsToKeep: 5,
      };
      await backupRestoreUseCase.cleanupOldBackups(settings);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // GET /api/backup/last-config - Get last config backup name
  router.get('/last-config', async (req, res) => {
    try {
      const lastBackup = await backupRestoreUseCase.getLastConfigBackup();
      res.json({ backupName: lastBackup });
    } catch (err) {
      res.status(500).json({
        backupName: null,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // POST /api/backup/diff - Get diff between current and backup configs
  router.post('/diff', async (req, res) => {
    try {
      const { backupName } = req.body;
      if (!backupName) {
        return res.status(400).json({
          success: false,
          error: 'backupName is required',
        });
      }
      const result = await backupRestoreUseCase.getConfigDiff(backupName);
      res.json(result);
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // POST /api/backup/restore/selective - Restore selected config files
  router.post('/restore/selective', async (req, res) => {
    try {
      const { backupName, services } = req.body;
      if (!backupName || !services || !Array.isArray(services)) {
        return res.status(400).json({
          success: false,
          error: 'backupName and services array are required',
        });
      }
      const result = await backupRestoreUseCase.restoreSelectedConfigs(backupName, services);
      res.json(result);
    } catch (err) {
      res.status(500).json({
        success: false,
        restored: [],
        errors: { general: err instanceof Error ? err.message : 'Unknown error' },
      });
    }
  });

  // GET /api/backup/full/download - Create and stream a full backup archive
  router.get('/full/download', async (req, res) => {
    try {
      logger?.info('Full backup download requested');
      const result = await backupRestoreUseCase.createFullBackup();

      if (!result.success || !result.archivePath) {
        return res.status(500).json({ success: false, error: result.error || 'Backup failed' });
      }

      const filename = path.basename(result.archivePath);
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      const stream = fs.createReadStream(result.archivePath);
      stream.pipe(res);

      // Clean up the temp file after streaming
      stream.on('end', () => {
        fs.unlink(result.archivePath, () => {});
      });
      stream.on('error', (err) => {
        logger?.error({ err: String(err) }, 'Error streaming full backup');
        fs.unlink(result.archivePath, () => {});
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // POST /api/backup/full/restore - Upload and restore a full backup archive
  router.post('/full/restore', async (req, res) => {
    const tmpPath = `/tmp/open5gs-upload-${Date.now()}.tar.gz`;
    try {
      // Stream the raw request body to a temp file
      await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(tmpPath);
        req.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        req.on('error', reject);
      });

      logger?.info({ tmpPath }, 'Full backup upload received, restoring');
      const result = await backupRestoreUseCase.restoreFullBackup(tmpPath);

      if (!result.success) {
        return res.status(500).json({ success: false, error: result.error });
      }

      res.json({ success: true, message: 'Full backup restored successfully' });
    } catch (err) {
      fs.unlink(tmpPath, () => {});
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // POST /api/backup/restore-defaults - Restore factory default configs
  router.post('/restore-defaults', async (req, res) => {
    try {
      if (!restoreDefaultsUseCase) {
        return res.status(501).json({
          success: false,
          message: 'Restore defaults feature not available',
        });
      }
      
      const result = await restoreDefaultsUseCase.execute('admin');
      res.json(result);
    } catch (err) {
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : 'Unknown error',
        backupCreated: '',
      });
    }
  });

  return router;
}
