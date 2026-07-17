import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
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

// Host files that must travel with every config backup but live outside the
// bind-mounted /etc/open5gs tree (only /etc/open5gs is mounted into this container —
// see docker-compose.yml), so they're read/written via /proc/1/root directly, same
// pattern already used in sms-controller.ts/vowifi-controller.ts for this exact
// directory. Added 2026-07-13 after a real incident: a bug in VoWiFi's uninstall flow
// (`rm -rf /etc/osmocom`) deleted the SMS-over-SGs configs with no backup anywhere on
// the host to recover from — never again.
export const EXTRA_BACKUP_FILES = [
  '/etc/osmocom/osmo-hlr.cfg',
  '/etc/osmocom/osmo-msc.cfg',
  '/etc/osmocom/osmo-stp.cfg',
  '/etc/osmocom/osmo-epdg.config',
];

// ── mme.yaml sgsap map: round-trip helpers ────────────────────────────────────
// Open5GS uses duplicate map: YAML keys (non-standard) within sgsap.client
// entries to express multiple TAI→LAI mappings. js-yaml only keeps the last
// duplicate key on parse. These two functions convert between the Open5GS
// on-disk format and a standard maps: array that js-yaml can handle.

// READ: convert consecutive duplicate  map:  keys → single  maps: [...]  array
export function convertRepeatedMapKeysToArray(content: string): string {
  const lines = content.split('\n');
  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const mapMatch = line.match(/^( +)map:\s*$/);

    if (!mapMatch) {
      output.push(line);
      i++;
      continue;
    }

    const mapIndent = mapMatch[1];          // e.g. '        ' (8 spaces)
    const contentIndent = mapIndent + '  '; // e.g. '          ' (10 spaces)

    // Collect all consecutive map: blocks at this same indent level
    const blocks: string[][] = [];

    while (i < lines.length) {
      const l = lines[i];
      if (!l.match(new RegExp(`^${mapIndent}map:\\s*$`))) break;

      i++; // skip the map: line itself
      const blockLines: string[] = [];

      while (i < lines.length) {
        const bl = lines[i];
        if (bl.trim() === '') { blockLines.push(bl); i++; continue; }
        const blIndent = (bl.match(/^( *)/) as RegExpMatchArray)[1].length;
        if (blIndent <= mapIndent.length) break;
        blockLines.push(bl);
        i++;
      }

      // Trim trailing blank lines
      while (blockLines.length && blockLines[blockLines.length - 1].trim() === '') blockLines.pop();
      blocks.push(blockLines);
    }

    // Emit as maps: array
    output.push(mapIndent + 'maps:');
    for (const block of blocks) {
      let first = true;
      for (const bl of block) {
        if (bl.trim() === '') { output.push(bl); continue; }
        if (first) {
          // "          tai:" → "          - tai:"  (insert "- " at contentIndent)
          const fieldPart = bl.slice(contentIndent.length);
          output.push(contentIndent + '- ' + fieldPart);
          first = false;
        } else {
          // All subsequent lines: shift right by 2 (the "- " adds 2 chars of effective indent)
          output.push('  ' + bl);
        }
      }
    }
  }

  return output.join('\n');
}

// WRITE: convert  maps: [...]  array → consecutive duplicate  map:  keys
export function convertMapsArrayToRepeatedMapKeys(content: string): string {
  const lines = content.split('\n');
  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const mapsMatch = line.match(/^( +)maps:\s*$/);

    if (!mapsMatch) {
      output.push(line);
      i++;
      continue;
    }

    const mapsIndent = mapsMatch[1];          // e.g. '        ' (8 spaces)
    const dashIndent = mapsIndent + '  ';     // e.g. '          ' (10 spaces)
    const dashPrefix = dashIndent + '- ';     // e.g. '          - '

    i++; // skip the maps: line

    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') { i++; continue; }

      const lIndent = (l.match(/^( *)/) as RegExpMatchArray)[1].length;
      if (lIndent <= mapsIndent.length) break; // left the sequence entirely

      if (!l.startsWith(dashPrefix)) { output.push(l); i++; continue; }

      // New sequence item → emit a separate map: block
      output.push(mapsIndent + 'map:');
      // "          - tai:" → "          tai:"  (remove the "- " at dashIndent)
      output.push(dashIndent + l.slice(dashPrefix.length));
      i++;

      // Continuation lines of this item
      while (i < lines.length) {
        const cl = lines[i];
        if (cl.trim() === '') { i++; continue; }
        const clIndent = (cl.match(/^( *)/) as RegExpMatchArray)[1].length;
        if (clIndent <= mapsIndent.length) break;  // left the sequence
        if (cl.startsWith(dashPrefix)) break;       // next item
        output.push(cl.slice(2)); // strip 2 leading spaces (reverse of the shift added on read)
        i++;
      }
    }
  }

  return output.join('\n');
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

    const optionalServices = ['scp', 'udm', 'udr', 'pcf', 'nssf', 'bsf', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu', 'sepp1'];
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
    const raw = config.rawYaml as any;
    await this.saveRaw('nrf', raw);
  }

  async saveAmf(config: AmfConfig): Promise<void> {
    const raw = config.rawYaml as any;
    await this.saveRaw('amf', raw);
  }

  async saveSmf(config: SmfConfig): Promise<void> {
    const raw = config.rawYaml as any;
    await this.saveRaw('smf', raw);
  }

  async saveUpf(config: UpfConfig): Promise<void> {
    const raw = config.rawYaml as any;
    await this.saveRaw('upf', raw);
  }

  async saveAusf(config: AusfConfig): Promise<void> {
    const raw = config.rawYaml as any;
    await this.saveRaw('ausf', raw);
  }

  async saveGeneric(service: string, config: GenericServiceConfig): Promise<void> {
    const raw = config.rawYaml as any;
    await this.saveRaw(service, raw);
  }

  async backupAll(backupDir: string): Promise<void> {
    await this.hostExecutor.createDirectory(backupDir);
    const allServices = ['nrf', 'amf', 'smf', 'upf', 'ausf', 'scp', 'udm', 'udr', 'pcf', 'nssf', 'bsf', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu', 'sepp1', 'sepp2'];

    for (const service of allServices) {
      const srcPath = `${this.configPath}/${service}.yaml`;
      const destPath = `${backupDir}/${service}.yaml`;
      const exists = await this.hostExecutor.fileExists(srcPath);
      if (exists) {
        await this.hostExecutor.copyFile(srcPath, destPath);
      }
    }

    for (const filePath of EXTRA_BACKUP_FILES) {
      const hostPath = `/proc/1/root${filePath}`;
      if (fs.existsSync(hostPath)) {
        fs.copyFileSync(hostPath, `${backupDir}/${path.basename(filePath)}`);
      }
    }
    this.logger.info({ backupDir }, 'Backup completed');
  }

  async restoreBackup(backupDir: string): Promise<void> {
    const allServices = ['nrf', 'amf', 'smf', 'upf', 'ausf', 'scp', 'udm', 'udr', 'pcf', 'nssf', 'bsf', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu', 'sepp1', 'sepp2'];

    for (const service of allServices) {
      const srcPath = `${backupDir}/${service}.yaml`;
      const destPath = `${this.configPath}/${service}.yaml`;
      const exists = await this.hostExecutor.fileExists(srcPath);
      if (exists) {
        await this.hostExecutor.copyFile(srcPath, destPath);
      }
    }

    for (const filePath of EXTRA_BACKUP_FILES) {
      const srcPath = `${backupDir}/${path.basename(filePath)}`;
      if (fs.existsSync(srcPath)) {
        const destHostPath = `/proc/1/root${filePath}`;
        fs.mkdirSync(path.dirname(destHostPath), { recursive: true });
        fs.copyFileSync(srcPath, destHostPath);
      }
    }
    this.rawCache = {};
    this.logger.info({ backupDir }, 'Restore completed');
  }

  async getRawYaml(service: string): Promise<string> {
    const filePath = `${this.configPath}/${service}.yaml`;
    return this.hostExecutor.readFile(filePath);
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async loadRaw(service: string): Promise<RawYamlDoc> {
    const filePath = `${this.configPath}/${service}.yaml`;
    try {
      let content = await this.hostExecutor.readFile(filePath);

      // mme.yaml uses duplicate map: keys (Open5GS extension, not standard YAML).
      // Convert them to a maps: array so js-yaml can parse all entries.
      if (service === 'mme') {
        content = convertRepeatedMapKeysToArray(content);
      }

      // js-yaml may interpret bare 010 (MNC) as octal/decimal.
      // Parse first, then restore MCC/MNC/SD from raw text.
      const doc = yaml.load(content) as RawYamlDoc;
      const fixedDoc = this.fixMccMncSdFromRawYaml(content, doc);
      const cleanedDoc = this.preserveEmptyClient(fixedDoc);

      this.rawCache[service] = cleanedDoc;
      return cleanedDoc;
    } catch (err) {
      this.logger.warn({ service, filePath, err: String(err) }, 'Config file not found or parse error');
      return {};
    }
  }

  // ── Deep merge: overlay wins on scalars and arrays, objects are merged recursively ──
  // This preserves unknown fields (e.g. manually added dev:, custom session entries)
  // that the NMS UI doesn't know about.
  private deepMerge(base: any, overlay: any): any {
    // Scalars, arrays, null: overlay always wins
    if (
      overlay === null || overlay === undefined ||
      typeof overlay !== 'object' || Array.isArray(overlay)
    ) return overlay;
    if (
      base === null || base === undefined ||
      typeof base !== 'object' || Array.isArray(base)
    ) return overlay;

    // Both are plain objects — merge key by key
    const result: any = { ...base };
    for (const key of Object.keys(overlay)) {
      const ov = overlay[key];
      const bv = base[key];
      if (
        ov !== null && ov !== undefined &&
        typeof ov === 'object' && !Array.isArray(ov) &&
        bv !== null && bv !== undefined &&
        typeof bv === 'object' && !Array.isArray(bv)
      ) {
        result[key] = this.deepMerge(bv, ov);
      } else {
        result[key] = ov;
      }
    }
    return result;
  }

  private async saveRaw(service: string, doc: RawYamlDoc): Promise<void> {
    const filePath = `${this.configPath}/${service}.yaml`;

    // ── Round-trip safety: merge incoming doc over the current on-disk file ──
    // This preserves fields the NMS UI never touched (e.g. manual dev: bindings,
    // custom session entries, unknown top-level keys). The incoming doc wins on
    // every key it contains; keys only present on disk are kept as-is.
    // Arrays are NOT merged — the incoming array replaces the on-disk array
    // (so deleting a session pool via the UI actually removes it).
    let mergedDoc: RawYamlDoc = doc;
    try {
      const currentContent = await this.hostExecutor.readFile(filePath);
      const currentParsed = yaml.load(currentContent) as RawYamlDoc;
      if (currentParsed && typeof currentParsed === 'object') {
        mergedDoc = this.deepMerge(currentParsed, doc) as RawYamlDoc;
        this.logger.debug({ service }, 'Deep-merged incoming config over on-disk file');
      }
    } catch {
      // File doesn't exist yet or can't be read — start fresh
      this.logger.debug({ service }, 'No existing file to merge; writing fresh');
    }

    // Keep mcc/mnc/sd as strings, convert everything else to proper numbers.
    let cleanDoc = this.ensureNumericTypes(mergedDoc);
    cleanDoc = this.removeNullValues(cleanDoc);

    this.logger.info(
      { service, doc: JSON.stringify(cleanDoc, null, 2).substring(0, 500) },
      'Saving config object',
    );

    const content = yaml.dump(cleanDoc, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
      sortKeys: false,
      quotingType: '"',
      forceQuotes: false,
    });

    let finalContent = content;

    // ── MCC / MNC: always UNQUOTED ──────────────────────────────────────────
    // Open5GS reads bare  010  as the string "010" (leading zero preserved).
    // Strip any quotes (double or single, ASCII or curly) then normalise spacing.
    finalContent = finalContent.replace(
      /^(\s*)(mcc|mnc):\s+"([0-9a-fA-F]+)"\s*$/gm,
      '$1$2: $3',
    );
    finalContent = finalContent.replace(
      /^(\s*)(mcc|mnc):\s+'([0-9a-fA-F]+)'\s*$/gm,
      '$1$2: $3',
    );
    // Normalise spacing for already-bare values
    finalContent = finalContent.replace(
      /^(\s*)(mcc|mnc):\s+([0-9a-fA-F]+)\s*$/gm,
      '$1$2: $3',
    );

    // ── SD: always UNQUOTED ──────────────────────────────────────────────────
    // Open5GS handles both quoted and unquoted SD. We write it unquoted
    // (sd: 000001) to match standard Open5GS config file style.
    // The load side (fixMccMncSdFromRawYaml) handles both forms on read.
    // Strip double quotes, single quotes, then normalise spacing.
    finalContent = finalContent.replace(
      /^(\s*)(sd):\s*"([0-9a-fA-F]+)"\s*$/gm,
      '$1$2: $3',
    );
    finalContent = finalContent.replace(
      /^(\s*)(sd):\s*'([0-9a-fA-F]+)'\s*$/gm,
      '$1$2: $3',
    );
    // Normalise spacing on already-bare values
    finalContent = finalContent.replace(
      /^(\s*)(sd):\s+([0-9a-fA-F]+)\s*$/gm,
      '$1$2: $3',
    );

    // ── client: {} / client: null → bare 'client:' ──────────────────────────
    finalContent = finalContent.replace(
      /^(\s*)(client):\s*(\{\}|null)\s*$/gm,
      '$1$2:',
    );

    // ── db_uri: normalize localhost → 127.0.0.1 ──────────────────────────────
    // Ubuntu resolves `localhost` to ::1 (IPv6) but MongoDB only binds IPv4.
    // Any write path — apply-config, restore-defaults, UI save — must not
    // re-introduce this bug regardless of what the on-disk file contained.
    finalContent = finalContent.replace(
      /^(db_uri:\s*["']?mongodb:\/\/)localhost\//gm,
      '$1127.0.0.1/',
    );

    // Log SD lines so we can verify quoting in backend logs
    const sdLines = finalContent.split('\n').filter(l => /^\s*sd:/.test(l));
    if (sdLines.length > 0) {
      this.logger.info({ service, sdLines }, 'SD lines written to YAML');
    }

    // mme.yaml: convert maps: array back to duplicate map: keys for Open5GS
    if (service === 'mme') {
      finalContent = convertMapsArrayToRepeatedMapKeys(finalContent);
    }

    this.logger.info(
      { service, yamlPreview: finalContent.substring(0, 300) },
      'Writing YAML content',
    );

    await this.hostExecutor.writeFile(filePath, finalContent);
    this.rawCache[service] = doc;
    this.logger.info({ service, filePath }, 'Config saved');
  }

  // ── YAML parsers ────────────────────────────────────────────────────────────

  private parseSbi(raw: unknown): { addr: string | string[]; port: number } {
    if (!raw || typeof raw !== 'object') return { addr: '127.0.0.1', port: 7777 };
    const obj = raw as Record<string, unknown>;
    if (obj.server && Array.isArray(obj.server) && obj.server.length > 0) {
      const s = obj.server[0] as Record<string, unknown>;
      return { addr: (s.address as string) || '127.0.0.1', port: (s.port as number) || 7777 };
    }
    return { addr: (obj.addr as string | string[]) || '127.0.0.1', port: (obj.port as number) || 7777 };
  }

  private parsePfcp(raw: unknown): { addr: string; port?: number } {
    if (!raw || typeof raw !== 'object') return { addr: '127.0.0.1' };
    const obj = raw as Record<string, unknown>;
    if (obj.server && Array.isArray(obj.server) && obj.server.length > 0) {
      const s = obj.server[0] as Record<string, unknown>;
      return { addr: (s.address as string) || '127.0.0.1', port: s.port as number | undefined };
    }
    return { addr: (obj.addr as string) || '127.0.0.1', port: obj.port as number | undefined };
  }

  private parseGtpu(raw: unknown): { addr: string; port?: number } {
    if (!raw || typeof raw !== 'object') return { addr: '127.0.0.1' };
    const obj = raw as Record<string, unknown>;
    if (obj.server && Array.isArray(obj.server) && obj.server.length > 0) {
      const s = obj.server[0] as Record<string, unknown>;
      return { addr: (s.address as string) || '127.0.0.1', port: s.port as number | undefined };
    }
    return { addr: (obj.addr as string) || '127.0.0.1', port: obj.port as number | undefined };
  }

  private parseAddrPort(raw: unknown): { addr: string | string[]; port?: number } {
    if (!raw || typeof raw !== 'object') return { addr: '127.0.0.1' };
    const obj = raw as Record<string, unknown>;
    if (obj.server && Array.isArray(obj.server) && obj.server.length > 0) {
      const s = obj.server[0] as Record<string, unknown>;
      return { addr: (s.address as string | string[]) || '127.0.0.1', port: s.port as number | undefined };
    }
    return { addr: (obj.addr as string | string[]) || '127.0.0.1', port: obj.port as number | undefined };
  }

  private parseLogger(raw: unknown): { file?: string; level?: string } | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const obj = raw as Record<string, unknown>;
    if (obj.file && typeof obj.file === 'object') {
      const f = obj.file as Record<string, unknown>;
      return { file: f.path as string | undefined, level: obj.level as string | undefined };
    }
    return { file: obj.file as string | undefined, level: obj.level as string | undefined };
  }

  private parseNrfRef(raw: unknown): { sbi: { addr: string | string[]; port?: number } } | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const obj = raw as Record<string, unknown>;
    if (!obj.sbi) return undefined;
    const sbi = obj.sbi as Record<string, unknown>;
    if (sbi.server && Array.isArray(sbi.server) && sbi.server.length > 0) {
      const s = sbi.server[0] as Record<string, unknown>;
      return { sbi: { addr: (s.address as string | string[]) || '127.0.0.1', port: s.port as number | undefined } };
    }
    return { sbi: { addr: (sbi.addr as string | string[]) || '127.0.0.1', port: sbi.port as number | undefined } };
  }

  private resolveAddr(raw: unknown): string {
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) return (raw[0] as string) || '127.0.0.1';
    return '127.0.0.1';
  }

  // ── Type helpers ────────────────────────────────────────────────────────────

  /**
   * Recursively convert numeric strings to actual numbers, EXCEPT mcc/mnc/sd
   * which must remain strings to preserve leading zeros and quoted SD.
   */
  private ensureNumericTypes(obj: any, parentKey?: string): any {
    if (obj === null || obj === undefined) return obj;

    if (Array.isArray(obj)) {
      return obj.map(item => this.ensureNumericTypes(item, parentKey));
    }

    if (typeof obj === 'object') {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        if (key === 'mcc' || key === 'mnc' || key === 'sd') {
          result[key] = value; // preserve as string
        } else {
          result[key] = this.ensureNumericTypes(value, key);
        }
      }
      return result;
    }

    if (parentKey === 'mcc' || parentKey === 'mnc' || parentKey === 'sd') return obj;

    if (typeof obj === 'string' && /^\d+(\.\d+)?$/.test(obj)) {
      const num = Number(obj);
      if (!isNaN(num)) return num;
    }

    return obj;
  }

  /**
   * Read MCC/MNC/SD values from the raw YAML text to preserve leading zeros
   * and strip any surrounding quotes that were present in the file.
   */
  private fixMccMncSdFromRawYaml(rawYaml: string, doc: any): any {
    // Match bare values AND quoted values for sd (e.g. sd: "000001" or sd: 000001)
    const mccValues: string[] = [];
    const mncValues: string[] = [];
    const sdValues: string[] = [];

    for (const m of rawYaml.matchAll(/^\s*mcc:\s*(\d+)\s*$/gm)) mccValues.push(m[1]);
    for (const m of rawYaml.matchAll(/^\s*mnc:\s*(\d+)\s*$/gm)) mncValues.push(m[1]);
    // Match both  sd: 000001  and  sd: "000001"
    for (const m of rawYaml.matchAll(/^\s*sd:\s*"?([0-9a-fA-F]+)"?\s*$/gm)) sdValues.push(m[1]);

    return this.replaceMccMncSdValues(doc, mccValues, mncValues, sdValues, {
      mccIndex: 0, mncIndex: 0, sdIndex: 0,
    });
  }

  private replaceMccMncSdValues(
    obj: any,
    mccValues: string[],
    mncValues: string[],
    sdValues: string[],
    indices: { mccIndex: number; mncIndex: number; sdIndex: number },
  ): any {
    if (obj === null || obj === undefined || typeof obj !== 'object') return obj;

    if (Array.isArray(obj)) {
      return obj.map(item => this.replaceMccMncSdValues(item, mccValues, mncValues, sdValues, indices));
    }

    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'mcc' && indices.mccIndex < mccValues.length) {
        result[key] = mccValues[indices.mccIndex++];
      } else if (key === 'mnc' && indices.mncIndex < mncValues.length) {
        result[key] = mncValues[indices.mncIndex++];
      } else if (key === 'sd' && indices.sdIndex < sdValues.length) {
        result[key] = sdValues[indices.sdIndex++];
      } else {
        result[key] = this.replaceMccMncSdValues(value, mccValues, mncValues, sdValues, indices);
      }
    }
    return result;
  }

  private preserveEmptyClient(obj: any): any {
    if (obj === null || obj === undefined || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(item => this.preserveEmptyClient(item));
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = key === 'client' && value === null ? {} : this.preserveEmptyClient(value);
    }
    return result;
  }

  private removeNullValues(obj: any, parentKey?: string): any {
    if (obj === null || obj === undefined) {
      return parentKey === 'client' ? {} : undefined;
    }

    if (Array.isArray(obj)) {
      return obj
        .map(item => this.removeNullValues(item, parentKey))
        .filter(item => item !== undefined);
    }

    if (typeof obj === 'object') {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        if (key === 'client' && (value === null || value === undefined)) {
          result[key] = {};
          continue;
        }
        const cleaned = this.removeNullValues(value, key);
        if (cleaned !== null && cleaned !== undefined) result[key] = cleaned;
      }
      return result;
    }

    return obj;
  }

  private serializeSbi(sbi: { addr: string | string[]; port?: number }): Record<string, unknown> {
    return {
      server: [{
        address: Array.isArray(sbi.addr) ? sbi.addr[0] : sbi.addr,
        port: sbi.port || 7777,
      }],
    };
  }

  // ── Convenience loaders / savers ─────────────────────────────────────────────
  async loadScp()  { return this.loadGeneric('scp')  as any; }
  async loadUdm()  { return this.loadGeneric('udm')  as any; }
  async loadUdr()  { return this.loadGeneric('udr')  as any; }
  async loadPcf()  { return this.loadGeneric('pcf')  as any; }
  async loadNssf() { return this.loadGeneric('nssf') as any; }
  async loadBsf()  { return this.loadGeneric('bsf')  as any; }
  async loadMme()  { return this.loadGeneric('mme')  as any; }
  async loadHss()  { return this.loadGeneric('hss')  as any; }
  async loadPcrf() { return this.loadGeneric('pcrf') as any; }
  async loadSgwc() { return this.loadGeneric('sgwc') as any; }
  async loadSgwu() { return this.loadGeneric('sgwu') as any; }
  async loadSepp1() { return this.loadGeneric('sepp1') as any; }

  async saveScp(config: any)  { return this.saveGeneric('scp',  config); }
  async saveUdm(config: any)  { return this.saveGeneric('udm',  config); }
  async saveUdr(config: any)  { return this.saveGeneric('udr',  config); }
  async savePcf(config: any)  { return this.saveGeneric('pcf',  config); }
  async saveNssf(config: any) { return this.saveGeneric('nssf', config); }
  async saveBsf(config: any)  { return this.saveGeneric('bsf',  config); }
  async saveMme(config: any)  { return this.saveGeneric('mme',  config); }
  async saveHss(config: any)  { return this.saveGeneric('hss',  config); }
  async savePcrf(config: any) { return this.saveGeneric('pcrf', config); }
  async saveSgwc(config: any) { return this.saveGeneric('sgwc', config); }
  async saveSgwu(config: any) { return this.saveGeneric('sgwu', config); }
  async saveSepp1(config: any) { return this.saveGeneric('sepp1', config); }
}
