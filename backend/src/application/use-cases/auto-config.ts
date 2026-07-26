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
  // Per-card apply toggles — each defaults to true (applied) when omitted, so
  // existing callers that don't set these keep today's "apply everything"
  // behavior. NAT already had its own toggle (configureNAT); these extend the
  // same idea to the other cards on the page.
  applyPlmn?: boolean;          // 📡 Network Identity
  applyInterfaces?: boolean;    // 🌐 Network Interfaces
  applyPfcp?: boolean;          // 🔗 UPF PFCP Addressing
  applySessionPools?: boolean;  // 📶 UE IP Address Pool

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
  // When true, SMF and UPF use default loopback addresses (127.0.0.x).
  // Hides the PFCP IP fields — no manual addressing required.
  // Automatically set to false if any non-loopback UPF address is detected.
  localUpfOnly?: boolean;
  // SGW-C / SGW-U PFCP addressing (4G)
  // When true, SGW-C and SGW-U use default loopback addresses (127.0.0.3 / 127.0.0.6).
  localSgwuOnly?: boolean;
  // SGW-C PFCP server address — must be routable from remote SGW-U site
  sgwcPfcpIP?: string;
  // Remote SGW-U entries — each has a PFCP address and optional TAC list for selection
  remoteSgwus?: Array<{
    pfcpIP: string;     // remote SGW-U PFCP address
    gtpuIP: string;     // remote SGW-U GTP-U address (eNodeBs point S1-U here)
    tac?: number[];     // optional TAC list for SGW-U selection by eNodeB TAC
    label?: string;     // optional site label
  }>;
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


// ── Helper: build a deduplicated PFCP server list ──────────────────────────
// Merges existing servers with a new address, ensuring no duplicate IPs.
// When newAddress is a loopback and replaceAll is true, wipes the list first.
function mergePfcpServers(
  existing: Array<{ address: string }>,
  newAddress: string,
  replaceAll = false,
): Array<{ address: string }> {
  if (!newAddress) return existing;
  if (replaceAll) return [{ address: newAddress }];
  const deduped = existing.filter(
    (s, i, arr) => arr.findIndex(x => x.address === s.address) === i  // remove self-duplicates
  );
  const alreadyPresent = deduped.some(s => s.address === newAddress);
  return alreadyPresent ? deduped : [...deduped, { address: newAddress }];
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

      const applyPlmn = input.applyPlmn ?? true;
      const applyInterfaces = input.applyInterfaces ?? true;
      const applySessionPools = input.applySessionPools ?? true;

      // MME diff
      if (configs.mme && (applyPlmn || applyInterfaces)) {
        const original = configs.mme.rawYaml as any;
        const modified = JSON.parse(JSON.stringify(original)); // Deep clone

        // Apply MME changes to rawYaml structure
        if (!modified.mme) modified.mme = {};

        if (applyInterfaces) {
          if (!modified.mme.s1ap) modified.mme.s1ap = {};
          // Use dev: if provided, otherwise address:
          if (input.s1mmeDev) {
            modified.mme.s1ap.server = [{ dev: input.s1mmeDev }];
          } else if (input.s1mmeIP) {
            modified.mme.s1ap.server = [{ address: input.s1mmeIP }];
          }
        }

        if (applyPlmn) {
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
        }

        const originalYaml = yaml.stringify(original);
        const modifiedYaml = yaml.stringify(modified);
        const diffResult = diff.createTwoFilesPatch('mme.yaml', 'mme.yaml', originalYaml, modifiedYaml);
        diffs['mme'] = diffResult;
      }

      // SGW-U diff
      if (configs.sgwu && applyInterfaces) {
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
      if (configs.amf && (applyPlmn || applyInterfaces)) {
        const original = configs.amf.rawYaml as any;
        const modified = JSON.parse(JSON.stringify(original));

        if (!modified.amf) modified.amf = {};

        if (applyInterfaces) {
          if (!modified.amf.ngap) modified.amf.ngap = {};
          // Use dev: if provided, otherwise address:
          if (input.amfNgapDev) {
            modified.amf.ngap.server = [{ dev: input.amfNgapDev }];
          } else if (input.amfNgapIP) {
            modified.amf.ngap.server = [{ address: input.amfNgapIP }];
          }
        }

        if (applyPlmn) {
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
        }

        const originalYaml = yaml.stringify(original);
        const modifiedYaml = yaml.stringify(modified);
        const diffResult = diff.createTwoFilesPatch('amf.yaml', 'amf.yaml', originalYaml, modifiedYaml);
        diffs['amf'] = diffResult;
      }

      // UPF diff
      if (configs.upf && (applyInterfaces || applySessionPools)) {
        const original = configs.upf.rawYaml as any;
        const modified = JSON.parse(JSON.stringify(original));

        if (!modified.upf) modified.upf = {};

        if (applyInterfaces) {
          if (!modified.upf.gtpu) modified.upf.gtpu = {};
          modified.upf.gtpu.server = [{ address: input.upfGtpIP }];
        }

        if (applySessionPools) {
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
        }

        const originalYaml = yaml.stringify(original);
        const modifiedYaml = yaml.stringify(modified);
        const diffResult = diff.createTwoFilesPatch('upf.yaml', 'upf.yaml', originalYaml, modifiedYaml);
        diffs['upf'] = diffResult;
      }

      // SMF diff
      if (configs.smf && applySessionPools) {
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
      const filesToBackup = ['mme.yaml', 'sgwu.yaml', 'sgwc.yaml', 'amf.yaml', 'upf.yaml', 'smf.yaml'];
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
      const applyPlmn = input.applyPlmn ?? true;
      const applyInterfaces = input.applyInterfaces ?? true;
      const applyPfcp = input.applyPfcp ?? true;
      const applySessionPools = input.applySessionPools ?? true;

      // Update MME (4G) with multiple PLMNs
      if (configs.mme && (applyPlmn || applyInterfaces)) {
        this.logger.info({ plmnCount: input.plmn4g.length }, 'Updating MME configuration');
        const raw = configs.mme.rawYaml as any;

        if (!raw.mme) raw.mme = {};

        if (applyInterfaces) {
          if (!raw.mme.s1ap) raw.mme.s1ap = {};
          // Use dev: if provided, otherwise address:
          if (input.s1mmeDev) {
            raw.mme.s1ap.server = [{ dev: input.s1mmeDev }];
          } else if (input.s1mmeIP) {
            raw.mme.s1ap.server = [{ address: input.s1mmeIP }];
          }
        }

        if (applyPlmn) {
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
        }

        configs.mme.rawYaml = raw;
        await this.configRepo.saveMme(configs.mme);
        updatedFiles.push('mme.yaml');
      }

      // Update SGW-U (4G User Plane)
      if (configs.sgwu && applyInterfaces) {
        this.logger.info('Updating SGW-U configuration');
        const raw = configs.sgwu.rawYaml as any;

        if (!raw.sgwu) raw.sgwu = {};
        if (!raw.sgwu.gtpu) raw.sgwu.gtpu = {};
        raw.sgwu.gtpu.server = [{ address: input.sgwuGtpIP }];

        configs.sgwu.rawYaml = raw;
        await this.configRepo.saveSgwu(configs.sgwu);
        updatedFiles.push('sgwu.yaml');
      }

      // Update SGW-C PFCP (4G control plane for SGW-U)
      if (configs.sgwc && applyPfcp) {
        this.logger.info('Updating SGW-C PFCP configuration');
        const raw = configs.sgwc.rawYaml as any;
        if (!raw.sgwc) raw.sgwc = {};
        if (!raw.sgwc.pfcp) raw.sgwc.pfcp = {};

        const localSgwuOnly = input.localSgwuOnly ?? true;

        // SGW-C PFCP server address
        const sgwcPfcpAddr = localSgwuOnly ? '127.0.0.3' : (input.sgwcPfcpIP || '127.0.0.3');
        raw.sgwc.pfcp.server = mergePfcpServers(
          raw.sgwc.pfcp.server || [],
          sgwcPfcpAddr,
          true,  // always replace — SGW-C only ever has one PFCP server address
        );

        // SGW-C PFCP client — local SGW-U always present, remote entries appended
        const sgwuClients: any[] = [{ address: '127.0.0.6' }];
        if (!localSgwuOnly && input.remoteSgwus?.length) {
          for (const remote of input.remoteSgwus) {
            if (!remote.pfcpIP) continue;
            const entry: any = { address: remote.pfcpIP };
            if (remote.tac?.length) entry.tac = remote.tac.length === 1 ? remote.tac[0] : remote.tac;
            sgwuClients.push(entry);
          }
        }
        raw.sgwc.pfcp.client = { sgwu: sgwuClients };
        this.logger.info({ sgwcPfcpAddr, localSgwuOnly, sgwuCount: sgwuClients.length }, 'Updated SGW-C PFCP');

        configs.sgwc.rawYaml = raw;
        await this.configRepo.saveSgwc(configs.sgwc);
        updatedFiles.push('sgwc.yaml');
      }

      // Update local SGW-U PFCP server address
      if (configs.sgwu && applyPfcp) {
        const raw = configs.sgwu.rawYaml as any;
        if (!raw.sgwu) raw.sgwu = {};
        if (!raw.sgwu.pfcp) raw.sgwu.pfcp = {};
        const localSgwuOnly = input.localSgwuOnly ?? true;
        raw.sgwu.pfcp.server = [{ address: localSgwuOnly ? '127.0.0.6' : '127.0.0.6' }];
        // SGW-U also needs to know the SGW-C address if remote
        if (!localSgwuOnly && input.sgwcPfcpIP) {
          raw.sgwu.pfcp.client = { sgwc: [{ address: input.sgwcPfcpIP }] };
        }
        configs.sgwu.rawYaml = raw;
        await this.configRepo.saveSgwu(configs.sgwu);
        if (!updatedFiles.includes('sgwu.yaml')) updatedFiles.push('sgwu.yaml');
      }

      // Update AMF (5G) with multiple PLMNs
      if (configs.amf && (applyPlmn || applyInterfaces)) {
        this.logger.info({ plmnCount: input.plmn5g.length }, 'Updating AMF configuration');
        const raw = configs.amf.rawYaml as any;

        if (!raw.amf) raw.amf = {};

        if (applyInterfaces) {
          if (!raw.amf.ngap) raw.amf.ngap = {};
          // Use dev: if provided, otherwise address:
          if (input.amfNgapDev) {
            raw.amf.ngap.server = [{ dev: input.amfNgapDev }];
          } else if (input.amfNgapIP) {
            raw.amf.ngap.server = [{ address: input.amfNgapIP }];
          }
        }

        if (applyPlmn) {
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
        }

        configs.amf.rawYaml = raw;
        await this.configRepo.saveAmf(configs.amf);
        updatedFiles.push('amf.yaml');
      }

      // Update UPF (5G User Plane)
      if (configs.upf && (applyInterfaces || applyPfcp || applySessionPools)) {
        this.logger.info('Updating UPF configuration');
        const raw = configs.upf.rawYaml as any;

        if (!raw.upf) raw.upf = {};

        if (applyInterfaces) {
          if (!raw.upf.gtpu) raw.upf.gtpu = {};
          raw.upf.gtpu.server = [{ address: input.upfGtpIP }];
        }

        if (applyPfcp) {
          // Update PFCP server address
          // If localUpfOnly, use default loopback — no manual IP needed
          const upfPfcpAddr = input.localUpfOnly ? '127.0.0.7' : input.localUpfPfcpIP;
          if (upfPfcpAddr) {
            if (!raw.upf.pfcp) raw.upf.pfcp = {};
            raw.upf.pfcp.server = mergePfcpServers(
              raw.upf.pfcp.server || [],
              upfPfcpAddr,
              true,  // UPF only ever has one PFCP server address
            );
            this.logger.info({ upfPfcpAddr, localUpfOnly: input.localUpfOnly }, 'Set UPF PFCP address');
          }
        }

        if (applySessionPools) {
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
        }

        configs.upf.rawYaml = raw;
        await this.configRepo.saveUpf(configs.upf);
        updatedFiles.push('upf.yaml');
      }

      // Update SMF (Session Management)
      if (configs.smf && (applyPfcp || applySessionPools)) {
        this.logger.info('Updating SMF configuration');
        const raw = configs.smf.rawYaml as any;

        if (!raw.smf) raw.smf = {};

        if (applyPfcp) {
          // Update PFCP server and client addresses
          // If localUpfOnly, use default loopbacks — SMF on 127.0.0.4, UPF on 127.0.0.7
          const smfPfcpAddr   = input.localUpfOnly ? '127.0.0.4' : input.smfPfcpIP;
          const localUpfAddr  = input.localUpfOnly ? '127.0.0.7' : input.localUpfPfcpIP;

          if (smfPfcpAddr) {
            if (!raw.smf.pfcp) raw.smf.pfcp = {};
            // replaceAll=true when local-only: wipes any existing duplicates and sets exactly one loopback entry
            raw.smf.pfcp.server = mergePfcpServers(
              raw.smf.pfcp.server || [],
              smfPfcpAddr,
              input.localUpfOnly === true,  // replace entire list when local-only
            );
            this.logger.info({ smfPfcpAddr, localUpfOnly: input.localUpfOnly, servers: raw.smf.pfcp.server }, 'Set SMF PFCP server address');
          }

          if (localUpfAddr) {
            if (!raw.smf.pfcp) raw.smf.pfcp = {};
            if (!raw.smf.pfcp.client) raw.smf.pfcp.client = {};
            if (input.localUpfOnly) {
              // Loopback only — single local UPF entry, remove any remote UPFs
              raw.smf.pfcp.client.upf = [{ address: localUpfAddr }];
            } else {
              // Keep existing remote UPFs, update local entry
              const existingUpfs: Array<{address: string}> = raw.smf.pfcp.client.upf || [];
              const remoteUpfs = existingUpfs.filter(u => !u.address.startsWith('127.') && u.address !== localUpfAddr);
              raw.smf.pfcp.client.upf = [{ address: localUpfAddr }, ...remoteUpfs];
            }
            this.logger.info({ localUpfAddr, localUpfOnly: input.localUpfOnly }, 'Updated SMF UPF client list');
          }
        }

        if (applySessionPools) {
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
        }

        configs.smf.rawYaml = raw;
        await this.configRepo.saveSmf(configs.smf);
        updatedFiles.push('smf.yaml');
      }

      // Dedup — a file can be pushed from more than one section above
      // (e.g. sgwu.yaml from both the Interfaces and PFCP sections).
      const dedupedFiles = [...new Set(updatedFiles)];

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
            'net.ipv6.conf.default.forwarding=1',
          ].join('\n') + '\n';

          // /etc/sysctl.d/ isn't bind-mounted into this container (unlike
          // /etc/open5gs) — writeFile needs the /proc/1/root host-path
          // prefix. executeCommand doesn't (nsenter already puts it in the
          // host's own mount namespace, where the plain path is correct).
          await this.hostExecutor.writeFile('/proc/1/root/etc/sysctl.d/99-open5gs-nat.conf', sysctlContent);
          await this.hostExecutor.executeCommand('sysctl', ['-p', '/etc/sysctl.d/99-open5gs-nat.conf']);
          this.logger.info('Enabled IP forwarding (persistent via /etc/sysctl.d/99-open5gs-nat.conf)');

          // ── iptables rules ─────────────────────────────────────────────────
          // Sourced from the same session pool subnets shown in the "UE IP
          // Address Pool" card above, so NAT always matches whatever pool is
          // actually configured rather than a separate, possibly-stale value.
          const ipv4Subnet = input.sessionPools?.[0]?.subnet || input.sessionPoolIPv4Subnet || '10.45.0.0/16';
          const ipv6Subnet = input.sessionPools?.[1]?.subnet || input.sessionPoolIPv6Subnet || '2001:db8:cafe::/48';

          // Each rule is added idempotently (-C check before -A/-I add) so
          // re-running Apply Config with NAT enabled doesn't pile up
          // duplicate MASQUERADE/ACCEPT rules every time.
          const ensureRule = async (bin: string, checkArgs: string[], addArgs: string[], label: string) => {
            const check = await this.hostExecutor.executeCommand(bin, checkArgs);
            if (check.exitCode !== 0) {
              await this.hostExecutor.executeCommand(bin, addArgs);
              this.logger.info({ label }, 'Added firewall rule');
            }
          };

          // IPv4 MASQUERADE
          await ensureRule(
            'iptables',
            ['-t', 'nat', '-C', 'POSTROUTING', '-s', ipv4Subnet, '!', '-o', natInterface, '-j', 'MASQUERADE'],
            ['-t', 'nat', '-A', 'POSTROUTING', '-s', ipv4Subnet, '!', '-o', natInterface, '-j', 'MASQUERADE'],
            'IPv4 NAT',
          );

          // IPv6 MASQUERADE
          await ensureRule(
            'ip6tables',
            ['-t', 'nat', '-C', 'POSTROUTING', '-s', ipv6Subnet, '!', '-o', natInterface, '-j', 'MASQUERADE'],
            ['-t', 'nat', '-A', 'POSTROUTING', '-s', ipv6Subnet, '!', '-o', natInterface, '-j', 'MASQUERADE'],
            'IPv6 NAT',
          );

          // Allow inbound from tunnel interface (both address families)
          await ensureRule(
            'iptables',
            ['-C', 'INPUT', '-i', natInterface, '-j', 'ACCEPT'],
            ['-I', 'INPUT', '-i', natInterface, '-j', 'ACCEPT'],
            'IPv4 tunnel INPUT accept',
          );
          await ensureRule(
            'ip6tables',
            ['-C', 'INPUT', '-i', natInterface, '-j', 'ACCEPT'],
            ['-I', 'INPUT', '-i', natInterface, '-j', 'ACCEPT'],
            'IPv6 tunnel INPUT accept',
          );

          this.logger.info({ ipv4Subnet, ipv6Subnet, natInterface }, 'Configured NAT (IPv4 + IPv6)');

          // ── Persist iptables rules across reboots ─────────────────────────
          // Requires iptables-persistent / netfilter-persistent (installed as prerequisite)
          await this.hostExecutor.executeCommand('netfilter-persistent', ['save']);
          this.logger.info('iptables rules saved (will survive reboot via netfilter-persistent)');

        } catch (err) {
          this.logger.error({ error: String(err) }, 'Failed to configure NAT');
          // Don't fail the whole operation if NAT config fails
        }
      }

      // Step 5: Restart services — only ones whose config file was actually
      // touched, so unchecking a card doesn't force an unrelated NF restart
      // (e.g. NAT-only changes need zero NF restarts at all).
      const FILE_TO_SERVICE: Record<string, string> = {
        'mme.yaml': 'open5gs-mmed',
        'sgwc.yaml': 'open5gs-sgwcd',
        'sgwu.yaml': 'open5gs-sgwud',
        'amf.yaml': 'open5gs-amfd',
        'upf.yaml': 'open5gs-upfd',
        'smf.yaml': 'open5gs-smfd',
      };
      const servicesToRestart = dedupedFiles
        .map(f => FILE_TO_SERVICE[f])
        .filter((s): s is string => Boolean(s));

      this.logger.info({ servicesToRestart }, 'Restarting Open5GS services');
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

      this.logger.info({ backupDir, updatedFiles: dedupedFiles }, 'Auto-configuration completed successfully');

      return {
        success: true,
        message: servicesToRestart.length > 0
          ? `Auto-configuration applied successfully. Restarted: ${servicesToRestart.join(', ')}.`
          : 'Auto-configuration applied successfully. No NF restart was needed for the selected steps.',
        backupCreated: backupDir,
        updatedFiles: dedupedFiles,
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
