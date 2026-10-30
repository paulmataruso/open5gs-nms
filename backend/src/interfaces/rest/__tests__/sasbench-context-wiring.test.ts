import * as fs from 'fs';
import * as path from 'path';
import { parseGitContext } from '../sas-controller';

// Static wiring guard for how the sasbench image is built.
//
// Background: the sasbench service used to build from a LOCAL directory
// outside this repository. Compose resolves every build context before it
// starts anything, so a host with nothing cloned failed the build and not one
// service started -- including the containers with nothing to do with the SAS.
// Guarding that with a Compose profile kept the stack up but left the SAS
// switched off until someone cloned a repository by hand.
//
// It now builds from a REMOTE git context pinned to a commit, so
// `git pull && docker compose build && docker compose up -d` works on any
// host, new or existing, with no extra step. Three things about that are
// load-bearing and none of them fails loudly, which is why they are pinned
// here.
const repoRoot = path.resolve(__dirname, '../../../../..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');

const CONTEXT_RE = /https:\/\/github\.com\/paulmataruso\/SASBench\.git#[0-9a-f]{40}/g;

describe('sasbench build context', () => {
  const compose = read('docker-compose.yml');

  it('builds from a remote git URL, not a local directory', () => {
    // A local path here is what made a missing directory fatal for the whole
    // stack. BuildKit fetches a URL per build, so it cannot be missing.
    expect(compose).toMatch(/context:\s*\$\{SASBENCH_CONTEXT:-https:\/\/github\.com\//);
  });

  it('no longer hides the SAS behind a Compose profile', () => {
    // The profile existed only to survive a missing local context. Leaving it
    // in would mean `docker compose up -d` silently skips the SAS, which is
    // the thing this release set out to stop.
    const sasbenchBlock = compose.slice(compose.indexOf('\n  sasbench:'));
    expect(sasbenchBlock).not.toMatch(/^\s*profiles:/m);
  });

  it('pins a full commit, so every deployment gets the tested revision', () => {
    // Tracking a branch would mean two hosts building a week apart run
    // different SAS code, with real radios holding grants from it.
    expect(compose.match(CONTEXT_RE)?.length).toBeGreaterThan(0);
  });

  // The same pinned URL is now written in three places: the service that
  // builds it, the backend env that reports it, and module-fixall's own
  // fallback. Drift between them is silent -- the SAS page would describe a
  // revision the stack does not build -- so they are compared rather than
  // trusted.
  it('uses one pinned revision across compose, config and module-fixall', () => {
    const pins = new Set<string>();
    for (const m of compose.match(CONTEXT_RE) ?? []) pins.add(m);
    for (const m of read('backend/src/config/index.ts').match(CONTEXT_RE) ?? []) pins.add(m);
    expect(pins.size).toBe(1);

    // module-fixall only needs the repository, not the commit: it decides
    // "is this a URL at all", so it is checked for the repo alone.
    expect(read('backend/src/application/use-cases/module-fixall-usecase.ts'))
      .toContain('https://github.com/paulmataruso/SASBench.git');
  });

  it('keeps the nginx conf as a DIRECTORY mount', () => {
    // A single-file bind mount pins that file's inode, so `git pull` never
    // reaches the running container: it kept serving a pre-pull config that
    // terminated SAS TLS on 8443, and SASBench could then not bind its own
    // port. A directory mount resolves names per lookup.
    expect(compose).toContain('./nginx/conf.d:/etc/nginx/conf.d:ro');
    expect(compose).not.toMatch(/\.\/nginx\/nginx\.conf:/);
  });
});

describe('parseGitContext', () => {
  it('reads a repository and commit out of a pinned URL', () => {
    expect(parseGitContext('https://github.com/paulmataruso/SASBench.git#abc123'))
      .toEqual({ repo: 'https://github.com/paulmataruso/SASBench.git', ref: 'abc123' });
  });

  it('defaults to HEAD when no ref is given', () => {
    expect(parseGitContext('https://example.com/x.git')?.ref).toBe('HEAD');
  });

  it('ignores a context subdirectory, which is not part of the ref', () => {
    // Git contexts allow ref:subdir. Treating "main:sub" as the ref would
    // make every ls-remote comparison fail.
    expect(parseGitContext('https://example.com/x.git#main:sub')?.ref).toBe('main');
  });

  it('returns null for a local path, which is what selects checkout mode', () => {
    // This is the branch that decides whether the NMS asks git about a local
    // directory at all. Getting it wrong means reporting a missing directory
    // as a fault on a healthy, URL-built deployment.
    expect(parseGitContext('/opt/sasbench')).toBeNull();
    expect(parseGitContext('')).toBeNull();
  });
});
