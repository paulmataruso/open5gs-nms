import pino from 'pino';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import * as path from 'path';

export class RestoreDefaultsUseCase {
  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly configRepo: IConfigRepository,
    private readonly auditLogger: IAuditLogger,
    private readonly logger: pino.Logger,
    private readonly backupPath: string,
  ) {}

  async execute(user: string = 'system'): Promise<{ success: boolean; message: string; backupCreated: string }> {
    this.logger.info('Starting restore defaults process');

    try {
      // Step 1: Create a safety backup first
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = path.join(this.backupPath, `pre-restore-${timestamp}`);
      
      this.logger.info({ backupDir }, 'Creating safety backup before restore');
      await this.hostExecutor.createDirectory(backupDir);
      
      // Backup all current configs
      const configFiles = [
        'amf.yaml', 'ausf.yaml', 'bsf.yaml', 'hss.yaml', 'mme.yaml',
        'nrf.yaml', 'nssf.yaml', 'pcf.yaml', 'pcrf.yaml', 'scp.yaml',
        'sepp1.yaml', 'sepp2.yaml', 'sgwc.yaml', 'sgwu.yaml', 'smf.yaml',
        'udm.yaml', 'udr.yaml', 'upf.yaml'
      ];

      for (const file of configFiles) {
        const sourcePath = `/etc/open5gs/${file}`;
        const destPath = path.join(backupDir, file);
        
        try {
          await this.hostExecutor.copyFile(sourcePath, destPath);
          this.logger.info({ file }, 'Backed up config file');
        } catch (err) {
          this.logger.warn({ file, error: String(err) }, 'Failed to backup config file (may not exist)');
        }
      }

      // Step 2: Copy default configs to /etc/open5gs/
      this.logger.info('Restoring default configurations');
      const defaultsPath = path.join(__dirname, '../../config/defaults');
      
      for (const file of configFiles) {
        const sourcePath = path.join(defaultsPath, file);
        const destPath = `/etc/open5gs/${file}`;
        
        try {
          // Check if default file exists
          const exists = await this.hostExecutor.fileExists(sourcePath);
          if (!exists) {
            this.logger.warn({ file }, 'Default config file not found, skipping');
            continue;
          }
          
          // Read default config
          const content = await this.hostExecutor.readFile(sourcePath);
          
          // Write to /etc/open5gs/
          await this.hostExecutor.writeFile(destPath, content);
          this.logger.info({ file }, 'Restored default config');
        } catch (err) {
          this.logger.error({ file, error: String(err) }, 'Failed to restore config file');
          throw new Error(`Failed to restore ${file}: ${err}`);
        }
      }

      // Step 3: Log the action
      await this.auditLogger.log({
        user,
        action: 'restore_defaults',
        target: 'all_configs',
        details: `Restored all Open5GS configs to factory defaults. Safety backup created at: ${backupDir}`,
        success: true,
      });

      this.logger.info({ backupDir }, 'Successfully restored default configurations');
      
      return {
        success: true,
        message: `All configurations restored to factory defaults. A safety backup was created at: ${backupDir}`,
        backupCreated: backupDir,
      };

    } catch (error) {
      this.logger.error({ error }, 'Failed to restore default configurations');
      
      await this.auditLogger.log({
        user,
        action: 'restore_defaults',
        target: 'all_configs',
        details: `Failed to restore defaults: ${error}`,
        success: false,
      });

      throw error;
    }
  }
}
