import pino from 'pino';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { EXTRA_BACKUP_FILES } from '../../infrastructure/yaml/yaml-config-repository';
import * as path from 'path';
import * as fs from 'fs';

export interface BackupListItem {
  name: string;
  path: string;
  timestamp: Date;
  type: 'config' | 'mongodb' | 'combined';
  size?: string;
}

export interface BackupSettings {
  configBackupsToKeep: number;
  mongoBackupsToKeep: number;
}

// ── Full-backup categories ────────────────────────────────────────────────────
// Each category is independently backed up into its own subdirectory of the
// archive and independently selectable on restore. Deliberately excludes the
// IMS database (PyHSS's own MariaDB — a separate system entirely, reinstalled
// and resynced from Open5GS subscribers rather than restored) and the PSTN
// gateway (Asterisk config — the user reinstalls this and resyncs subscribers
// too; its `pstn_extensions` Mongo collection rides along inside the
// `subscribers` category's dump but restoring it is harmless either way).
export type BackupCategory =
  | 'subscribers'
  | 'core-configs'
  | 'suci-keys'
  | 'optional-modules'
  | 'l3-network'
  | 'dns';

export interface BackupCategoryInfo {
  id: BackupCategory;
  label: string;
  description: string;
  present: boolean;
  itemCount: number;
}

const CORE_SERVICES = ['nrf', 'scp', 'amf', 'smf', 'upf', 'ausf', 'udm', 'udr', 'pcf', 'nssf', 'bsf', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu'];

// SUCI/SUPI concealment home-network private keys — referenced by *path* from
// udm.yaml's `hnet:` block, never embedded in it. Losing this directory
// permanently breaks SUCI de-concealment for every 5G subscriber using it;
// the old backup only ever copied udm.yaml itself (a pointer to these files,
// not the key material). `/etc/open5gs` is bind-mounted directly into this
// container (see docker-compose.yml), so no /proc/1/root prefix needed here.
const SUCI_KEY_DIR = '/etc/open5gs/hnet';

// L3/FRR — genuinely not derivable from anything else backed up elsewhere:
// frr.conf/daemons is the real EIGRP config, and the netplan file carries the
// host's own physical interface addressing (e.g. ens20's point-to-point IP
// for the EIGRP neighbor), not just NF-config-derived dummy interfaces. None
// of these paths are bind-mounted into this container — go through
// /proc/1/root like every other host-file access pattern in this codebase.
const HOST_FRR_CONF = '/proc/1/root/etc/frr/frr.conf';
const HOST_FRR_DAEMONS = '/proc/1/root/etc/frr/daemons';
const HOST_NETPLAN = '/proc/1/root/etc/netplan/60-open5gs-managed.yaml';

// DNS/BIND — the FQDN-based NF discovery zones (5gc/epc/ims/pub) this whole
// project's addressing scheme depends on. Not explicitly named by the user's
// "IP configs" request but squarely part of it in any normal reading.
const HOST_BIND_DIR = '/proc/1/root/etc/bind';
const HOST_BIND_ZONES_DIR = '/proc/1/root/etc/bind/zones';

export class BackupRestoreUseCase {
  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly configRepo: IConfigRepository,
    private readonly logger: pino.Logger,
    private readonly configBackupPath: string,
    private readonly mongoBackupPath: string,
  ) {}

  // ── Full backup (all categories, one archive) ──────────────────────────────

  async createFullBackup(): Promise<{ success: boolean; archivePath: string; error?: string }> {
    let tmpDir = '';
    try {
      const now = new Date();
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
      const dirName = `open5gs-full-backup-${dateStr}`;
      tmpDir = `/tmp/${dirName}`;
      const archivePath = `/tmp/${dirName}.tar.gz`;

      this.logger.info({ tmpDir, archivePath }, 'Creating full backup archive');

      await this.hostExecutor.executeLocalCommand('mkdir', [
        '-p',
        `${tmpDir}/subscribers`, `${tmpDir}/core-configs`, `${tmpDir}/suci-keys`,
        `${tmpDir}/optional-modules`, `${tmpDir}/l3-network`, `${tmpDir}/dns`,
      ]);

      const categories: Record<BackupCategory, BackupCategoryInfo> = {
        subscribers: { id: 'subscribers', label: 'Subscribers & SAS', description: 'MongoDB `open5gs` database — subscribers (incl. APNs/IPs/security keys), SAS grants/CBSDs, subscriber groups', present: false, itemCount: 0 },
        'core-configs': { id: 'core-configs', label: 'Core NF Configs', description: `${CORE_SERVICES.length} core Open5GS NF YAML files`, present: false, itemCount: 0 },
        'suci-keys': { id: 'suci-keys', label: 'SUCI Keys', description: 'SUCI/SUPI concealment home-network private/public keys (5G-AKA)', present: false, itemCount: 0 },
        'optional-modules': { id: 'optional-modules', label: 'Optional Module Configs', description: 'SMS-over-SGs (Osmocom) and VoWiFi (VectorCore) configs', present: false, itemCount: 0 },
        'l3-network': { id: 'l3-network', label: 'L3 / IP Network Config', description: 'FRR (EIGRP) config and host interface addressing (netplan)', present: false, itemCount: 0 },
        dns: { id: 'dns', label: 'DNS / BIND', description: 'BIND9 named.conf + all FQDN zone files', present: false, itemCount: 0 },
      };

      // subscribers — MongoDB, scoped to the `open5gs` database only. The old
      // code ran a bare `mongodump -o dir` with no --db, which blindly dumped
      // *every* database on the instance, including GenieACS's own DB and
      // Mongo's internal admin/config/local system databases — restoring
      // those onto a different host risks corrupting auth/replication state
      // for no benefit, since none of it is data this backup is meant to
      // cover. Scoped down as part of this audit.
      const mongoResult = await this.hostExecutor.executeLocalCommand('mongodump', ['--db', 'open5gs', '-o', `${tmpDir}/subscribers`]);
      if (mongoResult.exitCode !== 0) {
        throw new Error(`mongodump failed: ${mongoResult.stderr}`);
      }
      categories.subscribers.present = true;
      this.logger.info('MongoDB (open5gs db) dump complete');

      // core-configs
      for (const service of CORE_SERVICES) {
        try {
          await this.hostExecutor.copyFile(`/etc/open5gs/${service}.yaml`, `${tmpDir}/core-configs/${service}.yaml`);
          categories['core-configs'].itemCount++;
        } catch {
          this.logger.warn({ service }, 'Config file not found, skipping');
        }
      }
      categories['core-configs'].present = categories['core-configs'].itemCount > 0;

      // suci-keys
      try {
        if (fs.existsSync(SUCI_KEY_DIR)) {
          const keyFiles = fs.readdirSync(SUCI_KEY_DIR);
          for (const f of keyFiles) {
            fs.copyFileSync(`${SUCI_KEY_DIR}/${f}`, `${tmpDir}/suci-keys/${f}`);
          }
          categories['suci-keys'].itemCount = keyFiles.length;
          categories['suci-keys'].present = keyFiles.length > 0;
        }
      } catch (err) {
        this.logger.warn({ err: String(err) }, 'SUCI key directory not found or unreadable, skipping');
      }

      // optional-modules (SMS-over-SGs / VoWiFi)
      for (const filePath of EXTRA_BACKUP_FILES) {
        try {
          await this.hostExecutor.copyFile(`/proc/1/root${filePath}`, `${tmpDir}/optional-modules/${path.basename(filePath)}`);
          categories['optional-modules'].itemCount++;
        } catch {
          this.logger.warn({ filePath }, 'Optional-module config not found, skipping');
        }
      }
      categories['optional-modules'].present = categories['optional-modules'].itemCount > 0;

      // l3-network (FRR + netplan)
      for (const [src, name] of [[HOST_FRR_CONF, 'frr.conf'], [HOST_FRR_DAEMONS, 'daemons'], [HOST_NETPLAN, '60-open5gs-managed.yaml']] as const) {
        try {
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, `${tmpDir}/l3-network/${name}`);
            categories['l3-network'].itemCount++;
          }
        } catch (err) {
          this.logger.warn({ src, err: String(err) }, 'L3/network config not found, skipping');
        }
      }
      categories['l3-network'].present = categories['l3-network'].itemCount > 0;

      // dns (BIND)
      try {
        for (const name of ['named.conf.local', 'named.conf.options']) {
          const src = `${HOST_BIND_DIR}/${name}`;
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, `${tmpDir}/dns/${name}`);
            categories.dns.itemCount++;
          }
        }
        if (fs.existsSync(HOST_BIND_ZONES_DIR)) {
          fs.mkdirSync(`${tmpDir}/dns/zones`, { recursive: true });
          const zoneFiles = fs.readdirSync(HOST_BIND_ZONES_DIR);
          for (const f of zoneFiles) {
            fs.copyFileSync(`${HOST_BIND_ZONES_DIR}/${f}`, `${tmpDir}/dns/zones/${f}`);
          }
          categories.dns.itemCount += zoneFiles.length;
        }
        categories.dns.present = categories.dns.itemCount > 0;
      } catch (err) {
        this.logger.warn({ err: String(err) }, 'DNS/BIND config not found, skipping');
      }

      this.logger.info({ categories }, 'All backup categories collected');

      const manifest = JSON.stringify({
        version: '2.0',
        createdAt: now.toISOString(),
        categories,
      }, null, 2);
      await fs.promises.writeFile(`${tmpDir}/manifest.json`, manifest, 'utf8');

      const tarResult = await this.hostExecutor.executeLocalCommand('tar', [
        '-czf', archivePath,
        '-C', '/tmp',
        dirName,
      ]);
      if (tarResult.exitCode !== 0) {
        throw new Error(`tar failed: ${tarResult.stderr}`);
      }

      await this.hostExecutor.executeLocalCommand('rm', ['-rf', tmpDir]);

      this.logger.info({ archivePath }, 'Full backup archive created successfully');
      return { success: true, archivePath };
    } catch (err) {
      await this.hostExecutor.executeLocalCommand('rm', ['-rf', tmpDir]).catch(() => {});
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error }, 'Full backup failed');
      return { success: false, archivePath: '', error };
    }
  }

  // ── Zip Slip prevention — shared by inspect and restore ────────────────────
  private async validateArchiveMembers(archivePath: string): Promise<void> {
    const listResult = await this.hostExecutor.executeLocalCommand('tar', ['-tvf', archivePath]);
    if (listResult.exitCode !== 0) {
      throw new Error(`Failed to read archive members: ${listResult.stderr}`);
    }
    for (const line of listResult.stdout.split('\n')) {
      if (!line.trim()) continue;
      const typeChar = line[0];
      if (typeChar === 'l' || typeChar === 'h' || typeChar === 'b' || typeChar === 'c' || typeChar === 'p') {
        throw new Error(`Archive rejected: contains unsafe entry type '${typeChar}' in line: ${line.trim()}`);
      }
      const parts = line.trim().split(/\s+/);
      const memberPath = parts[parts.length - 1];
      if (!memberPath) continue;
      if (memberPath.startsWith('/')) {
        throw new Error(`Archive rejected: contains absolute path '${memberPath}'`);
      }
      if (memberPath.split('/').some(seg => seg === '..')) {
        throw new Error(`Archive rejected: contains path traversal component in '${memberPath}'`);
      }
    }
  }

  // ── Inspect an uploaded/existing archive without restoring anything ───────
  async inspectFullBackup(archivePath: string): Promise<{ success: boolean; categories?: BackupCategoryInfo[]; createdAt?: string; error?: string }> {
    const tmpDir = `/tmp/open5gs-full-inspect-${Date.now()}`;
    try {
      await this.validateArchiveMembers(archivePath);

      await this.hostExecutor.executeLocalCommand('mkdir', ['-p', tmpDir]);
      // Only pull out the manifest — no need to extract the whole archive to inspect it.
      const extractResult = await this.hostExecutor.executeLocalCommand('tar', [
        '-xzf', archivePath, '-C', tmpDir, '--strip-components=1',
        '--wildcards', '*/manifest.json', 'manifest.json',
      ]);
      let manifestPath = `${tmpDir}/manifest.json`;
      if (extractResult.exitCode !== 0 || !fs.existsSync(manifestPath)) {
        // Older (pre-category) backups have no manifest at all — fall back to
        // a full extraction so we can still detect what's inside by directory.
        await this.hostExecutor.executeLocalCommand('rm', ['-rf', tmpDir]);
        await this.hostExecutor.executeLocalCommand('mkdir', ['-p', tmpDir]);
        const fullExtract = await this.hostExecutor.executeLocalCommand('tar', ['-xzf', archivePath, '-C', tmpDir, '--strip-components=1']);
        if (fullExtract.exitCode !== 0) {
          throw new Error(`tar extract failed: ${fullExtract.stderr}`);
        }
        manifestPath = `${tmpDir}/manifest.json`;
      }

      let categories: BackupCategoryInfo[];
      let createdAt: string | undefined;
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        createdAt = manifest.createdAt;
        if (manifest.categories) {
          categories = Object.values(manifest.categories);
        } else {
          // v1.0 manifest: only { contents: ['mongodb','config'] }, no per-category detail.
          categories = this.legacyManifestToCategories(tmpDir);
        }
      } else {
        categories = this.legacyManifestToCategories(tmpDir);
      }

      await this.hostExecutor.executeLocalCommand('rm', ['-rf', tmpDir]);
      return { success: true, categories, createdAt };
    } catch (err) {
      await this.hostExecutor.executeLocalCommand('rm', ['-rf', tmpDir]).catch(() => {});
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error, archivePath }, 'Failed to inspect backup archive');
      return { success: false, error };
    }
  }

  // Best-effort category detection for archives with no per-category manifest
  // (pre-2026-08-02 full backups: just `mongodb/` and `config/` directories).
  private legacyManifestToCategories(tmpDir: string): BackupCategoryInfo[] {
    const has = (p: string) => { try { return fs.existsSync(`${tmpDir}/${p}`); } catch { return false; } };
    return [
      { id: 'subscribers', label: 'Subscribers & SAS', description: 'MongoDB dump (legacy archive — may include extra databases)', present: has('mongodb'), itemCount: 0 },
      { id: 'core-configs', label: 'Core NF Configs', description: 'Core Open5GS NF YAML files', present: has('config'), itemCount: 0 },
      { id: 'suci-keys', label: 'SUCI Keys', description: 'Not present in this legacy archive', present: false, itemCount: 0 },
      { id: 'optional-modules', label: 'Optional Module Configs', description: 'SMS-over-SGs / VoWiFi configs (legacy archive — bundled with core configs)', present: has('config'), itemCount: 0 },
      { id: 'l3-network', label: 'L3 / IP Network Config', description: 'Not present in this legacy archive', present: false, itemCount: 0 },
      { id: 'dns', label: 'DNS / BIND', description: 'Not present in this legacy archive', present: false, itemCount: 0 },
    ];
  }

  // ── Restore selected categories from an already-uploaded/on-disk archive ──
  async restoreFullBackup(archivePath: string, selectedCategories?: BackupCategory[]): Promise<{ success: boolean; restored?: BackupCategory[]; error?: string }> {
    const tmpDir = `/tmp/open5gs-full-restore-${Date.now()}`;
    try {
      this.logger.info({ archivePath, tmpDir, selectedCategories }, 'Restoring full backup archive');

      await this.validateArchiveMembers(archivePath);

      await this.hostExecutor.executeLocalCommand('mkdir', ['-p', tmpDir]);
      const tarResult = await this.hostExecutor.executeLocalCommand('tar', ['-xzf', archivePath, '-C', tmpDir, '--strip-components=1']);
      if (tarResult.exitCode !== 0) {
        throw new Error(`tar extract failed: ${tarResult.stderr}`);
      }

      // Default to everything for backward-compat (e.g. scripted/API use) —
      // the UI always passes an explicit selection after an inspect step.
      const isLegacy = !fs.existsSync(`${tmpDir}/manifest.json`) || !JSON.parse(await fs.promises.readFile(`${tmpDir}/manifest.json`, 'utf8')).categories;
      const all: BackupCategory[] = ['subscribers', 'core-configs', 'suci-keys', 'optional-modules', 'l3-network', 'dns'];
      const wanted = new Set(selectedCategories && selectedCategories.length > 0 ? selectedCategories : all);
      const restored: BackupCategory[] = [];

      if (wanted.has('subscribers')) {
        const mongoDir = isLegacy ? `${tmpDir}/mongodb/open5gs` : `${tmpDir}/subscribers/open5gs`;
        const legacyMongoDir = `${tmpDir}/mongodb`;
        const restoreDir = fs.existsSync(mongoDir) ? mongoDir : legacyMongoDir;
        if (fs.existsSync(restoreDir)) {
          const mongoResult = await this.hostExecutor.executeLocalCommand('mongorestore', ['--drop', '--db', 'open5gs', restoreDir]);
          if (mongoResult.exitCode !== 0) {
            // Legacy full-database dumps don't have a single --db-restorable
            // subdirectory laid out the same way — fall back to a plain
            // directory restore for those (pre-existing legacy behavior).
            const fallback = await this.hostExecutor.executeLocalCommand('mongorestore', ['--drop', legacyMongoDir]);
            if (fallback.exitCode !== 0) {
              throw new Error(`mongorestore failed: ${mongoResult.stderr}`);
            }
          }
          restored.push('subscribers');
          this.logger.info('Subscribers/SAS (MongoDB) restored');
        }
      }

      if (wanted.has('core-configs')) {
        const dir = isLegacy ? `${tmpDir}/config` : `${tmpDir}/core-configs`;
        let any = false;
        for (const service of CORE_SERVICES) {
          try {
            await this.hostExecutor.copyFile(`${dir}/${service}.yaml`, `/etc/open5gs/${service}.yaml`);
            any = true;
          } catch {
            this.logger.warn({ service }, 'Config file missing from archive, skipping');
          }
        }
        if (any) restored.push('core-configs');
      }

      if (wanted.has('suci-keys')) {
        try {
          if (fs.existsSync(`${tmpDir}/suci-keys`)) {
            fs.mkdirSync(SUCI_KEY_DIR, { recursive: true });
            for (const f of fs.readdirSync(`${tmpDir}/suci-keys`)) {
              fs.copyFileSync(`${tmpDir}/suci-keys/${f}`, `${SUCI_KEY_DIR}/${f}`);
            }
            restored.push('suci-keys');
            this.logger.info('SUCI keys restored');
          }
        } catch (err) {
          this.logger.warn({ err: String(err) }, 'Failed to restore SUCI keys');
        }
      }

      if (wanted.has('optional-modules')) {
        const dir = isLegacy ? `${tmpDir}/config` : `${tmpDir}/optional-modules`;
        let any = false;
        for (const filePath of EXTRA_BACKUP_FILES) {
          try {
            await this.hostExecutor.copyFile(`${dir}/${path.basename(filePath)}`, `/proc/1/root${filePath}`);
            any = true;
          } catch {
            this.logger.warn({ filePath }, 'Optional-module config missing from archive, skipping');
          }
        }
        if (any) restored.push('optional-modules');
      }

      if (wanted.has('l3-network')) {
        let any = false;
        for (const [dst, name] of [[HOST_FRR_CONF, 'frr.conf'], [HOST_FRR_DAEMONS, 'daemons'], [HOST_NETPLAN, '60-open5gs-managed.yaml']] as const) {
          try {
            const src = `${tmpDir}/l3-network/${name}`;
            if (fs.existsSync(src)) {
              fs.mkdirSync(path.dirname(dst), { recursive: true });
              fs.copyFileSync(src, dst);
              any = true;
            }
          } catch (err) {
            this.logger.warn({ dst, err: String(err) }, 'Failed to restore L3/network config');
          }
        }
        if (any) restored.push('l3-network');
      }

      if (wanted.has('dns')) {
        try {
          let any = false;
          for (const name of ['named.conf.local', 'named.conf.options']) {
            const src = `${tmpDir}/dns/${name}`;
            if (fs.existsSync(src)) {
              fs.mkdirSync(HOST_BIND_DIR, { recursive: true });
              fs.copyFileSync(src, `${HOST_BIND_DIR}/${name}`);
              any = true;
            }
          }
          const zonesSrc = `${tmpDir}/dns/zones`;
          if (fs.existsSync(zonesSrc)) {
            fs.mkdirSync(HOST_BIND_ZONES_DIR, { recursive: true });
            for (const f of fs.readdirSync(zonesSrc)) {
              fs.copyFileSync(`${zonesSrc}/${f}`, `${HOST_BIND_ZONES_DIR}/${f}`);
            }
            any = true;
          }
          if (any) restored.push('dns');
        } catch (err) {
          this.logger.warn({ err: String(err) }, 'Failed to restore DNS/BIND config');
        }
      }

      await this.hostExecutor.executeLocalCommand('rm', ['-rf', tmpDir]);
      await this.hostExecutor.executeLocalCommand('rm', ['-f', archivePath]).catch(() => {});

      this.logger.info({ restored }, 'Full backup restore complete');
      return { success: true, restored };
    } catch (err) {
      await this.hostExecutor.executeLocalCommand('rm', ['-rf', tmpDir]).catch(() => {});
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error }, 'Full backup restore failed');
      return { success: false, error };
    }
  }

  // ── MongoDB-only backup/restore (legacy, `open5gs` db scoped) ──────────────

  async createMongoBackup(): Promise<{ success: boolean; backupName: string; error?: string }> {
    try {
      const dateStr = new Date().toISOString().split('T')[0].split('-').reverse().join('-'); // dd-mm-yyyy
      const backupName = `Open5Gs_${dateStr}`;
      const backupPath = `${this.mongoBackupPath}/${backupName}`;

      this.logger.info({ backupName, backupPath }, 'Creating MongoDB backup');

      const result = await this.hostExecutor.executeLocalCommand('mongodump', ['--db', 'open5gs', '-o', backupPath]);

      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `mongodump failed with exit code ${result.exitCode}`);
      }

      this.logger.info({ backupName }, 'MongoDB backup created successfully');
      return { success: true, backupName };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error }, 'MongoDB backup failed');
      return { success: false, backupName: '', error };
    }
  }

  async restoreMongoBackup(backupName: string): Promise<{ success: boolean; error?: string }> {
    try {
      const backupPath = `${this.mongoBackupPath}/${backupName}`;

      this.logger.info({ backupName, backupPath }, 'Restoring MongoDB backup');

      const exists = await this.hostExecutor.fileExists(backupPath);
      if (!exists) {
        throw new Error(`Backup not found: ${backupName}`);
      }

      // Newer backups are scoped to `${backupPath}/open5gs`; older ones dumped
      // every database straight into `backupPath`. Try the scoped path first.
      const scopedPath = `${backupPath}/open5gs`;
      const scopedExists = await this.hostExecutor.fileExists(scopedPath);
      const result = scopedExists
        ? await this.hostExecutor.executeLocalCommand('mongorestore', ['--drop', '--db', 'open5gs', scopedPath])
        : await this.hostExecutor.executeLocalCommand('mongorestore', ['--drop', backupPath]);

      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `mongorestore failed with exit code ${result.exitCode}`);
      }

      this.logger.info({ backupName }, 'MongoDB backup restored successfully');
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error, backupName }, 'MongoDB restore failed');
      return { success: false, error };
    }
  }

  async createConfigBackup(): Promise<{ success: boolean; backupName: string; error?: string }> {
    try {
      const now = new Date();
      const backupName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
      const backupPath = `${this.configBackupPath}/${backupName}`;

      this.logger.info({ backupName, backupPath }, 'Creating config backup');

      await this.configRepo.backupAll(backupPath);

      this.logger.info({ backupName }, 'Config backup created successfully');
      return { success: true, backupName };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error }, 'Config backup failed');
      return { success: false, backupName: '', error };
    }
  }

  async restoreConfigBackup(backupName: string): Promise<{ success: boolean; error?: string }> {
    try {
      const backupPath = `${this.configBackupPath}/${backupName}`;

      this.logger.info({ backupName, backupPath }, 'Restoring config backup');

      await this.configRepo.restoreBackup(backupPath);

      this.logger.info({ backupName }, 'Config backup restored successfully');
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error, backupName }, 'Config restore failed');
      return { success: false, error };
    }
  }

  async listMongoBackups(): Promise<BackupListItem[]> {
    try {
      const entries = await this.hostExecutor.listDirectory(this.mongoBackupPath);

      const backups = entries
        .filter(name => name.trim().length > 0 && name.startsWith('Open5Gs_'))
        .map(name => {
          // Parse date from Open5Gs_dd-mm-yyyy format
          const datePart = name.replace('Open5Gs_', '');
          const [day, month, year] = datePart.split('-');
          const timestamp = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));

          return {
            name,
            path: `${this.mongoBackupPath}/${name}`,
            timestamp,
            type: 'mongodb' as const,
          };
        })
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      return backups;
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'No MongoDB backups found or directory does not exist');
      return [];
    }
  }

  async listConfigBackups(): Promise<BackupListItem[]> {
    try {
      const entries = await this.hostExecutor.listDirectory(this.configBackupPath);

      // Only match yyyy-mm-dd-hhmm format (e.g. 2026-03-04-1430)
      // This excludes pre-restore-* and any other non-backup directories
      const configBackupPattern = /^\d{4}-\d{2}-\d{2}-\d{4}$/;

      const backups = entries
        .filter(name => configBackupPattern.test(name.trim()))
        .map(name => {
          // Parse date from yyyy-mm-dd-hhmm format
          const parts = name.split('-');
          const year = parseInt(parts[0]);
          const month = parseInt(parts[1]) - 1;
          const day = parseInt(parts[2]);
          const hour = parseInt(parts[3]?.substring(0, 2) || '0');
          const minute = parseInt(parts[3]?.substring(2) || '0');
          const timestamp = new Date(year, month, day, hour, minute);

          // Skip if date parsing produced an invalid date
          if (isNaN(timestamp.getTime())) {
            this.logger.warn({ name }, 'Skipping backup with unparseable date');
            return null;
          }

          return {
            name,
            path: `${this.configBackupPath}/${name}`,
            timestamp,
            type: 'config' as const,
          };
        })
        .filter((b): b is NonNullable<typeof b> => b !== null)
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      return backups;
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'No config backups found or directory does not exist');
      return [];
    }
  }

  async cleanupOldBackups(settings: BackupSettings): Promise<void> {
    try {
      // Cleanup old MongoDB backups
      const mongoBackups = await this.listMongoBackups();
      if (mongoBackups.length > settings.mongoBackupsToKeep) {
        const toDelete = mongoBackups.slice(settings.mongoBackupsToKeep);
        for (const backup of toDelete) {
          await this.hostExecutor.executeCommand('rm', ['-rf', backup.path]);
          this.logger.info({ backup: backup.name }, 'Deleted old MongoDB backup');
        }
      }

      // Cleanup old config backups
      const configBackups = await this.listConfigBackups();
      if (configBackups.length > settings.configBackupsToKeep) {
        const toDelete = configBackups.slice(settings.configBackupsToKeep);
        for (const backup of toDelete) {
          await this.hostExecutor.executeCommand('rm', ['-rf', backup.path]);
          this.logger.info({ backup: backup.name }, 'Deleted old config backup');
        }
      }
    } catch (err) {
      this.logger.error({ err: String(err) }, 'Failed to cleanup old backups');
    }
  }

  async getLastConfigBackup(): Promise<string | null> {
    const backups = await this.listConfigBackups();
    return backups.length > 0 ? backups[0].name : null;
  }

  async restoreBoth(configBackupName: string, mongoBackupName: string): Promise<{ success: boolean; errors: string[] }> {
    const errors: string[] = [];

    // Restore config
    const configResult = await this.restoreConfigBackup(configBackupName);
    if (!configResult.success) {
      errors.push(`Config restore failed: ${configResult.error}`);
    }

    // Restore MongoDB
    const mongoResult = await this.restoreMongoBackup(mongoBackupName);
    if (!mongoResult.success) {
      errors.push(`MongoDB restore failed: ${mongoResult.error}`);
    }

    return {
      success: errors.length === 0,
      errors,
    };
  }

  async getConfigDiff(backupName: string): Promise<{ success: boolean; files?: Record<string, { current: string; backup: string; hasDiff: boolean }>; error?: string }> {
    try {
      const backupPath = `${this.configBackupPath}/${backupName}`;

      // Check if backup exists
      const exists = await this.hostExecutor.fileExists(backupPath);
      if (!exists) {
        throw new Error(`Backup not found: ${backupName}`);
      }

      const services = ['nrf', 'scp', 'amf', 'smf', 'upf', 'ausf', 'udm', 'udr', 'pcf', 'nssf', 'bsf', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu'];
      const files: Record<string, { current: string; backup: string; hasDiff: boolean }> = {};

      for (const service of services) {
        try {
          // Get current YAML
          const current = await this.configRepo.getRawYaml(service);

          // Get backup YAML
          const backupFilePath = `${backupPath}/${service}.yaml`;
          const backup = await this.hostExecutor.readFile(backupFilePath);

          files[service] = {
            current,
            backup,
            hasDiff: current.trim() !== backup.trim(),
          };
        } catch (err) {
          this.logger.warn({ service, err: String(err) }, 'Failed to load config for diff');
          // Skip this service if it doesn't exist
        }
      }

      return { success: true, files };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error, backupName }, 'Failed to generate config diff');
      return { success: false, error };
    }
  }

  async restoreSelectedConfigs(backupName: string, services: string[]): Promise<{ success: boolean; restored: string[]; errors: Record<string, string> }> {
    try {
      const backupPath = `${this.configBackupPath}/${backupName}`;

      // Check if backup exists
      const exists = await this.hostExecutor.fileExists(backupPath);
      if (!exists) {
        throw new Error(`Backup not found: ${backupName}`);
      }

      const restored: string[] = [];
      const errors: Record<string, string> = {};

      for (const service of services) {
        try {
          const backupFilePath = `${backupPath}/${service}.yaml`;
          const currentFilePath = `/etc/open5gs/${service}.yaml`;

          // Copy backup file to current location
          await this.hostExecutor.copyFile(backupFilePath, currentFilePath);
          restored.push(service);
          this.logger.info({ service }, 'Config file restored');
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          errors[service] = error;
          this.logger.error({ service, err: error }, 'Failed to restore config file');
        }
      }

      return {
        success: Object.keys(errors).length === 0,
        restored,
        errors,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error, backupName }, 'Selective config restore failed');
      throw err;
    }
  }
}
