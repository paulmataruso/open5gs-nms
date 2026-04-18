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
    this.logger.info({ id, scheme }, 'Generating new SUCI key');

    // Ensure hnet directory exists
    await this.hostExecutor.createDirectory(this.hnetDir);

    // Determine filename and generate command
    const fileName = scheme === 1
      ? `curve25519-${id}.key`
      : `secp256r1-${id}.key`;
    const keyPath = `${this.hnetDir}/${fileName}`;

    if (scheme === 1) {
      await this.hostExecutor.executeCommand('openssl', ['genpkey', '-algorithm', 'X25519', '-out', keyPath]);
    } else {
      await this.hostExecutor.executeCommand('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-conv_form', 'compressed', '-out', keyPath]);
    }
    this.logger.info({ keyPath }, 'Key file generated');

    // Extract the public key
    const publicKeyHex = await this.extractPublicKey(scheme, keyPath);

    // Update udm.yaml — add or replace this id
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
    if (scheme === 1) {
      // X25519: extract public key from text output
      // Output format:
      // pub:
      //     e4:21:68:6f:6f:b2:d7:0e:3f:a2:8d:94:04:94:09:
      //     56:86:c3:17:9f:ef:53:51:46:67:a6:ed:10:6b:8a:
      //     7d:3d
      const result = await this.hostExecutor.executeCommand('sh', ['-c', 
        `openssl pkey -in ${keyPath} -text | grep -A 3 "^pub:" | tail -n +2 | tr -d "\\n: "`
      ]);
      const pubKey = result.stdout.trim().toLowerCase();
      if (!pubKey || pubKey.length !== 64) {
        this.logger.warn({ keyPath, pubKey, length: pubKey.length }, 'X25519 public key extraction failed or invalid length (expected 64 hex chars)');
      }
      return pubKey;
    } else {
      // secp256r1: extract public key from text output
      // Output format:
      // pub:
      //     02:0f:67:c7:91:1b:81:dc:fd:68:03:7e:92:61:22:
      //     83:bc:b4:de:d1:10:4f:f6:a3:61:e8:3a:20:37:f5:
      //     93:b2:ca
      const result = await this.hostExecutor.executeCommand('sh', ['-c', 
        `openssl ec -in ${keyPath} -conv_form compressed -text 2>/dev/null | grep -A 3 "^pub:" | tail -n +2 | tr -d "\\n: "`
      ]);
      const pubKey = result.stdout.trim().toLowerCase();
      if (!pubKey || pubKey.length !== 66) {
        this.logger.warn({ keyPath, pubKey, length: pubKey.length }, 'secp256r1 public key extraction failed or invalid length (expected 66 hex chars)');
      }
      return pubKey;
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
