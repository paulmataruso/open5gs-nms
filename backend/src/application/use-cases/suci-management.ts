import pino from 'pino';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { IConfigRepository } from '../../domain/interfaces/config-repository';

export interface HnetKey {
  id: number;
  scheme: 1 | 2;
  keyFile: string;
  fileExists: boolean;
  publicKeyHex: string | null;
  profile: 'A' | 'B';
  schemeLabel: string;
  algorithm: string;
}

export interface SuciKeysResult {
  keys: HnetKey[];
  hnetDir: string;
}

export interface GenerateKeyInput {
  id: number;
  scheme: 1 | 2;
}

export class SuciManagementUseCase {
  private readonly hnetDir = '/etc/open5gs/hnet';
  private readonly suciKeytool = '/opt/pysim/contrib/suci-keytool.py';

  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly configRepo: IConfigRepository,
    private readonly logger: pino.Logger,
  ) {}

  async listKeys(): Promise<SuciKeysResult> {
    this.logger.info('Loading SUCI keys from udm.yaml');

    const raw = await this.getRawUdm();
    const hnetEntries = this.parseHnet(raw);

    const keys: HnetKey[] = await Promise.all(
      hnetEntries.map(async (entry) => {
        const fileExists = await this.hostExecutor.fileExists(entry.key);
        let publicKeyHex: string | null = null;

        if (fileExists) {
          try {
            publicKeyHex = await this.extractPublicKey(entry.scheme, entry.key);
          } catch (err) {
            this.logger.warn({ err: String(err), key: entry.key }, 'Failed to extract public key');
          }
        }

        return {
          id: entry.id,
          scheme: entry.scheme as 1 | 2,
          keyFile: entry.key,
          fileExists,
          publicKeyHex,
          profile: entry.scheme === 1 ? 'A' : 'B',
          schemeLabel: entry.scheme === 1 ? 'Profile A (X25519)' : 'Profile B (secp256r1)',
          algorithm: entry.scheme === 1 ? 'X25519 / curve25519' : 'secp256r1 / prime256v1',
        };
      }),
    );

    return { keys, hnetDir: this.hnetDir };
  }

  async generateKey(input: GenerateKeyInput): Promise<HnetKey> {
    const { id, scheme } = input;
    this.logger.info({ id, scheme }, 'Generating new SUCI key via suci-keytool.py');

    await this.hostExecutor.createDirectory(this.hnetDir);

    const curve    = scheme === 1 ? 'curve25519' : 'secp256r1';
    const fileName = scheme === 1 ? `curve25519-${id}.key` : `secp256r1-${id}.key`;
    const keyPath  = `${this.hnetDir}/${fileName}`;

    const result = await this.hostExecutor.executeLocalCommand('python3', [
      this.suciKeytool,
      '--key-file', keyPath,
      'generate-key',
      '--curve', curve,
    ]);

    if (result.exitCode !== 0) {
      this.logger.error({ exitCode: result.exitCode, stderr: result.stderr }, 'suci-keytool generate-key failed');
      throw new Error(`Key generation failed: ${result.stderr}`);
    }
    this.logger.info({ keyPath, curve }, 'Key file generated via suci-keytool.py');

    // Extract the public key
    const publicKeyHex = await this.extractPublicKey(scheme, keyPath);

    // Update udm.yaml
    await this.addKeyToUdmYaml(id, scheme, keyPath);

    return {
      id,
      scheme,
      keyFile: keyPath,
      fileExists: true,
      publicKeyHex,
      profile: scheme === 1 ? 'A' : 'B',
      schemeLabel: scheme === 1 ? 'Profile A (X25519)' : 'Profile B (secp256r1)',
      algorithm: scheme === 1 ? 'X25519 / curve25519' : 'secp256r1 / prime256v1',
    };
  }

  async deleteKey(id: number, deleteFile: boolean): Promise<void> {
    this.logger.info({ id, deleteFile }, 'Deleting SUCI key');

    const raw = await this.getRawUdm();
    const hnetEntries = this.parseHnet(raw);

    const entry = hnetEntries.find((e) => e.id === id);
    if (!entry) {
      throw new Error(`Key ID ${id} not found in udm.yaml`);
    }

    // Remove from hnet array
    const newEntries = hnetEntries.filter((e) => e.id !== id);
    await this.saveHnet(raw, newEntries);

    // Optionally delete the file
    if (deleteFile && entry.key) {
      try {
        await this.hostExecutor.executeCommand('rm', ['-f', entry.key]);
        this.logger.info({ keyFile: entry.key }, 'Key file deleted');
      } catch (err) {
        this.logger.warn({ err: String(err) }, 'Failed to delete key file');
      }
    }
  }

  async renameKey(currentId: number, newId: number): Promise<HnetKey> {
    this.logger.info({ currentId, newId }, 'Renaming SUCI key PKI ID');

    const raw = await this.getRawUdm();
    const entries = this.parseHnet(raw);

    // Validate current key exists
    const entry = entries.find((e) => e.id === currentId);
    if (!entry) {
      throw new Error(`Key ID ${currentId} not found in udm.yaml`);
    }

    // Validate new ID is not already taken
    if (entries.some((e) => e.id === newId)) {
      throw new Error(`Key ID ${newId} is already in use`);
    }

    // Rename the physical key file if it exists
    let newKeyPath = entry.key;
    const fileExists = await this.hostExecutor.fileExists(entry.key);
    if (fileExists) {
      // Derive new filename by replacing the ID in the filename
      // e.g. curve25519-1.key → curve25519-30.key
      const oldFileName = entry.key.split('/').pop() || '';
      const newFileName = oldFileName.replace(
        /(curve25519-|secp256r1-)(\d+)(\.key)/,
        `$1${newId}$3`,
      );
      newKeyPath = `${this.hnetDir}/${newFileName}`;

      if (newKeyPath !== entry.key) {
        await this.hostExecutor.executeCommand('mv', [entry.key, newKeyPath]);
        this.logger.info({ from: entry.key, to: newKeyPath }, 'Key file renamed');
      }
    }

    // Update the entry in udm.yaml
    const updatedEntries = entries.map((e) =>
      e.id === currentId ? { id: newId, scheme: e.scheme, key: newKeyPath } : e,
    );
    updatedEntries.sort((a, b) => a.id - b.id);
    await this.saveHnet(raw, updatedEntries);

    // Extract public key from the (possibly renamed) file
    let publicKeyHex: string | null = null;
    const newFileExists = await this.hostExecutor.fileExists(newKeyPath);
    if (newFileExists) {
      try {
        publicKeyHex = await this.extractPublicKey(entry.scheme, newKeyPath);
      } catch (err) {
        this.logger.warn({ err: String(err) }, 'Failed to extract public key after rename');
      }
    }

    return {
      id: newId,
      scheme: entry.scheme as 1 | 2,
      keyFile: newKeyPath,
      fileExists: newFileExists,
      publicKeyHex,
      profile: entry.scheme === 1 ? 'A' : 'B',
      schemeLabel: entry.scheme === 1 ? 'Profile A (X25519)' : 'Profile B (secp256r1)',
      algorithm: entry.scheme === 1 ? 'X25519 / curve25519' : 'secp256r1 / prime256v1',
    };
  }

  async getNextAvailableId(): Promise<number> {
    const raw = await this.getRawUdm();
    const entries = this.parseHnet(raw);
    const usedIds = new Set(entries.map((e) => e.id));
    for (let i = 1; i <= 255; i++) {
      if (!usedIds.has(i)) return i;
    }
    throw new Error('All 255 key IDs are in use');
  }

  // ── Private helpers ──

  private async extractPublicKey(scheme: number, keyPath: string): Promise<string> {
    this.logger.info({ scheme, keyPath }, 'Extracting public key via suci-keytool.py');

    // suci-keytool dump-pub-key:
    //   curve25519 (scheme 1): no --compressed flag — raw 32-byte key (64 hex chars)
    //   secp256r1  (scheme 2): --compressed flag — compressed point 02/03||X (33 bytes, 66 hex chars)
    //
    // 3GPP TS 33.501 and pySIM both expect:
    //   Profile A: raw 32-byte X25519 public key (64 hex chars, no prefix)
    //   Profile B: compressed secp256r1 point (66 hex chars, 02 or 03 prefix)
    const args = [
      this.suciKeytool,
      '--key-file', keyPath,
      'dump-pub-key',
    ];
    if (scheme === 2) args.push('--compressed');

    const result = await this.hostExecutor.executeLocalCommand('python3', args);

    this.logger.info({
      exitCode: result.exitCode,
      stdout: result.stdout.trim(),
      stderr: result.stderr?.trim(),
    }, 'suci-keytool dump-pub-key result');

    if (result.exitCode !== 0) {
      this.logger.error({ keyPath, stderr: result.stderr }, 'suci-keytool dump-pub-key failed');
      throw new Error(`Public key extraction failed for ${keyPath}: ${result.stderr}`);
    }

    const pubKey = result.stdout.trim().toLowerCase();
    const expectedLength = scheme === 1 ? 64 : 66;

    if (!pubKey || pubKey.length !== expectedLength) {
      this.logger.error({ keyPath, pubKey, length: pubKey.length, expectedLength }, 'Unexpected public key length');
      throw new Error(`Public key extraction failed for ${keyPath} — got ${pubKey.length} chars, expected ${expectedLength}`);
    }

    this.logger.info({ keyPath, scheme, pubKey }, 'Public key extracted successfully');
    return pubKey;
  }

  private async getRawUdm(): Promise<Record<string, unknown>> {
    try {
      const content = await this.hostExecutor.readFile('/etc/open5gs/udm.yaml');
      const yaml = await import('js-yaml');
      return (yaml.load(content) as Record<string, unknown>) || {};
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'Failed to load udm.yaml');
      return {};
    }
  }

  private parseHnet(raw: Record<string, unknown>): Array<{ id: number; scheme: number; key: string }> {
    const udm = raw.udm as Record<string, unknown> | undefined;
    const hnet = udm?.hnet;
    if (!Array.isArray(hnet)) return [];
    return hnet.map((entry: unknown) => {
      const e = entry as Record<string, unknown>;
      return {
        id: Number(e.id),
        scheme: Number(e.scheme),
        key: String(e.key),
      };
    });
  }

  private async addKeyToUdmYaml(id: number, scheme: number, keyPath: string): Promise<void> {
    const raw = await this.getRawUdm();
    const entries = this.parseHnet(raw);

    // Replace if id exists, otherwise append
    const idx = entries.findIndex((e) => e.id === id);
    if (idx >= 0) {
      entries[idx] = { id, scheme, key: keyPath };
    } else {
      entries.push({ id, scheme, key: keyPath });
      entries.sort((a, b) => a.id - b.id);
    }

    await this.saveHnet(raw, entries);
  }

  private async saveHnet(
    raw: Record<string, unknown>,
    entries: Array<{ id: number; scheme: number; key: string }>,
  ): Promise<void> {
    const yaml = await import('js-yaml');

    // Build updated doc
    const updatedRaw = { ...raw };
    const udm = { ...(updatedRaw.udm as Record<string, unknown> || {}) };
    udm.hnet = entries;
    updatedRaw.udm = udm;

    const content = yaml.dump(updatedRaw, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
      sortKeys: false,
    });

    await this.hostExecutor.writeFile('/etc/open5gs/udm.yaml', content);
    this.logger.info({ entryCount: entries.length }, 'udm.yaml hnet block updated');
  }
}
