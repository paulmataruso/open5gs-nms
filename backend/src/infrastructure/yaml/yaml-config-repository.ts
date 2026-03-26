import * as yaml from 'js-yaml';
import { IConfigRepository, AllConfigs } from '../../domain/interfaces/config-repository';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { NrfConfig } from '../../domain/entities/nrf-config';
import { AmfConfig } from '../../domain/entities/amf-config';
import { SmfConfig } from '../../domain/entities/smf-config';
import { UpfConfig } from '../../domain/entities/upf-config';
import { AusfConfig } from '../../domain/entities/ausf-config';
import { GenericServiceConfig } from '../../domain/entities/generic-config';
import pino from 'pino';

interface RawYamlDoc {
  [key: string]: unknown;
}

export class YamlConfigRepository implements IConfigRepository {
  private rawCache: Record<string, RawYamlDoc> = {};

  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly configPath: string,
    private readonly logger: pino.Logger,
  ) {}

  async loadNrf(): Promise<NrfConfig> {
    const raw = await this.loadRaw('nrf');
    const nrf = (raw.nrf || {}) as Record<string, unknown>;
    return {
      sbi: this.parseSbi(nrf.sbi),
      logger: this.parseLogger(raw.logger),
      rawYaml: raw,
    };
  }

  async loadAmf(): Promise<AmfConfig> {
    const raw = await this.loadRaw('amf');
    const amf = (raw.amf || {}) as Record<string, unknown>;
    return {
      sbi: this.parseSbi(amf.sbi),
      ngap: this.parseAddrPort(amf.ngap),
      guami: (amf.guami || []) as AmfConfig['guami'],
      tai: (amf.tai || []) as AmfConfig['tai'],
      plmn_support: (amf.plmn_support || []) as AmfConfig['plmn_support'],
      security: amf.security as AmfConfig['security'],
      network_name: amf.network_name as AmfConfig['network_name'],
      amf_name: amf.amf_name as string | undefined,
      nrf: this.parseNrfRef(raw.nrf),
      logger: this.parseLogger(raw.logger),
      rawYaml: raw,
    };
  }

  async loadSmf(): Promise<SmfConfig> {
    const raw = await this.loadRaw('smf');
    const smf = (raw.smf || {}) as Record<string, unknown>;
    return {
      sbi: this.parseSbi(smf.sbi),
      pfcp: this.parsePfcp(smf.pfcp),
      gtpc: smf.gtpc ? { addr: this.resolveAddr((smf.gtpc as Record<string, unknown>).addr) } : undefined,
      gtpu: smf.gtpu ? this.parseGtpu(smf.gtpu) : undefined,
      session: smf.session as SmfConfig['session'],
      dns: smf.dns as string[] | undefined,
      mtu: smf.mtu as number | undefined,
      freeDiameter: smf.freeDiameter as string | undefined,
      info: smf.info as SmfConfig['info'],
      nrf: this.parseNrfRef(raw.nrf),
      logger: this.parseLogger(raw.logger),
      rawYaml: raw,
    };
  }

  async loadUpf(): Promise<UpfConfig> {
    const raw = await this.loadRaw('upf');
    const upf = (raw.upf || {}) as Record<string, unknown>;
    return {
      pfcp: this.parsePfcp(upf.pfcp),
      gtpu: this.parseGtpu(upf.gtpu),
      session: upf.session as UpfConfig['session'],
      logger: this.parseLogger(raw.logger),
      rawYaml: raw,
    };
  }

  async loadAusf(): Promise<AusfConfig> {
    const raw = await this.loadRaw('ausf');
    const ausf = (raw.ausf || {}) as Record<string, unknown>;
    return {
      sbi: this.parseSbi(ausf.sbi),
      nrf: this.parseNrfRef(raw.nrf),
      logger: this.parseLogger(raw.logger),
      rawYaml: raw,
    };
  }

  async loadGeneric(service: string): Promise<GenericServiceConfig> {
    const raw = await this.loadRaw(service);
    const serviceSection = (raw[service] || {}) as Record<string, unknown>;
    return {
      sbi: serviceSection.sbi ? this.parseSbi(serviceSection.sbi) : undefined,
      pfcp: serviceSection.pfcp ? this.parsePfcp(serviceSection.pfcp) : undefined,
      gtpu: serviceSection.gtpu ? this.parseGtpu(serviceSection.gtpu) : undefined,
      gtpc: serviceSection.gtpc ? { addr: this.resolveAddr((serviceSection.gtpc as Record<string, unknown>).addr) } : undefined,
      ngap: serviceSection.ngap ? this.parseAddrPort(serviceSection.ngap) : undefined,
      nrf: this.parseNrfRef(raw.nrf),
      logger: this.parseLogger(raw.logger),
      rawYaml: raw,
    };
  }

  async loadAll(): Promise<AllConfigs> {
    this.logger.info('Loading all configurations from /etc/open5gs');
    const [nrf, amf, smf, upf, ausf] = await Promise.all([
      this.loadNrf(),
      this.loadAmf(),
      this.loadSmf(),
      this.loadUpf(),
      this.loadAusf(),
    ]);
    
    const optionalServices = ['scp', 'udm', 'udr', 'pcf', 'nssf', 'bsf', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu'];
    const optional: Partial<AllConfigs> = {};
    
    for (const service of optionalServices) {
      try {
        const config = await this.loadGeneric(service);
        (optional as any)[service] = config;
      } catch (err) {
        this.logger.debug({ service }, 'Optional service config not found');
      }
    }
    
    return { nrf, amf, smf, upf, ausf, ...optional };
  }

  async saveNrf(config: NrfConfig): Promise<void> {
    // Just save the raw YAML as-is from the frontend
    const raw = config.rawYaml as any;
    await this.saveRaw('nrf', raw);
  }

  async saveAmf(config: AmfConfig): Promise<void> {
    // Just save the raw YAML as-is from the frontend
    const raw = config.rawYaml as any;
    await this.saveRaw('amf', raw);
  }

  async saveSmf(config: SmfConfig): Promise<void> {
    // Just save the raw YAML as-is from the frontend
    const raw = config.rawYaml as any;
    await this.saveRaw('smf', raw);
  }

  async saveUpf(config: UpfConfig): Promise<void> {
    // Just save the raw YAML as-is from the frontend
    const raw = config.rawYaml as any;
    await this.saveRaw('upf', raw);
  }

  async saveAusf(config: AusfConfig): Promise<void> {
    // Just save the raw YAML as-is from the frontend
    const raw = config.rawYaml as any;
    await this.saveRaw('ausf', raw);
  }

  async saveGeneric(service: string, config: GenericServiceConfig): Promise<void> {
    // Just save the raw YAML as-is from the frontend
    const raw = config.rawYaml as any;
    await this.saveRaw(service, raw);
  }

  async backupAll(backupDir: string): Promise<void> {
    await this.hostExecutor.createDirectory(backupDir);
    const allServices = ['nrf', 'amf', 'smf', 'upf', 'ausf', 'scp', 'udm', 'udr', 'pcf', 'nssf', 'bsf', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu'];
    
    for (const service of allServices) {
      const srcPath = `${this.configPath}/${service}.yaml`;
      const destPath = `${backupDir}/${service}.yaml`;
      const exists = await this.hostExecutor.fileExists(srcPath);
      if (exists) {
        await this.hostExecutor.copyFile(srcPath, destPath);
      }
    }
    this.logger.info({ backupDir }, 'Backup completed');
  }

  async restoreBackup(backupDir: string): Promise<void> {
    const allServices = ['nrf', 'amf', 'smf', 'upf', 'ausf', 'scp', 'udm', 'udr', 'pcf', 'nssf', 'bsf', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu'];
    
    for (const service of allServices) {
      const srcPath = `${backupDir}/${service}.yaml`;
      const destPath = `${this.configPath}/${service}.yaml`;
      const exists = await this.hostExecutor.fileExists(srcPath);
      if (exists) {
        await this.hostExecutor.copyFile(srcPath, destPath);
      }
    }
    this.rawCache = {};
    this.logger.info({ backupDir }, 'Restore completed');
  }

  async getRawYaml(service: string): Promise<string> {
    const filePath = `${this.configPath}/${service}.yaml`;
    return this.hostExecutor.readFile(filePath);
  }

  // ── Private helpers ──
  private async loadRaw(service: string): Promise<RawYamlDoc> {
    const filePath = `${this.configPath}/${service}.yaml`;
    try {
      const content = await this.hostExecutor.readFile(filePath);
      
      // Parse YAML - unfortunately js-yaml may interpret 010 as octal/decimal
      const doc = yaml.load(content) as RawYamlDoc;
      
      // Post-process: Fix MCC/MNC values by reading from raw text
      // This preserves leading zeros like 010 that YAML parser may have stripped
      const fixedDoc = this.fixMccMncFromRawYaml(content, doc);
      
      // Post-process: Convert null 'client' keys to empty objects
      // This preserves 'client:' (no value) when round-tripping
      const cleanedDoc = this.preserveEmptyClient(fixedDoc);
      
      this.rawCache[service] = cleanedDoc;
      return cleanedDoc;
    } catch (err) {
      this.logger.warn({ service, filePath, err: String(err) }, 'Config file not found or parse error');
      return {};
    }
  }

  private async saveRaw(service: string, doc: RawYamlDoc): Promise<void> {
    const filePath = `${this.configPath}/${service}.yaml`;
    
    // Deep convert all numeric strings to actual numbers (EXCEPT mcc/mnc)
    let cleanDoc = this.ensureNumericTypes(doc);
    
    // Remove null values to avoid outputting 'client: null' etc.
    cleanDoc = this.removeNullValues(cleanDoc);
    
    // DEBUG: Log what we're about to save
    this.logger.info({ service, doc: JSON.stringify(cleanDoc, null, 2).substring(0, 500) }, 'Saving config object');
    
    const content = yaml.dump(cleanDoc, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
      sortKeys: false,
      quotingType: '"',
      forceQuotes: false,
    });
    
    // Post-process: Remove quotes from MCC/MNC values
    // This allows "010" to become 010 (unquoted) in YAML
    // Open5GS correctly reads unquoted 010 as string "010" preserving leading zero
    let finalContent = content.replace(/^(\s*)(mcc|mnc):\s+["']?(\d+)["']?$/gm, '$1$2: $3');
    
    // Post-process: Remove empty objects and null values for client key
    // Convert 'client: {}' to 'client:' and 'client: null' to 'client:'
    finalContent = finalContent.replace(/^(\s*)(client):\s*(\{\}|null)\s*$/gm, '$1$2:');
    
    // DEBUG: Log the YAML we're writing
    this.logger.info({ service, yamlPreview: finalContent.substring(0, 300) }, 'Writing YAML content');
    
    await this.hostExecutor.writeFile(filePath, finalContent);
    this.rawCache[service] = doc;
    this.logger.info({ service, filePath }, 'Config saved');
  }

  // Parse SBI - handles both formats:
  // 1. Direct: {addr: "127.0.0.1", port: 7777}
  // 2. Server array: {server: [{address: "127.0.0.1", port: 7777}]}
  private parseSbi(raw: unknown): { addr: string | string[]; port: number } {
    if (!raw || typeof raw !== 'object') {
      return { addr: '127.0.0.1', port: 7777 };
    }
    
    const obj = raw as Record<string, unknown>;
    
    // Check for server array format (Open5GS standard)
    if (obj.server && Array.isArray(obj.server) && obj.server.length > 0) {
      const firstServer = obj.server[0] as Record<string, unknown>;
      return {
        addr: (firstServer.address as string) || '127.0.0.1',
        port: (firstServer.port as number) || 7777,
      };
    }
    
    // Fallback to direct addr/port format
    return {
      addr: (obj.addr as string | string[]) || '127.0.0.1',
      port: (obj.port as number) || 7777,
    };
  }

  private parsePfcp(raw: unknown): { addr: string; port?: number } {
    if (!raw || typeof raw !== 'object') return { addr: '127.0.0.1' };
    const obj = raw as Record<string, unknown>;
    
    // Handle server array format
    if (obj.server && Array.isArray(obj.server) && obj.server.length > 0) {
      const firstServer = obj.server[0] as Record<string, unknown>;
      return {
        addr: (firstServer.address as string) || '127.0.0.1',
        port: firstServer.port as number | undefined,
      };
    }
    
    return {
      addr: (obj.addr as string) || '127.0.0.1',
      port: obj.port as number | undefined,
    };
  }

  private parseGtpu(raw: unknown): { addr: string; port?: number } {
    if (!raw || typeof raw !== 'object') return { addr: '127.0.0.1' };
    const obj = raw as Record<string, unknown>;
    
    // Handle server array format
    if (obj.server && Array.isArray(obj.server) && obj.server.length > 0) {
      const firstServer = obj.server[0] as Record<string, unknown>;
      return {
        addr: (firstServer.address as string) || '127.0.0.1',
        port: firstServer.port as number | undefined,
      };
    }
    
    return {
      addr: (obj.addr as string) || '127.0.0.1',
      port: obj.port as number | undefined,
    };
  }

  private parseAddrPort(raw: unknown): { addr: string | string[]; port?: number } {
    if (!raw || typeof raw !== 'object') return { addr: '127.0.0.1' };
    const obj = raw as Record<string, unknown>;
    
    // Handle server array format
    if (obj.server && Array.isArray(obj.server) && obj.server.length > 0) {
      const firstServer = obj.server[0] as Record<string, unknown>;
      return {
        addr: (firstServer.address as string | string[]) || '127.0.0.1',
        port: firstServer.port as number | undefined,
      };
    }
    
    return {
      addr: (obj.addr as string | string[]) || '127.0.0.1',
      port: obj.port as number | undefined,
    };
  }

  private parseLogger(raw: unknown): { file?: string; level?: string } | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const obj = raw as Record<string, unknown>;
    
    // Handle nested file object: {file: {path: "..."}}
    if (obj.file && typeof obj.file === 'object') {
      const fileObj = obj.file as Record<string, unknown>;
      return {
        file: fileObj.path as string | undefined,
        level: obj.level as string | undefined,
      };
    }
    
    return {
      file: obj.file as string | undefined,
      level: obj.level as string | undefined,
    };
  }

  private parseNrfRef(raw: unknown): { sbi: { addr: string | string[]; port?: number } } | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const obj = raw as Record<string, unknown>;
    if (!obj.sbi) return undefined;
    const sbi = obj.sbi as Record<string, unknown>;
    
    // Handle server array format
    if (sbi.server && Array.isArray(sbi.server) && sbi.server.length > 0) {
      const firstServer = sbi.server[0] as Record<string, unknown>;
      return {
        sbi: {
          addr: (firstServer.address as string | string[]) || '127.0.0.1',
          port: firstServer.port as number | undefined,
        },
      };
    }
    
    return {
      sbi: {
        addr: (sbi.addr as string | string[]) || '127.0.0.1',
        port: sbi.port as number | undefined,
      },
    };
  }

  private resolveAddr(raw: unknown): string {
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) return raw[0] as string || '127.0.0.1';
    return '127.0.0.1';
  }

  /**
   * Recursively convert numeric strings to actual numbers
   * This ensures js-yaml doesn't add quotes around numbers
   * EXCEPT for MCC/MNC which must remain strings to preserve leading zeros
   */
  private ensureNumericTypes(obj: any, parentKey?: string): any {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.ensureNumericTypes(item, parentKey));
    }

    if (typeof obj === 'object') {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        // NEVER convert mcc or mnc fields - they must stay as strings
        if (key === 'mcc' || key === 'mnc') {
          result[key] = value; // Keep as-is (string)
        } else {
          result[key] = this.ensureNumericTypes(value, key);
        }
      }
      return result;
    }

    // Skip conversion if parent key is mcc or mnc
    if (parentKey === 'mcc' || parentKey === 'mnc') {
      return obj;
    }

    // Convert numeric strings to numbers
    if (typeof obj === 'string' && /^\d+(\.\d+)?$/.test(obj)) {
      const num = Number(obj);
      if (!isNaN(num)) {
        return num;
      }
    }

    return obj;
  }

  /**
   * Fix MCC/MNC values by reading from raw YAML text
   * This preserves leading zeros that the YAML parser strips
   */
  private fixMccMncFromRawYaml(rawYaml: string, doc: any): any {
    // Find all mcc/mnc values in raw YAML with regex
    const mccMatches = rawYaml.matchAll(/^\s*(mcc):\s*(\d+)\s*$/gm);
    const mncMatches = rawYaml.matchAll(/^\s*(mnc):\s*(\d+)\s*$/gm);
    
    const mccValues: string[] = [];
    const mncValues: string[] = [];
    
    for (const match of mccMatches) {
      mccValues.push(match[2]); // Capture the numeric value as string
    }
    
    for (const match of mncMatches) {
      mncValues.push(match[2]); // Capture the numeric value as string
    }
    
    // Now recursively fix the doc by replacing mcc/mnc with raw values
    return this.replaceMccMncValues(doc, mccValues, mncValues, { mccIndex: 0, mncIndex: 0 });
  }

  /**
   * Recursively replace MCC/MNC values with raw string values from YAML
   */
  private replaceMccMncValues(obj: any, mccValues: string[], mncValues: string[], indices: { mccIndex: number; mncIndex: number }): any {
    if (obj === null || obj === undefined || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.replaceMccMncValues(item, mccValues, mncValues, indices));
    }

    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'mcc' && indices.mccIndex < mccValues.length) {
        result[key] = mccValues[indices.mccIndex++];
      } else if (key === 'mnc' && indices.mncIndex < mncValues.length) {
        result[key] = mncValues[indices.mncIndex++];
      } else {
        result[key] = this.replaceMccMncValues(value, mccValues, mncValues, indices);
      }
    }
    return result;
  }

  /**
   * Convert null 'client' keys to empty objects when loading YAML
   * This prevents 'client:' from becoming 'client: null' in round-trips
   */
  private preserveEmptyClient(obj: any): any {
    if (obj === null || obj === undefined || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.preserveEmptyClient(item));
    }

    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'client' && value === null) {
        result[key] = {}; // Convert null to empty object
      } else {
        result[key] = this.preserveEmptyClient(value);
      }
    }
    return result;
  }

  /**
   * Recursively remove null values from objects
   * This prevents YAML output like 'client: null'
   * Special case: For 'client' key, convert null to empty object (will be post-processed)
   */
  private removeNullValues(obj: any, parentKey?: string): any {
    if (obj === null || obj === undefined) {
      // Special handling for 'client' key - convert to empty object
      // Post-processing will convert 'client: {}' to 'client:'
      if (parentKey === 'client') {
        return {};
      }
      return undefined;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.removeNullValues(item, parentKey)).filter(item => item !== undefined);
    }

    if (typeof obj === 'object') {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        // Special case: preserve 'client' key even when null/undefined
        if (key === 'client' && (value === null || value === undefined)) {
          result[key] = {}; // Will be post-processed to 'client:'
          continue;
        }
        
        const cleaned = this.removeNullValues(value, key);
        // Include if not null/undefined
        if (cleaned !== null && cleaned !== undefined) {
          result[key] = cleaned;
        }
      }
      return result;
    }

    return obj;
  }

  private serializeSbi(sbi: { addr: string | string[]; port?: number }): Record<string, unknown> {
    // Always write back in server array format to match Open5GS standard
    return {
      server: [{
        address: Array.isArray(sbi.addr) ? sbi.addr[0] : sbi.addr,
        port: sbi.port || 7777,
      }],
    };
  }

  // Load methods for all other services - cast to proper types
  async loadScp() { return this.loadGeneric('scp') as any; }
  async loadUdm() { return this.loadGeneric('udm') as any; }
  async loadUdr() { return this.loadGeneric('udr') as any; }
  async loadPcf() { return this.loadGeneric('pcf') as any; }
  async loadNssf() { return this.loadGeneric('nssf') as any; }
  async loadBsf() { return this.loadGeneric('bsf') as any; }
  async loadMme() { return this.loadGeneric('mme') as any; }
  async loadHss() { return this.loadGeneric('hss') as any; }
  async loadPcrf() { return this.loadGeneric('pcrf') as any; }
  async loadSgwc() { return this.loadGeneric('sgwc') as any; }
  async loadSgwu() { return this.loadGeneric('sgwu') as any; }

  async saveScp(config: any) { return this.saveGeneric('scp', config); }
  async saveUdm(config: any) { return this.saveGeneric('udm', config); }
  async saveUdr(config: any) { return this.saveGeneric('udr', config); }
  async savePcf(config: any) { return this.saveGeneric('pcf', config); }
  async saveNssf(config: any) { return this.saveGeneric('nssf', config); }
  async saveBsf(config: any) { return this.saveGeneric('bsf', config); }
  async saveMme(config: any) { return this.saveGeneric('mme', config); }
  async saveHss(config: any) { return this.saveGeneric('hss', config); }
  async savePcrf(config: any) { return this.saveGeneric('pcrf', config); }
  async saveSgwc(config: any) { return this.saveGeneric('sgwc', config); }
  async saveSgwu(config: any) { return this.saveGeneric('sgwu', config); }
}
