import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

// Guards two reported fresh-install failures.
//
// #36 — `pip3 install pycryptodomex paramiko requests` failed the whole image
// build when pypi.org was unreachable, blocking the entire product over two
// optional features (SUCI key generation, femto provisioning).
//
// #37 — `docker compose up --build` failed with "additional privileges
// requested: pass --allow=network.host" on a clean Ubuntu 24.04 VM, because the
// build asked for host networking and buildx bake enforces that entitlement.

const ROOT = path.resolve(__dirname, '../../../../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

describe('issue #36 — the image must build without pypi', () => {
  const dockerfile = read('backend/Dockerfile');

  it('gets paramiko and requests from Debian, not pypi', () => {
    expect(dockerfile).toMatch(/^\s*python3-paramiko\s*\\?$/m);
    expect(dockerfile).toMatch(/^\s*python3-requests\s*\\?$/m);
  });

  it('gets a working Cryptodome from Debian too', () => {
    // Debian's python3-pycryptodome provides the `Cryptodome` namespace that
    // suci-keytool.py imports, and covers SUCI Profile B (secp256r1).
    expect(dockerfile).toMatch(/^\s*python3-pycryptodome\s*\\?$/m);
  });

  it('never hard-fails on a pypi install', () => {
    // Join shell line-continuations and drop comments first: the `|| echo ...`
    // that tolerates the failure lives on the line AFTER the pip command, so a
    // per-line assertion looks at the wrong half and wrongly fails.
    const joined = dockerfile
      .replace(/^[ \t]*#.*$/gm, '')
      .replace(/\\\s*\n\s*/g, ' ');
    const pipCmds = joined.split('\n').filter(l => /pip3?\s+install/.test(l));
    expect(pipCmds.length).toBeGreaterThan(0);
    for (const cmd of pipCmds) {
      // Every pip invocation must be tolerated, so pypi being unreachable
      // cannot fail the build.
      expect(cmd).toMatch(/\|\|/);
    }
    // And the old unconditional form must be gone.
    expect(dockerfile).not.toMatch(/&&\s*pip3 install pycryptodomex paramiko requests/);
  });

  it('still asks pypi for the version Profile A actually needs', () => {
    // Debian ships 3.11; curve25519 needs >= 3.21 (verified by testing both).
    expect(dockerfile).toMatch(/pycryptodomex>=3\.21/);
  });

  it('turns the one offline gap into an actionable error, not a KeyError', () => {
    const suci = read('backend/src/application/use-cases/suci-management.ts');
    expect(suci).toMatch(/pycryptodome 3\.21 or newer/);
    expect(suci).toMatch(/Profile B \(secp256r1\) keys work without it/);
  });
});

describe('issue #37 — the default build must not request privileges', () => {
  const composeRaw = read('docker-compose.yml');

  it('no build section asks for host networking by default', () => {
    const doc = yaml.load(composeRaw) as any;
    for (const [name, svc] of Object.entries<any>(doc.services ?? {})) {
      if (svc?.build && typeof svc.build === 'object') {
        expect(svc.build.network).toBeUndefined();
      }
      // Runtime host networking is unrelated and must be left alone.
      void name;
    }
  });

  it('runtime network_mode: host is untouched — only the BUILD changed', () => {
    const doc = yaml.load(composeRaw) as any;
    expect(doc.services.backend.network_mode).toBe('host');
    expect(doc.services.frontend.network_mode).toBe('host');
  });

  it('the capability is preserved as an opt-in override', () => {
    const override = yaml.load(read('docker-compose.hostnet-build.yml')) as any;
    expect(override.services.backend.build.network).toBe('host');
    expect(override.services.frontend.build.network).toBe('host');
  });

  it('both failure modes are documented for a fresh installer', () => {
    const install = read('INSTALL.md');
    expect(install).toMatch(/--allow=network\.host/);
    expect(install).toMatch(/docker-compose\.hostnet-build\.yml/);
    expect(install).toMatch(/EAI_AGAIN/);
  });
});
