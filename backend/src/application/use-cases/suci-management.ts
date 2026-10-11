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

    // Real, confirmed-live 2026-09-30 finding (a full-session live-API verification
    // pass): this never checked whether `id` was already in use before generating and
    // writing a new key — addKeyToUdmYaml() below does a blind replace-or-append keyed
    // on id, so calling this with an already-used id silently overwrote a real,
    // in-use key's scheme/file-path entry in udm.yaml with a brand new key having
    // nothing to do with the original. A real test call reproduced this exact live
    // corruption against a real production key. `PUT /api/suci/keys/:id`
    // (suci-controller.ts) is the real, already-existing "replace this id's key on
    // purpose" mechanism — it deletes the old entry first, then calls generateKey()
    // with the same id, so this check correctly stays out of that legitimate path's
    // way (the id is already gone by the time generateKey() runs there).
    const existing = this.parseHnet(await this.getRawUdm());
    if (existing.some(e => e.id === id)) {
      throw new Error(`Key ID ${id} is already in use — use rotate instead of generate to replace an existing key`);
    }

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
      // Profile A (curve25519) needs pycryptodome >= 3.21. The image installs
      // Debian's python3-pycryptodome (3.11) so it builds without pypi — see
      // backend/Dockerfile's own comment and issue #36 — and then layers the
      // newer wheel from pypi when that is reachable. When it was not, this is
      // the one capability that is missing, and the underlying failure is a bare
      // `KeyError: 'curve25519'` from deep inside the library, which tells an
      // operator nothing. Translate it.
      const looksLikeOldPycryptodome =
        curve === 'curve25519' &&
        /UnsupportedEccFeature|KeyError.*curve25519|curve25519/i.test(result.stderr ?? '');
      if (looksLikeOldPycryptodome) {
        throw new Error(
          'SUCI Profile A (curve25519) key generation needs pycryptodome 3.21 or newer, and this ' +
          'install has the older version Debian ships. That happens when the image was built ' +
          'without access to pypi.org. Fix: rebuild the backend image on a host that can reach ' +
          'pypi.org (docker compose build backend), or install it inside the container with ' +
          "pip3 install --break-system-packages 'pycryptodomex>=3.21'. " +
          'Profile B (secp256r1) keys work without it.',
        );
      }
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
      // Always normalize to the NMS's standard naming convention (same as
      // generateKey()) rather than pattern-matching the existing filename —
      // this also correctly renames keys that pre-date the NMS (e.g. a
      // fresh host with open5gs already configured) and don't follow the
      // curve25519-<id>.key / secp256r1-<id>.key convention at all.
      const newFileName = entry.scheme === 1 ? `curve25519-${newId}.key` : `secp256r1-${newId}.key`;
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

  // Rewrites ONLY the udm.hnet block, in place, in the real file's own text.
  //
  // This used to `yaml.dump()` the whole parsed document back over udm.yaml,
  // which is exactly what CLAUDE.md architectural pattern #2 exists to prevent:
  // udm is one of the 17 core NFs, and a full dump discards every comment,
  // rewrites quoting and key order, and collapses the structure of a file an
  // operator may well have hand-annotated. Nothing in the SUCI feature needs to
  // touch anything but hnet, so nothing else is touched.
  private async saveHnet(
    _raw: Record<string, unknown>,
    entries: Array<{ id: number; scheme: number; key: string }>,
  ): Promise<void> {
    const original = await this.hostExecutor.readFile('/etc/open5gs/udm.yaml');
    const updated = upsertUdmHnetBlock(original, entries);
    if (updated === original) {
      this.logger.info({ entryCount: entries.length }, 'udm.yaml hnet block already matches — not rewritten');
      return;
    }
    await this.hostExecutor.writeFile('/etc/open5gs/udm.yaml', updated);
    this.logger.info({ entryCount: entries.length }, 'udm.yaml hnet block updated in place');
  }
}

/** Indentation width of a line, or null for a blank/comment-only line. */
function indentOf(line: string): number | null {
  if (/^\s*$/.test(line) || /^\s*#/.test(line)) return null;
  return line.length - line.replace(/^\s*/, '').length;
}

/**
 * Replace (or insert) the `hnet:` block nested under top-level `udm:` in a
 * udm.yaml, leaving every other byte of the file untouched.
 *
 * Exported for unit testing — the whole point of this function is that it
 * preserves things a round-trip through js-yaml would silently destroy, which
 * is only meaningfully verifiable by asserting on real file text.
 */
export function upsertUdmHnetBlock(
  yamlText: string,
  entries: Array<{ id: number; scheme: number; key: string }>,
): string {
  const lines = yamlText.split('\n');

  const render = (keyIndent: number): string[] => {
    const k = ' '.repeat(keyIndent);
    // An empty list must be explicit: a bare `hnet:` parses as null, which is
    // not the same as "no home network keys configured".
    if (entries.length === 0) return [`${k}hnet: []`];
    const out = [`${k}hnet:`];
    for (const e of entries) {
      out.push(`${k}  - id: ${e.id}`);
      out.push(`${k}    scheme: ${e.scheme}`);
      out.push(`${k}    key: ${e.key}`);
    }
    return out;
  };

  const udmIdx = lines.findIndex(l => /^udm:\s*$/.test(l));
  if (udmIdx === -1) {
    // No udm section at all — append one rather than failing. Keeps a single
    // trailing newline.
    const body = yamlText.replace(/\n+$/, '');
    return `${body}\nudm:\n${render(2).join('\n')}\n`;
  }

  // Walk udm's body: every line until the next line at indent 0.
  let end = lines.length;
  for (let i = udmIdx + 1; i < lines.length; i++) {
    const ind = indentOf(lines[i]);
    if (ind === null) continue;
    if (ind === 0) { end = i; break; }
  }

  let hnetIdx = -1;
  let hnetIndent = 2;
  for (let i = udmIdx + 1; i < end; i++) {
    const m = lines[i].match(/^(\s+)hnet:/);
    if (m) { hnetIdx = i; hnetIndent = m[1].length; break; }
  }

  if (hnetIdx === -1) {
    // Insert as udm's first child, matching the indentation its existing
    // children already use so the file keeps one consistent style.
    let childIndent = 2;
    for (let i = udmIdx + 1; i < end; i++) {
      const ind = indentOf(lines[i]);
      if (ind !== null && ind > 0) { childIndent = ind; break; }
    }
    const out = [...lines.slice(0, udmIdx + 1), ...render(childIndent), ...lines.slice(udmIdx + 1)];
    return out.join('\n');
  }

  // Replace the existing block: the key line plus every following line indented
  // deeper than it (blank lines inside the block are carried along, but a blank
  // line that trails the block is left where it is).
  let blockEnd = hnetIdx + 1;
  let lastContent = hnetIdx;
  for (let i = hnetIdx + 1; i < end; i++) {
    const ind = indentOf(lines[i]);
    if (ind === null) { blockEnd = i + 1; continue; }
    if (ind <= hnetIndent) break;
    blockEnd = i + 1;
    lastContent = i;
  }
  // Don't swallow blank lines that sit after the block's last real entry.
  blockEnd = lastContent + 1;

  return [...lines.slice(0, hnetIdx), ...render(hnetIndent), ...lines.slice(blockEnd)].join('\n');
}
