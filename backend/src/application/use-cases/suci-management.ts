import pino from 'pino';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { IConfigRepository } from '../../domain/interfaces/config-repository';

export interface HnetKey {
  id: number;
  scheme: 1 | 2;
  keyFile: string;
  fileExists: boolean;
  // Open5GS UDM format (goes in udm.yaml hnet block):
  //   Profile A (X25519):    raw 32-byte key, no prefix — 64 hex chars
  //   Profile B (secp256r1): compressed point 02/03||X  — 66 hex chars
  publicKeyHex: string | null;
  // SIM provisioning tools format (pySIM, sysmoUSIM tools etc.):
  //   Profile A (X25519):    raw 32-byte key, no prefix — 64 hex chars (same as UDM)
  //   Profile B (secp256r1): uncompressed point 04||X||Y — 130 hex chars
  //   NOTE: X25519 has no concept of point compression — the '04' prefix used for
  //   secp256r1 uncompressed points does NOT apply to X25519.
  publicKeyUncompressed: string | null;
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
  private readonly suciKeytool = '/app/tools/suci-keytool.py';

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
        let publicKeyUncompressed: string | null = null;

        if (fileExists) {
          try {
            const extracted = await this.extractPublicKey(entry.scheme, entry.key);
            publicKeyHex = extracted.hex;
            publicKeyUncompressed = extracted.uncompressed;
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
          publicKeyUncompressed,
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

    const extracted = await this.extractPublicKey(scheme, keyPath);

    await this.addKeyToUdmYaml(id, scheme, keyPath);

    return {
      id,
      scheme,
      keyFile: keyPath,
      fileExists: true,
      publicKeyHex: extracted.hex,
      publicKeyUncompressed: extracted.uncompressed,
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

    const newEntries = hnetEntries.filter((e) => e.id !== id);
    await this.saveHnet(raw, newEntries);

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

    const entry = entries.find((e) => e.id === currentId);
    if (!entry) {
      throw new Error(`Key ID ${currentId} not found in udm.yaml`);
    }

    if (entries.some((e) => e.id === newId)) {
      throw new Error(`Key ID ${newId} is already in use`);
    }

    let newKeyPath = entry.key;
    const fileExists = await this.hostExecutor.fileExists(entry.key);
    if (fileExists) {
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

    const updatedEntries = entries.map((e) =>
      e.id === currentId ? { id: newId, scheme: e.scheme, key: newKeyPath } : e,
    );
    updatedEntries.sort((a, b) => a.id - b.id);
    await this.saveHnet(raw, updatedEntries);

    let publicKeyHex: string | null = null;
    let publicKeyUncompressed: string | null = null;
    const newFileExists = await this.hostExecutor.fileExists(newKeyPath);
    if (newFileExists) {
      try {
        const extracted = await this.extractPublicKey(entry.scheme, newKeyPath);
        publicKeyHex = extracted.hex;
        publicKeyUncompressed = extracted.uncompressed;
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
      publicKeyUncompressed,
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

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async extractPublicKey(
    scheme: number,
    keyPath: string,
  ): Promise<{ hex: string; uncompressed: string }> {
    this.logger.info({ scheme, keyPath }, 'Extracting public key via suci-keytool.py');

    // Profile A (X25519, scheme 1):
    //   dump-pub-key (no flags) → raw 32 bytes = 64 hex
    //   Same value used for both Open5GS UDM and SIM provisioning tools.
    //   X25519 has no point compression — the 04 prefix is secp256r1-only.
    //
    // Profile B (secp256r1, scheme 2):
    //   dump-pub-key --compressed → 02/03||X = 66 hex    → Open5GS UDM format
    //   dump-pub-key (no flags)   → 04||X||Y = 130 hex   → SIM provisioning tools

    const runDump = async (compressed: boolean): Promise<string> => {
      const args = [this.suciKeytool, '--key-file', keyPath, 'dump-pub-key'];
      if (compressed) args.push('--compressed');
      const result = await this.hostExecutor.executeLocalCommand('python3', args);
      if (result.exitCode !== 0) {
        throw new Error(`dump-pub-key failed for ${keyPath}: ${result.stderr}`);
      }
      return result.stdout.trim().toLowerCase();
    };

    if (scheme === 1) {
      const raw = await runDump(false);
      if (raw.length !== 64) {
        throw new Error(`X25519 key extraction failed — got ${raw.length} chars, expected 64`);
      }
      this.logger.info({ keyPath, scheme, pubKeyHex: raw }, 'X25519 public key extracted');
      // X25519 public keys are always raw 32 bytes (64 hex) — no point-compression prefix.
      // Both Open5GS UDM and SIM provisioning tools (pySIM, sysmoUSIM) use the same
      // raw 32-byte format.  The '04' prefix is secp256r1 uncompressed-point notation
      // and is incorrect for X25519.
      return {
        hex:          raw, // 64 hex — Open5GS UDM format
        uncompressed: raw, // 64 hex — pySIM / sysmoUSIM format (identical for X25519)
      };
    } else {
      const [compressed, uncompressed] = await Promise.all([
        runDump(true),
        runDump(false),
      ]);
      if (compressed.length !== 66) {
        throw new Error(`secp256r1 compressed extraction failed — got ${compressed.length} chars, expected 66`);
      }
      if (uncompressed.length !== 130) {
        throw new Error(`secp256r1 uncompressed extraction failed — got ${uncompressed.length} chars, expected 130`);
      }
      this.logger.info({ keyPath, scheme, compressed, uncompressed }, 'secp256r1 public keys extracted');
      return {
        hex:          compressed,   // 66 hex — Open5GS UDM
        uncompressed: uncompressed, // 130 hex — SIM tools
      };
    }
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
