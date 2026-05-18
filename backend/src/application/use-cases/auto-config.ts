import pino from 'pino';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';

export interface PlmnConfig {
  mcc: string;
  mnc: string;
  mme_gid?: number;
  mme_code?: number;
  tac?: number;
}

// A single UPF/SMF session pool entry
export interface SessionPool {
  subnet: string;
  gateway?: string;
  dnn?: string;   // optional — ties pool to specific DNN/APN
  dev?: string;   // optional — specific TUN interface name (e.g. ogstun2)
}

export interface AutoConfigInput {
  plmn4g: PlmnConfig[];
  plmn5g: PlmnConfig[];
  // 4G S1AP — either IP or interface name, not both
  s1mmeIP?: string;
  s1mmeDev?: string;   // dev: eth0 — binds S1AP to interface instead of IP
  // 4G User Plane
  sgwuGtpIP: string;
  // 5G NGAP — either IP or interface name, not both
  amfNgapIP?: string;
  amfNgapDev?: string; // dev: eth0 — binds NGAP to interface instead of IP
  // 5G User Plane
  upfGtpIP: string;
  smfPfcpIP?: string;
  localUpfPfcpIP?: string;
  // Session pools — supports multiple entries with dnn and dev
  sessionPools: SessionPool[];
  // Legacy flat fields kept for backwards compatibility with existing frontend
  sessionPoolIPv4Subnet?: string;
  sessionPoolIPv4Gateway?: string;
  sessionPoolIPv6Subnet?: string;
  sessionPoolIPv6Gateway?: string;
  configureNAT: boolean;
  natInterface?: string;
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
        // Use dev: if provided, otherwise address:
        if (input.s1mmeDev) {
          modified.mme.s1ap.server = [{ dev: input.s1mmeDev }];
        } else if (input.s1mmeIP) {
          modified.mme.s1ap.server = [{ address: input.s1mmeIP }];
        }

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
        // Use dev: if provided, otherwise address:
        if (input.amfNgapDev) {
          modified.amf.ngap.server = [{ dev: input.amfNgapDev }];
        } else if (input.amfNgapIP) {
          modified.amf.ngap.server = [{ address: input.amfNgapIP }];
        }

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

        // Update Session pools — support dnn and dev fields
        const pools = input.sessionPools?.length ? input.sessionPools : [
          { subnet: input.sessionPoolIPv4Subnet || '', gateway: input.sessionPoolIPv4Gateway || '', dnn: '', dev: '' },
          { subnet: input.sessionPoolIPv6Subnet || '', gateway: input.sessionPoolIPv6Gateway || '', dnn: '', dev: '' },
        ].filter(p => p.subnet);
        modified.upf.session = pools.map(p => {
          const entry: any = { subnet: p.subnet };
          if (p.gateway) entry.gateway = p.gateway;
          if (p.dnn)     entry.dnn     = p.dnn;
          if (p.dev)     entry.dev     = p.dev;
          return entry;
        });

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
        
        // Update Session pools — support dnn and dev fields
        const smfPools = input.sessionPools?.length ? input.sessionPools : [
          { subnet: input.sessionPoolIPv4Subnet || '', gateway: input.sessionPoolIPv4Gateway || '', dnn: '', dev: '' },
          { subnet: input.sessionPoolIPv6Subnet || '', gateway: input.sessionPoolIPv6Gateway || '', dnn: '', dev: '' },
        ].filter(p => p.subnet);
        modified.smf.session = smfPools.map(p => {
          const entry: any = { subnet: p.subnet };
          if (p.gateway) entry.gateway = p.gateway;
          if (p.dnn)     entry.dnn     = p.dnn;
          if (p.dev)     entry.dev     = p.dev;
          return entry;
        });

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
        // Use dev: if provided, otherwise address:
        if (input.s1mmeDev) {
          raw.mme.s1ap.server = [{ dev: input.s1mmeDev }];
        } else if (input.s1mmeIP) {
          raw.mme.s1ap.server = [{ address: input.s1mmeIP }];
        }

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
        // Use dev: if provided, otherwise address:
        if (input.amfNgapDev) {
          raw.amf.ngap.server = [{ dev: input.amfNgapDev }];
        } else if (input.amfNgapIP) {
          raw.amf.ngap.server = [{ address: input.amfNgapIP }];
        }

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

        // Update PFCP server address if provided
        if (input.localUpfPfcpIP) {
          if (!raw.upf.pfcp) raw.upf.pfcp = {};
          raw.upf.pfcp.server = [{ address: input.localUpfPfcpIP }];
          this.logger.info({ localUpfPfcpIP: input.localUpfPfcpIP }, 'Set local UPF PFCP address');
        }

        // Update Session pools — support multiple entries with dnn and dev
        const execPools = input.sessionPools?.length ? input.sessionPools : [
          { subnet: input.sessionPoolIPv4Subnet || '', gateway: input.sessionPoolIPv4Gateway || '', dnn: '', dev: '' },
          { subnet: input.sessionPoolIPv6Subnet || '', gateway: input.sessionPoolIPv6Gateway || '', dnn: '', dev: '' },
        ].filter((p: any) => p.subnet);
        raw.upf.session = execPools.map(p => {
          const entry: any = { subnet: p.subnet };
          if (p.gateway) entry.gateway = p.gateway;
          if (p.dnn)     entry.dnn     = p.dnn;
          if (p.dev)     entry.dev     = p.dev;
          return entry;
        });

        configs.upf.rawYaml = raw;
        await this.configRepo.saveUpf(configs.upf);
        updatedFiles.push('upf.yaml');
      }

      // Update SMF (Session Management)
      if (configs.smf) {
        this.logger.info('Updating SMF configuration');
        const raw = configs.smf.rawYaml as any;
        
        if (!raw.smf) raw.smf = {};

        // Update PFCP server and client if provided
        if (input.smfPfcpIP) {
          if (!raw.smf.pfcp) raw.smf.pfcp = {};
          // Keep loopback + add routable address
          const existingServers: Array<{address: string}> = raw.smf.pfcp.server || [];
          const loopbacks = existingServers.filter(s => s.address.startsWith('127.'));
          raw.smf.pfcp.server = [...loopbacks, { address: input.smfPfcpIP }];
          this.logger.info({ smfPfcpIP: input.smfPfcpIP }, 'Set SMF PFCP server address');
        }

        if (input.localUpfPfcpIP) {
          if (!raw.smf.pfcp) raw.smf.pfcp = {};
          if (!raw.smf.pfcp.client) raw.smf.pfcp.client = {};
          // Keep existing remote UPFs, update first (local) entry
          const existingUpfs: Array<{address: string}> = raw.smf.pfcp.client.upf || [];
          const remoteUpfs = existingUpfs.filter(u => !u.address.startsWith('127.') && u.address !== input.localUpfPfcpIP);
          raw.smf.pfcp.client.upf = [{ address: input.localUpfPfcpIP }, ...remoteUpfs];
          this.logger.info({ localUpfPfcpIP: input.localUpfPfcpIP }, 'Updated SMF UPF client list');
        }
        
        // Build session pools — DNN-specific pools first, then default (no-DNN) pools
        const execSmfPools = input.sessionPools?.length ? input.sessionPools : [
          { subnet: input.sessionPoolIPv4Subnet || '', gateway: input.sessionPoolIPv4Gateway || '', dnn: '', dev: '' },
          { subnet: input.sessionPoolIPv6Subnet || '', gateway: input.sessionPoolIPv6Gateway || '', dnn: '', dev: '' },
        ].filter((p: any) => p.subnet);
        const smfNewPools = execSmfPools.map((p: any) => {
          const entry: any = { subnet: p.subnet };
          if (p.gateway) entry.gateway = p.gateway;
          if (p.dnn)     entry.dnn     = p.dnn;
          if (p.dev)     entry.dev     = p.dev;
          return entry;
        });
        raw.smf.session = [
          ...smfNewPools.filter((p: any) => p.dnn),
          ...smfNewPools.filter((p: any) => !p.dnn),
        ];

        configs.smf.rawYaml = raw;
        await this.configRepo.saveSmf(configs.smf);
        updatedFiles.push('smf.yaml');
      }

      // Step 4: Configure NAT if requested
      if (input.configureNAT) {
        this.logger.info('Configuring NAT with iptables (persistent)');
        const natInterface = input.natInterface || 'ogstun';

        try {
          // ── IP forwarding ─────────────────────────────────────────────────
          // Write to sysctl.d so it persists across reboots
          const sysctlContent = [
            '# Open5GS UE internet access — written by NMS auto-config',
            'net.ipv4.ip_forward=1',
            'net.ipv6.conf.all.forwarding=1',
          ].join('\n') + '\n';

          await this.hostExecutor.writeFile('/etc/sysctl.d/99-open5gs-nat.conf', sysctlContent);
          await this.hostExecutor.executeCommand('sysctl', ['-p', '/etc/sysctl.d/99-open5gs-nat.conf']);
          this.logger.info('Enabled IP forwarding (persistent via /etc/sysctl.d/99-open5gs-nat.conf)');

          // ── iptables rules ─────────────────────────────────────────────────
          const ipv4Subnet = input.sessionPools?.[0]?.subnet || input.sessionPoolIPv4Subnet || '10.45.0.0/16';
          const ipv6Subnet = input.sessionPools?.[1]?.subnet || input.sessionPoolIPv6Subnet || '2001:db8:cafe::/48';

          // IPv4 MASQUERADE
          await this.hostExecutor.executeCommand('iptables', [
            '-t', 'nat', '-A', 'POSTROUTING',
            '-s', ipv4Subnet,
            '!', '-o', natInterface,
            '-j', 'MASQUERADE',
          ]);
          this.logger.info({ subnet: ipv4Subnet }, 'Configured IPv4 NAT');

          // IPv6 MASQUERADE
          await this.hostExecutor.executeCommand('ip6tables', [
            '-t', 'nat', '-A', 'POSTROUTING',
            '-s', ipv6Subnet,
            '!', '-o', natInterface,
            '-j', 'MASQUERADE',
          ]);
          this.logger.info({ subnet: ipv6Subnet }, 'Configured IPv6 NAT');

          // Allow inbound from tunnel interface
          await this.hostExecutor.executeCommand('iptables', [
            '-I', 'INPUT', '-i', natInterface, '-j', 'ACCEPT',
          ]);
          this.logger.info({ interface: natInterface }, 'Allowed traffic from tunnel interface');

          // ── Persist iptables rules across reboots ─────────────────────────
          // Requires iptables-persistent / netfilter-persistent (installed as prerequisite)
          await this.hostExecutor.executeCommand('netfilter-persistent', ['save']);
          this.logger.info('iptables rules saved (will survive reboot via netfilter-persistent)');

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
