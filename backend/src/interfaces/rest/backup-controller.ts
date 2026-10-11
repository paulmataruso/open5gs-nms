import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { BackupRestoreUseCase, BackupCategory } from '../../application/use-cases/backup-restore';
import { RestoreDefaultsUseCase } from '../../application/use-cases/restore-defaults';
import { FullRestoreOrchestratorUseCase } from '../../application/use-cases/full-restore-orchestrator-usecase';
import { BackupRestartUseCase } from '../../application/use-cases/backup-restart-usecase';
import { requireAdmin } from './middleware/auth-middleware';
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
  fullRestoreOrchestrator?: FullRestoreOrchestratorUseCase,
  backupRestartUseCase?: BackupRestartUseCase,
): Router {
  const router = Router();

  // POST /api/backup/mongo - Create MongoDB backup
  router.post('/mongo', requireAdmin, async (req, res) => {
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
  router.post('/config', requireAdmin, async (req, res) => {
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
  router.post('/restore/mongo', requireAdmin, async (req, res) => {
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

  // Real, confirmed-live gap (2026-09-24): this "Restore Both"/"Restore
  // Config" pair predates BackupRestartUseCase (built 2026-09-22 for the
  // separate Full Backup Archive flow) and was never retrofitted with it —
  // restoreConfigBackup()/restoreBoth() only ever did a raw file copy via
  // configRepo.restoreBackup(), with ZERO reapply/restart of any module's
  // own side effects. A restored config file would sit on disk while every
  // live daemon kept running its OLD config, with /status pages reading the
  // file and reporting the (unapplied) new value as if it had taken effect
  // — silently wrong for every module, not just one. Kick off the same
  // reapply job the Full Backup path already uses (fire-and-forget, same
  // async-job/getRunState() polling shape) once the file copy succeeds.
  // Both categories always apply here since this mechanism has no
  // per-category selectivity (it's all-or-nothing config, unlike Full
  // Backup's picker). Takes an explicit categories list (not hardcoded)
  // because /restore/selective below has a narrower, real scope — see its
  // own call site.
  const kickOffConfigReapply = (user: string, categories: BackupCategory[] = ['core-configs', 'optional-modules']) => {
    if (!backupRestartUseCase) return;
    const r = backupRestartUseCase.startRestart(categories, user);
    if (!r.started) logger?.warn({ error: r.error }, 'Failed to start reapply after config restore');
  };

  // POST /api/backup/restore/config - Restore config backup
  router.post('/restore/config', requireAdmin, async (req, res) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const { backupName } = req.body;
      if (!backupName) {
        return res.status(400).json({
          success: false,
          error: 'backupName is required',
        });
      }
      const result = await backupRestoreUseCase.restoreConfigBackup(backupName);
      if (result.success) kickOffConfigReapply(user);
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
  router.post('/restore/both', requireAdmin, async (req, res) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const { configBackupName, mongoBackupName } = req.body;
      if (!configBackupName || !mongoBackupName) {
        return res.status(400).json({
          success: false,
          errors: ['configBackupName and mongoBackupName are required'],
        });
      }
      const result = await backupRestoreUseCase.restoreBoth(configBackupName, mongoBackupName);
      if (result.success) kickOffConfigReapply(user);
      const response: RestoreBothResponseDto = result;
      res.json(response);
    } catch (err) {
      res.status(500).json({
        success: false,
        errors: [err instanceof Error ? err.message : 'Unknown error'],
      });
    }
  });

  // GET /api/backup/restore-reapply/status - poll the reapply job kicked
  // off by /restore/config or /restore/both above. Same underlying
  // BackupRestartUseCase instance the Full Backup flow's own status route
  // reads (single shared runState) — a config-only restore's reapply
  // progress is visible here the same way.
  router.get('/restore-reapply/status', requireAdmin, (req, res) => {
    if (!backupRestartUseCase) {
      return res.status(503).json({ success: false, error: 'Reapply tracking unavailable' });
    }
    res.json({ success: true, run: backupRestartUseCase.getRunState() });
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
  router.put('/settings', requireAdmin, async (req, res) => {
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
  router.post('/cleanup', requireAdmin, async (req, res) => {
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
  router.post('/diff', requireAdmin, async (req, res) => {
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
  //
  // Real, confirmed-live gap (2026-09-29, found in the same session-wide audit
  // that first added kickOffConfigReapply above): this is the button the
  // Backup page's own "Restore Config" flow actually calls (ConfigRestoreModal
  // -> restoreSelectedConfigs -> here) — more commonly used than /restore/both
  // — yet it never got wired to the reapply job at all, leaving the exact
  // "file restored on disk, live daemon still running the old config" gap
  // /restore/config and /restore/both were fixed for. Scoped to
  // ['core-configs'] only, not the wider default — restoreSelectedConfigs()
  // exclusively writes /etc/open5gs/<service>.yaml files (the 17 core NFs),
  // never optional-module config, so restarting optional modules here would
  // be needless extra disruption for something this path never touches.
  router.post('/restore/selective', requireAdmin, async (req, res) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const { backupName, services } = req.body;
      // Real, confirmed-live 2026-09-30 finding (adversarial critic review): an
      // empty array passes `!services` (empty array is truthy) and `Array.isArray`,
      // then restoreSelectedConfigs()'s own for-loop over zero items vacuously
      // returns {success: true, restored: [], errors: {}} — which used to still
      // fire kickOffConfigReapply(), triggering a full, unconditional restart of
      // all 17 core NFs + MongoDB for a request that changed nothing. The real
      // frontend already guards this client-side, but the disruptive action lived
      // entirely server-side with no matching guard.
      if (!backupName || !services || !Array.isArray(services) || services.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'backupName and a non-empty services array are required',
        });
      }
      const result = await backupRestoreUseCase.restoreSelectedConfigs(backupName, services);
      if (result.success) kickOffConfigReapply(user, ['core-configs']);
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
  router.get('/full/download', requireAdmin, async (req, res) => {
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

  // POST /api/backup/full/upload - Upload a full backup archive and inspect its
  // contents (which categories are present) WITHOUT restoring anything yet.
  // The frontend uses this to show a pick-and-choose restore checklist before
  // committing. uploadId is just the sanitized temp filename — validated
  // strictly on every subsequent use to prevent path traversal.
  const UPLOADS_DIR = '/tmp/open5gs-backup-uploads';
  const isValidUploadId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9._-]+\.tar\.gz$/.test(id);

  router.post('/full/upload', requireAdmin, async (req, res) => {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const uploadId = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tar.gz`;
    const tmpPath = `${UPLOADS_DIR}/${uploadId}`;
    try {
      await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(tmpPath);
        req.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        req.on('error', reject);
      });

      logger?.info({ tmpPath }, 'Full backup upload received, inspecting');
      const inspection = await backupRestoreUseCase.inspectFullBackup(tmpPath);

      if (!inspection.success) {
        fs.unlink(tmpPath, () => {});
        return res.status(400).json({ success: false, error: inspection.error || 'Archive could not be read' });
      }

      res.json({
        success: true, uploadId, categories: inspection.categories, createdAt: inspection.createdAt,
        presentModules: inspection.presentModules ?? [],
      });
    } catch (err) {
      fs.unlink(tmpPath, () => {});
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // POST /api/backup/full/restore - Restore selected categories from a
  // previously uploaded archive (see /full/upload above). Body:
  // { uploadId, categories, freshHostBootstrap?, presentModules? }.
  // Async — starts the bootstrap(optional)->restore->restart pipeline
  // (full-restore-orchestrator-usecase.ts) and returns immediately; poll
  // GET /full/restore/status for progress. This can run many minutes long
  // (a fresh-host bootstrap alone can be 20+ minutes for VoWiFi/SecGW's own
  // source builds), so — same reasoning as every other multi-minute
  // operation in this codebase — it was never reasonable to keep this
  // synchronous once it started actually restarting services too.
  router.post('/full/restore', requireAdmin, async (req, res) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const { uploadId, categories, freshHostBootstrap, presentModules } = req.body || {};
      if (!isValidUploadId(uploadId)) {
        return res.status(400).json({ success: false, error: 'Invalid or missing uploadId — upload the archive via /full/upload first' });
      }
      if (!Array.isArray(categories) || categories.length === 0) {
        return res.status(400).json({ success: false, error: 'categories array is required (at least one)' });
      }
      if (!fullRestoreOrchestrator) {
        return res.status(500).json({ success: false, error: 'Restore orchestrator not wired up' });
      }
      const tmpPath = `${UPLOADS_DIR}/${uploadId}`;
      if (!fs.existsSync(tmpPath)) {
        return res.status(404).json({ success: false, error: 'Upload not found — it may have already been restored or expired; upload again' });
      }

      logger?.info({ uploadId, categories, freshHostBootstrap }, 'Starting full restore');
      const result = fullRestoreOrchestrator.startFullRestore(
        tmpPath,
        categories as BackupCategory[],
        Array.isArray(presentModules) ? presentModules : [],
        !!freshHostBootstrap,
        user,
      );
      if (!result.started) {
        return res.status(409).json({ success: false, error: result.error });
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // GET /api/backup/full/restore/status - Poll progress of the async
  // restore started above.
  router.get('/full/restore/status', requireAdmin, (_req, res) => {
    if (!fullRestoreOrchestrator) {
      return res.status(500).json({ success: false, error: 'Restore orchestrator not wired up' });
    }
    res.json({ success: true, run: fullRestoreOrchestrator.getRunState() });
  });

  // POST /api/backup/restore-defaults - Restore factory default configs
  router.post('/restore-defaults', requireAdmin, async (req, res) => {
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
