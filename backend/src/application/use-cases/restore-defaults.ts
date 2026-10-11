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

  async execute(user: string = 'system'): Promise<{ success: boolean; message: string; backupCreated: string; warnings?: string[] }> {
    this.logger.info('Starting restore defaults process');

    try {
      // Step 1: Create a safety backup first
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = path.join(this.backupPath, `pre-restore-${timestamp}`);
      
      this.logger.info({ backupDir }, 'Creating safety backup before restore');
      await this.hostExecutor.createDirectory(backupDir);
      
      // Backup all current configs
      // The 17 core NFs (CLAUDE.md pattern #2). `sepp2.yaml` used to be listed
      // here too — this deployment has only sepp1, so that entry was a no-op
      // that made the list look like it covered 18 files.
      const configFiles = [
        'amf.yaml', 'ausf.yaml', 'bsf.yaml', 'hss.yaml', 'mme.yaml',
        'nrf.yaml', 'nssf.yaml', 'pcf.yaml', 'pcrf.yaml', 'scp.yaml',
        'sepp1.yaml', 'sgwc.yaml', 'sgwu.yaml', 'smf.yaml',
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

      // These defaults are Open5GS's own STOCK files, not this deployment's.
      // They carry the upstream test PLMN (MCC 999 / MNC 70), stock loopback
      // SBI addresses, and no `advertise` FQDNs — so restoring them reverts a
      // deployment's real PLMN, drops any configured Slice Differentiator, and
      // undoes the DNS/FQDN Migration Wizard's work, which detaches every
      // attached UE and crash-loops any NF that was resolving its own FQDN
      // (pattern #6). That is arguably what "factory defaults" should mean, but
      // it was previously entirely silent — the operator got a success message
      // with no indication their PLMN had changed. Surfaced as a real warning
      // now, and in the returned message, so the safety backup above is
      // actually actionable.
      const warnings: string[] = [];
      try {
        const [currentAmf, defaultAmf] = await Promise.all([
          this.hostExecutor.readFile('/etc/open5gs/amf.yaml').catch(() => ''),
          this.hostExecutor.readFile(path.join(defaultsPath, 'amf.yaml')).catch(() => ''),
        ]);
        const plmnOf = (text: string): string | null => {
          const mcc = text.match(/^\s*mcc:\s*(\d+)\s*$/m)?.[1];
          const mnc = text.match(/^\s*mnc:\s*(\d+)\s*$/m)?.[1];
          return mcc && mnc ? `${mcc}-${mnc}` : null;
        };
        const before = plmnOf(currentAmf);
        const after = plmnOf(defaultAmf);
        if (before && after && before !== after) {
          const msg = `PLMN reverts ${before} -> ${after}: every attached UE will detach and must re-register.`;
          warnings.push(msg);
          this.logger.warn({ before, after }, `restore defaults: ${msg}`);
        }
        const sd = currentAmf.match(/^\s*sd:\s*"?([0-9a-fA-F]+)"?\s*$/m)?.[1];
        if (sd && !new RegExp(`sd:\\s*"?${sd}`).test(defaultAmf)) {
          const msg = `Slice Differentiator sd:${sd} is not in the stock defaults and will be lost.`;
          warnings.push(msg);
          this.logger.warn({ sd }, `restore defaults: ${msg}`);
        }
        if (/advertise:/.test(currentAmf) && !/^\s*advertise:/m.test(defaultAmf)) {
          const msg = 'SBI `advertise` FQDNs will be removed — if this deployment was migrated onto FQDNs, every migrated NF will fail to resolve its own name and crash-loop until re-migrated (CLAUDE.md pattern #6).';
          warnings.push(msg);
          this.logger.warn(`restore defaults: ${msg}`);
        }
      } catch (err) {
        this.logger.warn({ err: String(err) }, 'restore defaults: could not pre-compare amf.yaml');
      }
      
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
        message:
          `All configurations restored to factory defaults. A safety backup was created at: ${backupDir}` +
          (warnings.length > 0
            ? `\n\nThese defaults are Open5GS's stock files, not this deployment's own:\n` +
              warnings.map(w => `  • ${w}`).join('\n')
            : ''),
        backupCreated: backupDir,
        warnings,
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
