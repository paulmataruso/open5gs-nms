import pino from 'pino';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';

export interface PlmnConfig {
  mcc: string;
  mnc: string;
  mme_gid?: number;  // For MME
  mme_code?: number; // For MME
  tac?: number;      // TAC for this PLMN
}

export interface AutoConfigInput {
  plmn4g: PlmnConfig[];  // Multiple PLMNs for MME
  plmn5g: PlmnConfig[];  // Multiple PLMNs for AMF
  s1mmeIP: string;
  sgwuGtpIP: string;
  amfNgapIP: string;
  upfGtpIP: string;
  sessionPoolIPv4Subnet: string;
  sessionPoolIPv4Gateway: string;
  sessionPoolIPv6Subnet: string;
  sessionPoolIPv6Gateway: string;
  configureNAT: boolean;
  natInterface?: string; // e.g., 'ogstun'
}

export interface AutoConfigResult {
  success: boolean;
  message: string;
  backupCreated?: string;
  updatedFiles: string[];
  errors?: string[];
}

export interface AutoConfigPreviewResult {
  success: boolean;
  message?: string;
  diffs: Record<string, string>; // service name -> diff string
}

export class AutoConfigUseCase {
  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly configRepo: IConfigRepository,
    private readonly auditLogger: IAuditLogger,
    private readonly logger: pino.Logger,
    private readonly backupPath: string,
  ) {}

  async preview(input: AutoConfigInput): Promise<AutoConfigPreviewResult> {
    this.logger.info({ input }, 'Generating auto-config preview');

    try {
      // Load current configs
      const configs = await this.configRepo.loadAll();
      const diffs: Record<string, string> = {};

      // Generate diffs for each affected config
      const yaml = await import('yaml');
      const diff = await import('diff');

      // MME diff
      if (configs.mme) {
        const original = configs.mme.rawYaml as any;
        const modified = JSON.parse(JSON.stringify(original)); // Deep clone

        // Apply MME changes to rawYaml structure
        if (!modified.mme) modified.mme = {};
        if (!modified.mme.s1ap) modified.mme.s1ap = {};
        modified.mme.s1ap.server = [{ address: input.s1mmeIP }];

        // Update GUMMEI with multiple PLMNs
        modified.mme.gummei = input.plmn4g.map(plmn => ({
          plmn_id: { mcc: plmn.mcc, mnc: plmn.mnc },
          mme_gid: plmn.mme_gid ?? 2,
          mme_code: plmn.mme_code ?? 1,
        }));

        // Update TAI with multiple PLMNs
        modified.mme.tai = input.plmn4g.map(plmn => ({
          plmn_id: { mcc: plmn.mcc, mnc: plmn.mnc },
          tac: plmn.tac ?? 1,
        }));

        const originalYaml = yaml.stringify(original);
        const modifiedYaml = yaml.stringify(modified);
        const diffResult = diff.createTwoFilesPatch('mme.yaml', 'mme.yaml', originalYaml, modifiedYaml);
        diffs['mme'] = diffResult;
      }

      // SGW-U diff
      if (configs.sgwu) {
        const original = configs.sgwu.rawYaml as any;
        const modified = JSON.parse(JSON.stringify(original));

        if (!modified.sgwu) modified.sgwu = {};
        if (!modified.sgwu.gtpu) modified.sgwu.gtpu = {};
        modified.sgwu.gtpu.server = [{ address: input.sgwuGtpIP }];

        const originalYaml = yaml.stringify(original);
        const modifiedYaml = yaml.stringify(modified);
        const diffResult = diff.createTwoFilesPatch('sgwu.yaml', 'sgwu.yaml', originalYaml, modifiedYaml);
        diffs['sgwu'] = diffResult;
      }

      // AMF diff
      if (configs.amf) {
        const original = configs.amf.rawYaml as any;
        const modified = JSON.parse(JSON.stringify(original));

        if (!modified.amf) modified.amf = {};
        if (!modified.amf.ngap) modified.amf.ngap = {};
        modified.amf.ngap.server = [{ address: input.amfNgapIP }];

        // Update GUAMI with multiple PLMNs
        modified.amf.guami = input.plmn5g.map(plmn => ({
          plmn_id: { mcc: plmn.mcc, mnc: plmn.mnc },
          amf_id: {
            region: 2,
            set: 1,
          },
        }));

        // Update TAI with multiple PLMNs
        modified.amf.tai = input.plmn5g.map(plmn => ({
          plmn_id: { mcc: plmn.mcc, mnc: plmn.mnc },
          tac: plmn.tac ?? 1,
        }));

        // Update plmn_support with multiple PLMNs
        modified.amf.plmn_support = input.plmn5g.map(plmn => ({
          plmn_id: { mcc: plmn.mcc, mnc: plmn.mnc },
          s_nssai: [{ sst: 1 }],
        }));

        const originalYaml = yaml.stringify(original);
        const modifiedYaml = yaml.stringify(modified);
        const diffResult = diff.createTwoFilesPatch('amf.yaml', 'amf.yaml', originalYaml, modifiedYaml);
        diffs['amf'] = diffResult;
      }

      // UPF diff
      if (configs.upf) {
        const original = configs.upf.rawYaml as any;
        const modified = JSON.parse(JSON.stringify(original));

        if (!modified.upf) modified.upf = {};
        if (!modified.upf.gtpu) modified.upf.gtpu = {};
        modified.upf.gtpu.server = [{ address: input.upfGtpIP }];

        // Update Session pools
        modified.upf.session = [
          {
            subnet: input.sessionPoolIPv4Subnet,
            gateway: input.sessionPoolIPv4Gateway,
          },
          {
            subnet: input.sessionPoolIPv6Subnet,
            gateway: input.sessionPoolIPv6Gateway,
          },
        ];

        const originalYaml = yaml.stringify(original);
        const modifiedYaml = yaml.stringify(modified);
        const diffResult = diff.createTwoFilesPatch('upf.yaml', 'upf.yaml', originalYaml, modifiedYaml);
        diffs['upf'] = diffResult;
      }

      // SMF diff
      if (configs.smf) {
        const original = configs.smf.rawYaml as any;
        const modified = JSON.parse(JSON.stringify(original));

        if (!modified.smf) modified.smf = {};
        
        // Update Session pools
        modified.smf.session = [
          {
            subnet: input.sessionPoolIPv4Subnet,
            gateway: input.sessionPoolIPv4Gateway,
          },
          {
            subnet: input.sessionPoolIPv6Subnet,
            gateway: input.sessionPoolIPv6Gateway,
          },
        ];

        const originalYaml = yaml.stringify(original);
        const modifiedYaml = yaml.stringify(modified);
        const diffResult = diff.createTwoFilesPatch('smf.yaml', 'smf.yaml', originalYaml, modifiedYaml);
        diffs['smf'] = diffResult;
      }

      return {
        success: true,
        diffs,
      };
    } catch (error) {
      this.logger.error({ error }, 'Failed to generate preview');
      return {
        success: false,
        message: `Preview failed: ${error}`,
        diffs: {},
      };
    }
  }

  async execute(input: AutoConfigInput, user: string = 'admin'): Promise<AutoConfigResult> {
    this.logger.info({ input }, 'Starting auto-configuration');

    const updatedFiles: string[] = [];

    try {
      // Step 1: Create backup first
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = `${this.backupPath}/pre-autoconfig-${timestamp}`;
      
      this.logger.info({ backupDir }, 'Creating backup before auto-config');
      await this.hostExecutor.createDirectory(backupDir);
      
      // Backup configs that will be modified
      const filesToBackup = ['mme.yaml', 'sgwu.yaml', 'amf.yaml', 'upf.yaml', 'smf.yaml'];
      for (const file of filesToBackup) {
        const sourcePath = `/etc/open5gs/${file}`;
        const destPath = `${backupDir}/${file}`;
        try {
          await this.hostExecutor.copyFile(sourcePath, destPath);
          this.logger.info({ file }, 'Backed up config file');
        } catch (err) {
          this.logger.warn({ file, error: String(err) }, 'Failed to backup config file');
        }
      }

      // Step 2: Load current configs
      this.logger.info('Loading current configurations');
      const configs = await this.configRepo.loadAll();

      // Step 3: Apply auto-configuration changes by modifying rawYaml

      // Update MME (4G) with multiple PLMNs
      if (configs.mme) {
        this.logger.info({ plmnCount: input.plmn4g.length }, 'Updating MME configuration');
        const raw = configs.mme.rawYaml as any;
        
        if (!raw.mme) raw.mme = {};
        if (!raw.mme.s1ap) raw.mme.s1ap = {};
        raw.mme.s1ap.server = [{ address: input.s1mmeIP }];

        // Update GUMMEI with multiple PLMNs
        raw.mme.gummei = input.plmn4g.map(plmn => ({
          plmn_id: { mcc: plmn.mcc, mnc: plmn.mnc },
          mme_gid: plmn.mme_gid ?? 2,
          mme_code: plmn.mme_code ?? 1,
        }));

        // Update TAI with multiple PLMNs
        raw.mme.tai = input.plmn4g.map(plmn => ({
          plmn_id: { mcc: plmn.mcc, mnc: plmn.mnc },
          tac: plmn.tac ?? 1,
        }));

        configs.mme.rawYaml = raw;
        await this.configRepo.saveMme(configs.mme);
        updatedFiles.push('mme.yaml');
      }

      // Update SGW-U (4G User Plane)
      if (configs.sgwu) {
        this.logger.info('Updating SGW-U configuration');
        const raw = configs.sgwu.rawYaml as any;
        
        if (!raw.sgwu) raw.sgwu = {};
        if (!raw.sgwu.gtpu) raw.sgwu.gtpu = {};
        raw.sgwu.gtpu.server = [{ address: input.sgwuGtpIP }];

        configs.sgwu.rawYaml = raw;
        await this.configRepo.saveSgwu(configs.sgwu);
        updatedFiles.push('sgwu.yaml');
      }

      // Update AMF (5G) with multiple PLMNs
      if (configs.amf) {
        this.logger.info({ plmnCount: input.plmn5g.length }, 'Updating AMF configuration');
        const raw = configs.amf.rawYaml as any;
        
        if (!raw.amf) raw.amf = {};
        if (!raw.amf.ngap) raw.amf.ngap = {};
        raw.amf.ngap.server = [{ address: input.amfNgapIP }];

        // Update GUAMI with multiple PLMNs
        raw.amf.guami = input.plmn5g.map(plmn => ({
          plmn_id: { mcc: plmn.mcc, mnc: plmn.mnc },
          amf_id: {
            region: 2,
            set: 1,
          },
        }));

        // Update TAI with multiple PLMNs
        raw.amf.tai = input.plmn5g.map(plmn => ({
          plmn_id: { mcc: plmn.mcc, mnc: plmn.mnc },
          tac: plmn.tac ?? 1,
        }));

        // Update plmn_support with multiple PLMNs
        raw.amf.plmn_support = input.plmn5g.map(plmn => ({
          plmn_id: { mcc: plmn.mcc, mnc: plmn.mnc },
          s_nssai: [{ sst: 1 }],
        }));

        configs.amf.rawYaml = raw;
        await this.configRepo.saveAmf(configs.amf);
        updatedFiles.push('amf.yaml');
      }

      // Update UPF (5G User Plane)
      if (configs.upf) {
        this.logger.info('Updating UPF configuration');
        const raw = configs.upf.rawYaml as any;
        
        if (!raw.upf) raw.upf = {};
        if (!raw.upf.gtpu) raw.upf.gtpu = {};
        raw.upf.gtpu.server = [{ address: input.upfGtpIP }];

        // Update Session pools
        raw.upf.session = [
          {
            subnet: input.sessionPoolIPv4Subnet,
            gateway: input.sessionPoolIPv4Gateway,
          },
          {
            subnet: input.sessionPoolIPv6Subnet,
            gateway: input.sessionPoolIPv6Gateway,
          },
        ];

        configs.upf.rawYaml = raw;
        await this.configRepo.saveUpf(configs.upf);
        updatedFiles.push('upf.yaml');
      }

      // Update SMF (Session Management)
      if (configs.smf) {
        this.logger.info('Updating SMF configuration');
        const raw = configs.smf.rawYaml as any;
        
        if (!raw.smf) raw.smf = {};
        
        // Update Session pools
        raw.smf.session = [
          {
            subnet: input.sessionPoolIPv4Subnet,
            gateway: input.sessionPoolIPv4Gateway,
          },
          {
            subnet: input.sessionPoolIPv6Subnet,
            gateway: input.sessionPoolIPv6Gateway,
          },
        ];

        configs.smf.rawYaml = raw;
        await this.configRepo.saveSmf(configs.smf);
        updatedFiles.push('smf.yaml');
      }

      // Step 4: Configure NAT if requested
      if (input.configureNAT) {
        this.logger.info('Configuring NAT with iptables');
        const natInterface = input.natInterface || 'ogstun';

        try {
          // Enable IP forwarding
          await this.hostExecutor.executeCommand('sysctl', ['-w', 'net.ipv4.ip_forward=1']);
          await this.hostExecutor.executeCommand('sysctl', ['-w', 'net.ipv6.conf.all.forwarding=1']);
          await this.hostExecutor.executeCommand('sysctl', ['-p', '/etc/sysctl.conf']);
          this.logger.info('Enabled IP forwarding');

          // Configure IPv4 NAT
          await this.hostExecutor.executeCommand('iptables', [
            '-t', 'nat', '-A', 'POSTROUTING',
            '-s', input.sessionPoolIPv4Subnet,
            '!', '-o', natInterface,
            '-j', 'MASQUERADE'
          ]);
          this.logger.info({ subnet: input.sessionPoolIPv4Subnet }, 'Configured IPv4 NAT');

          // Configure IPv6 NAT
          await this.hostExecutor.executeCommand('ip6tables', [
            '-t', 'nat', '-A', 'POSTROUTING',
            '-s', input.sessionPoolIPv6Subnet,
            '!', '-o', natInterface,
            '-j', 'MASQUERADE'
          ]);
          this.logger.info({ subnet: input.sessionPoolIPv6Subnet }, 'Configured IPv6 NAT');

          // Allow traffic from the tunnel interface
          await this.hostExecutor.executeCommand('iptables', [
            '-I', 'INPUT', '-i', natInterface, '-j', 'ACCEPT'
          ]);
          this.logger.info({ interface: natInterface }, 'Allowed traffic from tunnel interface');

        } catch (err) {
          this.logger.error({ error: String(err) }, 'Failed to configure NAT');
          // Don't fail the whole operation if NAT config fails
        }
      }

      // Step 5: Restart services
      this.logger.info('Restarting Open5GS services');
      const servicesToRestart = [
        'open5gs-mmed',
        'open5gs-sgwud',
        'open5gs-amfd',
        'open5gs-upfd',
        'open5gs-smfd',
      ];

      for (const service of servicesToRestart) {
        try {
          await this.hostExecutor.executeCommand('systemctl', ['restart', service]);
          this.logger.info({ service }, 'Restarted service');
        } catch (err) {
          this.logger.warn({ service, error: String(err) }, 'Failed to restart service');
        }
      }

      // Step 6: Log the action
      const plmnSummary = `4G: ${input.plmn4g.map(p => `${p.mcc}/${p.mnc}`).join(', ')} | 5G: ${input.plmn5g.map(p => `${p.mcc}/${p.mnc}`).join(', ')}`;
      await this.auditLogger.log({
        user,
        action: 'config_apply',
        target: 'auto_config',
        details: `Auto-configuration applied: ${plmnSummary}`,
        success: true,
      });

      this.logger.info({ backupDir, updatedFiles }, 'Auto-configuration completed successfully');

      return {
        success: true,
        message: 'Auto-configuration applied successfully. Services restarted.',
        backupCreated: backupDir,
        updatedFiles,
      };

    } catch (error) {
      this.logger.error({ error }, 'Auto-configuration failed');
      
      await this.auditLogger.log({
        user,
        action: 'config_apply',
        target: 'auto_config',
        details: `Auto-configuration failed: ${error}`,
        success: false,
      });

      return {
        success: false,
        message: `Auto-configuration failed: ${error}`,
        updatedFiles,
        errors: [String(error)],
      };
    }
  }
}
