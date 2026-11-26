import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
import {
  ALL_CONFIG_SERVICES,
  AllConfigs,
  IConfigRepository,
  NfConfig,
  Open5gsConfigDocuments,
  Open5gsServiceName,
} from '../../domain/interfaces/config-repository';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { NrfConfig } from '../../domain/entities/nrf-config';
import { AmfConfig } from '../../domain/entities/amf-config';
import { SmfConfig } from '../../domain/entities/smf-config';
import { UpfConfig } from '../../domain/entities/upf-config';
import { AusfConfig } from '../../domain/entities/ausf-config';
import { AmfYamlDocument } from '../../domain/entities/open5gs-yaml';
import pino from 'pino';

/**
 * Narrow a parsed-YAML value to a plain mapping.
 *
 * Every tree-walker below needs exactly this question answered, and a real
 * type predicate answers it once instead of each walker casting. `typeof null`
 * is 'object' and so is an array, so both have to be excluded explicitly.
 */
function isYamlMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  '/etc/osmocom/osmo-hnbgw.cfg',
  '/etc/osmocom/osmo-mgw-hnbgw.cfg',
  '/etc/osmocom/.nms-hnbgw-state.json',
  // osmo-epdg.config: the archived osmo-epdg-based VoWiFi backend (see
  // archive/vowifi-osmo-epdg/) — left in this list for any host that hasn't
  // reinstalled onto the VectorCore backend yet; harmless no-op (skipped with a
  // warning) once it no longer exists.
  '/etc/osmocom/osmo-epdg.config',
  '/etc/vectorcore/epdg/epdg.yaml',
  '/etc/vectorcore/aaa/aaa.config',
  // Every other optional module's own NMS-side state file (2026-08-25 audit,
  // "does the backup module really cover every module") — each of these is
  // the SOURCE OF TRUTH a module's own Install/Configure flow reads back to
  // decide what to (re)generate (Kamailio includes, systemd unit args,
  // SMS-delivery-mode, retention settings, etc.) — losing one doesn't corrupt
  // anything, but it does mean re-provisioning that module from scratch by
  // hand instead of Install → Configure picking up exactly where it left off.
  // Deliberately NOT included: idempotency/patch-applied marker files
  // (mme-dup-release-access-bearers-patch.json, smf-late-csr-patch.json) —
  // restoring those onto a different host/build could wrongly skip a patch
  // that host's own files actually still need; and migration-WIZARD progress
  // trackers (dns-migration, plmn-migration, frr-migration state) — those
  // describe an in-progress one-time transition, not standing config, and
  // restoring "still migrating" state onto a fresh host makes no sense.
  '/etc/open5gs/.ims-config.json',
  '/etc/open5gs/.ims-install.json',
  '/etc/open5gs/.mms-config.json',
  '/etc/open5gs/.pstn-config.json',
  '/etc/open5gs/.asterisk2g-config.json',
  '/etc/open5gs/.vectorcore-smsc-config.json',
  '/etc/open5gs/.twamp-config.json',
  '/etc/open5gs/.ocs-config.json',
  // Real, 2026-09-24 finding: ensureCdrIndexes() (cdr-store.ts) runs
  // unconditionally on every backend boot and actively collMods the CDR TTL
  // index's expireAfterSeconds to whatever readCdrSettings() returns here —
  // on a fresh VM missing this file, that silently falls back to the
  // 180-day default and RE-TIGHTENS the index, which can actively delete
  // real historical CDRs within about a minute of first boot if the
  // operator had configured a longer retention.
  '/etc/open5gs/.cdr-settings.json',
  '/etc/open5gs-nms/.vowifi-state.json',
  '/etc/open5gs-nms/.swu-emulator-state.json',
  '/etc/open5gs-nms/frr-source-build-state.json',
  // Real, 2026-09-24 finding: the IP Plan Tool's own "planned" registry.
  // For sepp-sbi/sepp-n32c/sepp-n32f/bind-dns specifically, this file IS the
  // only record of an operator's intended address — those 4 rows are
  // deliberately registry-only (never live-applied, since SEPP's only
  // live-apply path is a full 17-NF core restart). Confirmed live on
  // production: a real pending sepp-sbi value with no other record anywhere
  // in the system (SEPP itself is still at factory defaults) would be
  // silently dropped by a restore with zero warning.
  '/etc/open5gs-nms/ip-plan-state.json',
  // 2G GSM's own BTS entries (band, ARFCN, cell_identity, LAC, BSIC, TRX
  // count, GPRS mode, NSVC IPs, etc.) — real, 2026-09-22 audit finding: this
  // was missing entirely despite the module predating the original
  // 2026-08-25 audit. osmo-bsc.cfg/osmo-mgw.cfg/osmo-pcu.cfg/osmo-sgsn.cfg/
  // osmo-ggsn.cfg/osmo-sip-connector.cfg are all fully regenerated FROM this
  // one file by gsm-controller.ts's own Configure flow, so backing up just
  // this JSON (not all 6 generated .cfg files) is sufficient, matching the
  // same "source of truth" pattern already used for IMS/PSTN/Asterisk-2G
  // above — as long as Configure is re-run after restore.
  '/etc/osmocom/.nms-gsm-bts-state.json',
  '/etc/chrony/chrony.conf',
  '/etc/rsyslog.d/71-open5gs-nms-forward.conf',
  // SEPP's own N32 TLS material — real, 2026-09-22 audit finding: this was
  // never captured anywhere. Losing it and re-running "Generate Certs"
  // produces a DIFFERENT self-signed keypair, breaking N32 trust with any
  // visited-network peer that pinned the original public cert — same
  // severity as the SUCI-key/SecGW-PKI categories, which already treat
  // their own key material as genuinely irreplaceable.
  '/etc/open5gs/tls/sepp.crt',
  '/etc/open5gs/tls/sepp.key',
  '/etc/open5gs/tls/sepp-peer-ca.crt',
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

/**
 * Read MCC/MNC/SD values from the raw YAML text to preserve leading zeros
 * and strip any surrounding quotes that were present in the file.
 */
export function restoreMccMncSdFromRawYaml(rawYaml: string, doc: unknown): unknown {
  const mccValues: string[] = [];
  const mncValues: string[] = [];
  const sdValues: string[] = [];

  // These lists are INDEX-matched against the parsed tree in document order
  // (see replaceMccMncSdValues), so each key must be collected in ONE pass:
  // scanning bare and quoted forms separately appends in pass order instead
  // and would assign a value to the wrong occurrence. Quoted forms are
  // accepted because, while the save path always writes these unquoted, a
  // hand-edited file can carry either -- previously `mcc`/`mnc` matched the
  // bare form only, so a quoted one was skipped and every later occurrence
  // in that file shifted by one.
  const scalar = (key: string): RegExp =>
    new RegExp(`^\\s*${key}:\\s*(?:"([0-9a-fA-F]+)"|'([0-9a-fA-F]+)'|([0-9a-fA-F]+))\\s*$`, 'gm');
  const valueOf = (m: RegExpMatchArray): string => m[1] ?? m[2] ?? m[3];

  for (const m of rawYaml.matchAll(scalar('mcc'))) mccValues.push(valueOf(m));
  for (const m of rawYaml.matchAll(scalar('mnc'))) mncValues.push(valueOf(m));
  for (const m of rawYaml.matchAll(scalar('sd'))) sdValues.push(valueOf(m));

  return replaceMccMncSdValues(doc, mccValues, mncValues, sdValues, {
    mccIndex: 0, mncIndex: 0, sdIndex: 0,
  });
}

function replaceMccMncSdValues(
  obj: unknown,
  mccValues: string[],
  mncValues: string[],
  sdValues: string[],
  indices: { mccIndex: number; mncIndex: number; sdIndex: number },
): unknown {
  if (Array.isArray(obj)) {
    return obj.map(item => replaceMccMncSdValues(item, mccValues, mncValues, sdValues, indices));
  }
  if (!isYamlMap(obj)) return obj;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'mcc' && indices.mccIndex < mccValues.length) {
      result[key] = mccValues[indices.mccIndex++];
    } else if (key === 'mnc' && indices.mncIndex < mncValues.length) {
      result[key] = mncValues[indices.mncIndex++];
    } else if (key === 'sd' && indices.sdIndex < sdValues.length) {
      result[key] = sdValues[indices.sdIndex++];
    } else {
      result[key] = replaceMccMncSdValues(value, mccValues, mncValues, sdValues, indices);
    }
  }
  return result;
}

// NOTE: this class used to keep a `rawCache` of every parsed document. It was
// written in two places and READ IN NONE, so it cached nothing -- it only held
// every config in memory and gave a future reader a trap, because saveRaw()
// stored the caller's incoming (possibly partial) doc under the service name
// while loadRaw() stored the full on-disk parse. Removed 2026-11-26.
export class YamlConfigRepository implements IConfigRepository {
  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly configPath: string,
    private readonly logger: pino.Logger,
  ) {}

  async loadNrf(): Promise<NrfConfig> {
    const raw = await this.loadRaw('nrf');
    const nrf = raw.nrf ?? {};
    return {
      sbi: this.parseSbi(nrf.sbi),
      logger: this.parseLogger(raw.logger),
      rawYaml: raw,
    };
  }

  async loadAmf(): Promise<AmfConfig> {
    const raw = await this.loadRaw('amf');
    const amf = raw.amf ?? {};
    return {
      sbi: this.parseSbi(amf.sbi),
      ngap: this.parseAddrPort(amf.ngap),
      guami: amf.guami ?? [],
      tai: amf.tai ?? [],
      plmn_support: amf.plmn_support ?? [],
      security: amf.security as AmfConfig['security'],
      network_name: amf.network_name as AmfConfig['network_name'],
      amf_name: amf.amf_name,
      nrf: this.parseNrfRef(raw.nrf),
      logger: this.parseLogger(raw.logger),
      rawYaml: raw,
    };
  }

  async loadSmf(): Promise<SmfConfig> {
    const raw = await this.loadRaw('smf');
    const smf = raw.smf ?? {};
    return {
      sbi: this.parseSbi(smf.sbi),
      pfcp: this.parsePfcp(smf.pfcp),
      gtpc: this.parseGtpc(smf.gtpc),
      gtpu: smf.gtpu ? this.parseGtpu(smf.gtpu) : undefined,
      session: smf.session,
      dns: smf.dns,
      mtu: smf.mtu,
      freeDiameter: typeof smf.freeDiameter === 'string' ? smf.freeDiameter : undefined,
      info: smf.info as SmfConfig['info'],
      nrf: this.parseNrfRef(raw.nrf),
      logger: this.parseLogger(raw.logger),
      rawYaml: raw,
    };
  }

  async loadUpf(): Promise<UpfConfig> {
    const raw = await this.loadRaw('upf');
    const upf = raw.upf ?? {};
    return {
      pfcp: this.parsePfcp(upf.pfcp),
      gtpu: this.parseGtpu(upf.gtpu),
      session: upf.session,
      logger: this.parseLogger(raw.logger),
      rawYaml: raw,
    };
  }

  async loadAusf(): Promise<AusfConfig> {
    const raw = await this.loadRaw('ausf');
    const ausf = raw.ausf ?? {};
    return {
      sbi: this.parseSbi(ausf.sbi),
      nrf: this.parseNrfRef(raw.nrf),
      logger: this.parseLogger(raw.logger),
      rawYaml: raw,
    };
  }

  /**
   * Load one config file without a per-NF parser: just the handful of common
   * endpoint fields, plus the whole parsed document.
   *
   * `K` is a literal service name, so the returned document type is the one
   * belonging to that file -- the caller does not have to assert it, and
   * `loadSepp1()` correctly gets the document whose top-level key is `sepp`.
   */
  private async loadGeneric<K extends Open5gsServiceName>(service: K): Promise<NfConfig<K>> {
    const raw = await this.loadRaw(service);
    const section = raw[service];
    const s: Record<string, unknown> = isYamlMap(section) ? section : {};
    return {
      sbi: s.sbi ? this.parseSbi(s.sbi) : undefined,
      pfcp: s.pfcp ? this.parsePfcp(s.pfcp) : undefined,
      gtpu: s.gtpu ? this.parseGtpu(s.gtpu) : undefined,
      gtpc: this.parseGtpc(s.gtpc),
      ngap: s.ngap ? this.parseAddrPort(s.ngap) : undefined,
      nrf: this.parseNrfRef(raw.nrf),
      logger: this.parseLogger(raw.logger),
      rawYaml: raw,
    };
  }

  async loadAll(): Promise<AllConfigs> {
    this.logger.info('Loading all configurations from /etc/open5gs');

    // Read every file concurrently. Each loader resolves even when its file is
    // missing or unparseable (loadRaw() reports and yields an empty document),
    // so nothing here can reject -- which is also why the per-service
    // try/catch this loop used to carry was unreachable and has been dropped.
    const [
      nrf, amf, smf, upf, ausf,
      scp, udm, udr, pcf, nssf, bsf, sepp1,
      mme, hss, pcrf, sgwc, sgwu,
    ] = await Promise.all([
      this.loadNrf(), this.loadAmf(), this.loadSmf(), this.loadUpf(), this.loadAusf(),
      this.loadScp(), this.loadUdm(), this.loadUdr(), this.loadPcf(),
      this.loadNssf(), this.loadBsf(), this.loadSepp1(),
      this.loadMme(), this.loadHss(), this.loadPcrf(), this.loadSgwc(), this.loadSgwu(),
    ]);

    return {
      nrf, amf, smf, upf, ausf,
      scp, udm, udr, pcf, nssf, bsf, sepp1,
      mme, hss, pcrf, sgwc, sgwu,
    };
  }

  async saveNrf(config: NrfConfig): Promise<void> {
    await this.saveRaw('nrf', config.rawYaml ?? {});
  }

  async saveAmf(config: AmfConfig): Promise<void> {
    const raw = config.rawYaml ?? {};
    this.normalizeAmfPlmnSupport(raw);
    await this.saveRaw('amf', raw);
  }

  // Real bug, confirmed live 2026-09-28: ConfigPage.tsx's "Add PLMN" button
  // (amf.plmn_support: [...amf.plmn_support, {plmn_id, s_nssai:[{sst:1}]}])
  // appends a brand-new top-level plmn_support entry regardless of whether
  // that plmn_id already exists — there's a separate, correct "add slice"
  // button that pushes into an EXISTING entry's own s_nssai array, but
  // nothing stops two entries sharing the same plmn_id from coexisting.
  // Both forms parse without error (confirmed against Open5GS's real
  // src/amf/context.c plmn_support parser), but they are NOT equivalent on
  // the wire: ngap-build.c's ngap_build_plmn_support_list() emits one
  // NGAP PLMNSupportItem PER top-level plmn_support[] entry, so a
  // duplicate-plmn_id split produces two separate PLMNSupportItems
  // advertising the same PLMN in the NGSetupResponse's broadcast list
  // instead of one PLMNSupportItem correctly listing both slices — not
  // the proper 3GPP structure. Normalizing here (the single funnel every
  // AMF write goes through, regardless of whether it came from this
  // editor, auto-config's bulk apply, or a raw YAML paste) fixes it at
  // the source regardless of which caller produced the duplicate.
  private normalizeAmfPlmnSupport(raw: AmfYamlDocument): void {
    const list = raw.amf?.plmn_support;
    if (!Array.isArray(list) || list.length < 2) return;

    type PlmnEntry = NonNullable<NonNullable<AmfYamlDocument['amf']>['plmn_support']>[number];
    const merged: PlmnEntry[] = [];
    const indexByPlmn = new Map<string, number>();

    for (const entry of list) {
      const mcc = entry.plmn_id?.mcc;
      const mnc = entry.plmn_id?.mnc;
      if (mcc === undefined || mnc === undefined) {
        merged.push(entry);
        continue;
      }
      const key = `${mcc}/${mnc}`;
      const existingIdx = indexByPlmn.get(key);
      if (existingIdx === undefined) {
        indexByPlmn.set(key, merged.length);
        merged.push({ ...entry, s_nssai: [...(entry.s_nssai ?? [])] });
        continue;
      }

      // Same PLMN already seen — fold this entry's slices into it instead
      // of keeping a second PLMNSupportItem. Dedupe by sst+sd so replaying
      // an already-normalized save (or a double-click) doesn't accumulate
      // identical slice entries.
      const target = merged[existingIdx];
      const slices = (target.s_nssai ??= []);
      for (const slice of entry.s_nssai ?? []) {
        const dup = slices.some(existing => existing.sst === slice.sst && existing.sd === slice.sd);
        if (!dup) slices.push(slice);
      }
      this.logger.info(
        { mcc, mnc, droppedFrom: existingIdx },
        'Merged duplicate amf.plmn_support entry (same PLMN) into one — see normalizeAmfPlmnSupport',
      );
    }

    if (raw.amf) raw.amf.plmn_support = merged;
  }

  async saveSmf(config: SmfConfig): Promise<void> {
    await this.saveRaw('smf', config.rawYaml ?? {});
  }

  async saveUpf(config: UpfConfig): Promise<void> {
    await this.saveRaw('upf', config.rawYaml ?? {});
  }

  async saveAusf(config: AusfConfig): Promise<void> {
    await this.saveRaw('ausf', config.rawYaml ?? {});
  }

  private async saveGeneric<K extends Open5gsServiceName>(service: K, config: NfConfig<K>): Promise<void> {
    await this.saveRaw(service, config.rawYaml ?? {});
  }

  async backupAll(backupDir: string): Promise<void> {
    await this.hostExecutor.createDirectory(backupDir);

    for (const service of ALL_CONFIG_SERVICES) {
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

    for (const service of ALL_CONFIG_SERVICES) {
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
    this.logger.info({ backupDir }, 'Restore completed');
  }

  async getRawYaml(service: string): Promise<string> {
    const filePath = `${this.configPath}/${service}.yaml`;
    return this.hostExecutor.readFile(filePath);
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async loadRaw<K extends Open5gsServiceName>(service: K): Promise<Open5gsConfigDocuments[K]> {
    const { doc } = await this.readDocument(service);
    return doc;
  }

  /**
   * Read and parse one config file.
   *
   * `parsed` distinguishes the two failures the old single catch conflated:
   * false means the file WAS read but js-yaml rejected it, while a file that
   * could not be read at all (absent, no permission) is reported as parsed
   * with an empty document. saveRaw() needs that distinction -- merging over
   * an empty document because the real one failed to parse would silently
   * drop every key the NMS does not model (CLAUDE.md pattern #2).
   *
   * The service name picks the document type: the file determines the shape,
   * so the one cast here is the parse boundary and nothing downstream needs
   * to assert anything.
   */
  private async readDocument<K extends Open5gsServiceName>(
    service: K,
  ): Promise<{ doc: Open5gsConfigDocuments[K]; parsed: boolean; existed: boolean }> {
    const filePath = `${this.configPath}/${service}.yaml`;
    const empty = {} as Open5gsConfigDocuments[K];

    let content: string;
    try {
      content = await this.hostExecutor.readFile(filePath);
    } catch (err) {
      this.logger.warn({ service, filePath, err: String(err) }, 'Config file could not be read');
      return { doc: empty, parsed: true, existed: false };
    }

    try {
      // mme.yaml uses duplicate map: keys (Open5GS extension, not standard YAML).
      // Convert them to a maps: array so js-yaml can parse all entries.
      const normalized = service === 'mme' ? convertRepeatedMapKeysToArray(content) : content;

      // A bare `mcc: 001` parses to the number 1, losing the leading zeros.
      // Parse first, then restore MCC/MNC/SD from raw text.
      const loaded: unknown = yaml.load(normalized);
      if (!isYamlMap(loaded)) {
        // An empty file parses to undefined/null, which is not a corrupt file.
        const blank = content.trim() === '';
        if (!blank) this.logger.warn({ service, filePath }, 'Config file is not a YAML mapping');
        return { doc: empty, parsed: blank, existed: true };
      }
      const fixedDoc = this.fixMccMncSdFromRawYaml(normalized, loaded);
      const cleanedDoc = this.preserveEmptyClient(fixedDoc);
      return {
        doc: (isYamlMap(cleanedDoc) ? cleanedDoc : {}) as Open5gsConfigDocuments[K],
        parsed: true,
        existed: true,
      };
    } catch (err) {
      this.logger.error({ service, filePath, err: String(err) }, 'Config file failed to parse');
      return { doc: empty, parsed: false, existed: true };
    }
  }

  // ── Deep merge: overlay wins on scalars and arrays, objects are merged recursively ──
  // This preserves unknown fields (e.g. manually added dev:, custom session entries)
  // that the NMS UI doesn't know about.
  private deepMerge(base: unknown, overlay: unknown): unknown {
    // Scalars, arrays, null: overlay always wins
    if (!isYamlMap(overlay) || !isYamlMap(base)) return overlay;

    // Both are plain objects — merge key by key
    const result: Record<string, unknown> = { ...base };
    for (const key of Object.keys(overlay)) {
      const ov = overlay[key];
      const bv = base[key];
      result[key] = isYamlMap(ov) && isYamlMap(bv) ? this.deepMerge(bv, ov) : ov;
    }
    return result;
  }

  private async saveRaw<K extends Open5gsServiceName>(
    service: K,
    doc: Open5gsConfigDocuments[K],
  ): Promise<void> {
    const filePath = `${this.configPath}/${service}.yaml`;

    // ── Round-trip safety: merge incoming doc over the current on-disk file ──
    // This preserves fields the NMS UI never touched (e.g. manual dev: bindings,
    // custom session entries, unknown top-level keys). The incoming doc wins on
    // every key it contains; keys only present on disk are kept as-is.
    // Arrays are NOT merged — the incoming array replaces the on-disk array
    // (so deleting a session pool via the UI actually removes it).
    //
    // Real bug (found 2026-07-19 via the PLMN Migration Wizard's Phase C, which
    // reused this exact path): this used to re-read the current file with a
    // plain `yaml.load()`, NOT through loadRaw()'s own fixMccMncSdFromRawYaml()
    // string-preservation step. Any partial-patch save (a caller's `doc` that
    // doesn't include, say, plmn_support because it's only patching sbi) merges
    // in whatever plain yaml.load() produced for the untouched fields — and a
    // leading-zero bare scalar loses its zeros there (`001` -> the number 1),
    // silently corrupting any mcc/mnc/sd value with a leading zero that a save
    // call doesn't explicitly re-supply. (This comment used to say js-yaml read
    // `070` as OCTAL 56. Measured false on js-yaml 4.3.1 — it is decimal 70,
    // octal needs `0o` — but the corruption it describes is real and the fix is
    // unchanged. See __tests__/jsyaml-leading-zero.test.ts.)
    // Confirmed live: amf.yaml's guami/tai/plmn_support mcc/mnc were correctly
    // "001"/"01" right after one save, then silently became the numbers 1/1
    // after a second, sbi-only save merged over them. loadRaw() already solves
    // this exact problem for normal reads — reuse it here instead of
    // duplicating (and getting wrong) the same parse.
    //
    // A file that EXISTS but does not parse is refused rather than merged over
    // (added 2026-11-26). The merge source used to be loadRaw(), which reported
    // a parse failure as an empty document -- indistinguishable from "no file" --
    // so one hand-edit with a YAML syntax error turned the next Apply Config
    // into a silent overwrite that dropped every unknown key AND the operator's
    // broken edit, with nothing but a log line. Restore Defaults is the
    // deliberate way to replace a file that cannot be read.
    const current = await this.readDocument(service);
    if (!current.parsed) {
      throw new Error(
        `Refusing to save ${service}.yaml: the file on disk could not be parsed, ` +
        'so merging over it would discard its contents. Fix the YAML syntax (or ' +
        'use Restore Defaults to replace the file) and try again.',
      );
    }

    let mergedDoc: Open5gsConfigDocuments[K] = doc;
    if (Object.keys(current.doc).length > 0) {
      const merged = this.deepMerge(current.doc, doc);
      if (isYamlMap(merged)) mergedDoc = merged as Open5gsConfigDocuments[K];
      this.logger.debug({ service }, 'Deep-merged incoming config over on-disk file');
    } else {
      this.logger.debug({ service }, 'No existing file to merge; writing fresh');
    }

    // Keep mcc/mnc/sd as strings, convert everything else to proper numbers.
    const numbered = this.ensureNumericTypes(mergedDoc);
    const stripped = this.removeNullValues(numbered);
    const cleanDoc: Record<string, unknown> = isYamlMap(stripped) ? stripped : {};

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

  /**
   * GTP-C endpoint.
   *
   * Real bug, confirmed live 2026-11-26: this used to be the one endpoint read
   * WITHOUT a `server[]` branch -- `{ addr: resolveAddr(raw.addr) }` -- while
   * every sibling (parseSbi/parsePfcp/parseGtpu/parseAddrPort) checks
   * `server[0].address` first. No current Open5GS config has a flat `gtpc.addr`
   * at all: all three files that declare a `gtpc:` section on this host
   * (mme/sgwc/smf) use the nested form, so `raw.addr` was always undefined and
   * `resolveAddr(undefined)` returned its 127.0.0.1 fallback -- a plausible
   * address that is simply not the configured one (mme 127.0.0.2,
   * sgwc 127.0.0.3, smf 127.0.0.4).
   *
   * Two real consequences, both user-visible: Packet Capture built SMF's GTP-C
   * filter as `host 127.0.0.1 and udp port 2123`, which matches no SMF GTP-C
   * traffic at all (pcap.ts had already worked around this for mme/sgwc by
   * reading rawYaml, and its comment there records the 2026-07-19 occurrence --
   * but SMF goes through loadSmf() and kept the broken value); and the topology
   * endpoint reports MME at 127.0.0.1:2123, since gtpc is the only address MME
   * exposes through this loader.
   *
   * Returns undefined when no address is configured, so a caller can tell
   * "absent" from "defaulted" -- returning the fallback is what made the wrong
   * value look like a real one.
   */
  private parseGtpc(raw: unknown): { addr: string; port?: number } | undefined {
    if (!isYamlMap(raw)) return undefined;
    const server = raw.server;
    if (Array.isArray(server) && server.length > 0 && isYamlMap(server[0])) {
      const first = server[0];
      const addr = this.firstAddr(first.address);
      if (addr !== undefined) return { addr, port: typeof first.port === 'number' ? first.port : undefined };
    }
    const addr = this.firstAddr(raw.addr);
    if (addr !== undefined) return { addr, port: typeof raw.port === 'number' ? raw.port : undefined };
    return undefined;
  }

  /** First address of a scalar-or-list `address` value, or undefined. */
  private firstAddr(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return undefined;
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
   * Keys whose value must survive a save as a STRING even though it looks
   * numeric. See ensureNumericTypes() for why each one is here.
   */
  private static readonly STRING_VALUED_KEYS: ReadonlySet<string> = new Set([
    'mcc', 'mnc', 'sd', 'qos_index',
  ]);

  /**
   * Recursively convert numeric strings to actual numbers, EXCEPT the keys in
   * STRING_VALUED_KEYS, which must stay strings.
   *
   * mcc/mnc/sd are here to preserve leading zeros and quoted SD. `qos_index`
   * is here because PCF's own qos_profiles entry is deliberately quoted
   * (`qos_index: "1"`) in config/defaults/pcf.yaml, where the comment records
   * that a wrong value there is what produced
   * `403: Unknown qosReference - check PCF qos_profiles config` and blocked
   * 4G<->5G cross-RAT calling. Without the exemption, every single Apply
   * Config rewrote it as a bare `1`, silently undoing the shipped intent --
   * confirmed live 2026-11-26 by diffing the written file against a
   * pre-apply backup.
   */
  private ensureNumericTypes(value: unknown, parentKey?: string): unknown {
    if (value === null || value === undefined) return value;

    if (Array.isArray(value)) {
      return value.map(item => this.ensureNumericTypes(item, parentKey));
    }

    if (isYamlMap(value)) {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        result[key] = YamlConfigRepository.STRING_VALUED_KEYS.has(key)
          ? child // preserve as string
          : this.ensureNumericTypes(child, key);
      }
      return result;
    }

    // Reached for a scalar inside an exempt key's own LIST (the object branch
    // above never recurses into an exempt key), e.g. a list-valued sd.
    if (parentKey !== undefined && YamlConfigRepository.STRING_VALUED_KEYS.has(parentKey)) return value;

    if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) {
      const num = Number(value);
      if (Number.isFinite(num)) return num;
    }

    return value;
  }

  private fixMccMncSdFromRawYaml(rawYaml: string, doc: unknown): unknown {
    return restoreMccMncSdFromRawYaml(rawYaml, doc);
  }

  private preserveEmptyClient(obj: unknown): unknown {
    if (Array.isArray(obj)) return obj.map(item => this.preserveEmptyClient(item));
    if (!isYamlMap(obj)) return obj;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = key === 'client' && value === null ? {} : this.preserveEmptyClient(value);
    }
    return result;
  }

  private removeNullValues(obj: unknown, parentKey?: string): unknown {
    if (obj === null || obj === undefined) {
      return parentKey === 'client' ? {} : undefined;
    }

    if (Array.isArray(obj)) {
      return obj
        .map(item => this.removeNullValues(item, parentKey))
        .filter(item => item !== undefined);
    }

    if (isYamlMap(obj)) {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        if (key === 'client' && (value === null || value === undefined)) {
          result[key] = {};
          continue;
        }
        const cleaned = this.removeNullValues(value, key);
        if (cleaned !== undefined) result[key] = cleaned;
      }
      return result;
    }

    return obj;
  }

  // ── Convenience loaders / savers ─────────────────────────────────────────────
  // These used to end in `as any`, which is what let IConfigRepository claim
  // each one returned a dedicated entity (ScpConfig, MmeConfig, ...) that
  // loadGeneric() has never produced -- see Open5gsConfigDocuments.
  async loadScp(): Promise<NfConfig<'scp'>> { return this.loadGeneric('scp'); }
  async loadUdm(): Promise<NfConfig<'udm'>> { return this.loadGeneric('udm'); }
  async loadUdr(): Promise<NfConfig<'udr'>> { return this.loadGeneric('udr'); }
  async loadPcf(): Promise<NfConfig<'pcf'>> { return this.loadGeneric('pcf'); }
  async loadNssf(): Promise<NfConfig<'nssf'>> { return this.loadGeneric('nssf'); }
  async loadBsf(): Promise<NfConfig<'bsf'>> { return this.loadGeneric('bsf'); }
  async loadMme(): Promise<NfConfig<'mme'>> { return this.loadGeneric('mme'); }
  async loadHss(): Promise<NfConfig<'hss'>> { return this.loadGeneric('hss'); }
  async loadPcrf(): Promise<NfConfig<'pcrf'>> { return this.loadGeneric('pcrf'); }
  async loadSgwc(): Promise<NfConfig<'sgwc'>> { return this.loadGeneric('sgwc'); }
  async loadSgwu(): Promise<NfConfig<'sgwu'>> { return this.loadGeneric('sgwu'); }
  async loadSepp1(): Promise<NfConfig<'sepp1'>> { return this.loadGeneric('sepp1'); }

  async saveScp(config: NfConfig<'scp'>): Promise<void> { return this.saveGeneric('scp', config); }
  async saveUdm(config: NfConfig<'udm'>): Promise<void> { return this.saveGeneric('udm', config); }
  async saveUdr(config: NfConfig<'udr'>): Promise<void> { return this.saveGeneric('udr', config); }
  async savePcf(config: NfConfig<'pcf'>): Promise<void> { return this.saveGeneric('pcf', config); }
  async saveNssf(config: NfConfig<'nssf'>): Promise<void> { return this.saveGeneric('nssf', config); }
  async saveBsf(config: NfConfig<'bsf'>): Promise<void> { return this.saveGeneric('bsf', config); }
  async saveMme(config: NfConfig<'mme'>): Promise<void> { return this.saveGeneric('mme', config); }
  async saveHss(config: NfConfig<'hss'>): Promise<void> { return this.saveGeneric('hss', config); }
  async savePcrf(config: NfConfig<'pcrf'>): Promise<void> { return this.saveGeneric('pcrf', config); }
  async saveSgwc(config: NfConfig<'sgwc'>): Promise<void> { return this.saveGeneric('sgwc', config); }
  async saveSgwu(config: NfConfig<'sgwu'>): Promise<void> { return this.saveGeneric('sgwu', config); }
  async saveSepp1(config: NfConfig<'sepp1'>): Promise<void> { return this.saveGeneric('sepp1', config); }
}
