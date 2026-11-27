import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  mongoGateScript,
  mongoGateUnit,
  mongoGateNfDropIn,
  dbBackedServicesFromConfigs,
  MONGO_BOOT_GATE_REV,
} from '../mongo-boot-gate';

// The gate is a generated bash script plus generated systemd units, so these
// tests exercise the generated TEXT rather than mocking an install. Two of them
// run the real script against a fake /etc/open5gs, because every bug found
// building this was in the db_uri parsing, not in the install plumbing.

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mongo-gate-'));
}

// Writes the script with its /etc/open5gs glob repointed at `yamlDir`, and with
// a dump of the parsed groups spliced in, then runs it. Returns the groups.
function parseEndpoints(yamlDir: string): string[] {
  const dir = tmpdir();
  const scriptPath = path.join(dir, 'wait-mongo.sh');
  // Anchored on a declaration, not prose: an earlier version spliced at a
  // comment, and rewording that comment broke all ten parsing tests at once.
  const marker = 'mongo_ping() {';
  const script = mongoGateScript();
  expect(script).toContain(marker);
  const patched = script
    .replace(/\/etc\/open5gs\/\*\.yaml/g, `${yamlDir}/*.yaml`)
    .replace(marker, 'for g in "${URI_GROUPS[@]}"; do echo "GROUP:$g"; done; exit 0\n\n' + marker);
  fs.writeFileSync(scriptPath, patched, { mode: 0o755 });
  const out = execFileSync('bash', [scriptPath], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  return out.split('\n').filter(l => l.startsWith('GROUP:')).map(l => l.slice('GROUP:'.length));
}

describe('mongo boot gate — generated script', () => {
  it('is syntactically valid bash', () => {
    const dir = tmpdir();
    const p = path.join(dir, 'wait-mongo.sh');
    fs.writeFileSync(p, mongoGateScript());
    // Throws on a non-zero exit, which is what a syntax error produces.
    execFileSync('bash', ['-n', p], { stdio: ['ignore', 'pipe', 'pipe'] });
  });

  // Real bug, caught by this test before the gate ever shipped: GROUPS is a
  // bash SPECIAL variable holding the current user's group membership, and
  // assignments to it are silently ignored. The array therefore read back as
  // the user's gid list, no endpoint ever matched, and the gate waited out its
  // full 300s timeout on every single boot while appearing to work.
  it('does not use the bash special variable GROUPS as its own array', () => {
    const s = mongoGateScript();
    expect(s).not.toMatch(/(^|[^_A-Z])GROUPS=/m);
    expect(s).not.toMatch(/(^|[^_A-Z])GROUPS\+=/m);
    expect(s).toContain('URI_GROUPS');
  });

  it('releases rather than failing when MongoDB never answers', () => {
    // exit 1 would let the gate wedge the whole core permanently, which is a
    // worse outage than the one it exists to prevent.
    const s = mongoGateScript();
    const warn = s.slice(s.indexOf('WARNING: MongoDB not reachable'));
    expect(warn).toMatch(/exit 0/);
    expect(s).not.toMatch(/exit 1/);
  });

  // The ping ran a bare --eval, which pings whatever the container's own
  // default is rather than the endpoint the NFs are configured to use.
  // Confirmed live: it reported a healthy database for port 22.
  it('pings the configured endpoint, not the container default', () => {
    const s = mongoGateScript();
    const dockerBranch = s.slice(s.indexOf('docker exec'), s.indexOf('else\n    return 2'));
    expect(dockerBranch).toContain('--host "$1"');
    expect(dockerBranch).toContain('--port "$2"');
    // argv, not string interpolation: these values come out of a config file.
    expect(dockerBranch).toMatch(/_ "\$host" "\$port"/);
  });

  // The failure directions are not symmetric. Declaring ready too early costs
  // a few Restart=always retries; refusing to declare ready costs the whole
  // timeout on every boot, silently. So the ping gets a grace period, not a veto.
  it('never lets a failing ping withhold readiness indefinitely', () => {
    const s = mongoGateScript();
    expect(s).toMatch(/^PING_GRACE=\d+$/m);
    expect(s).toContain('PROOF="ping-failed"');
    const grace = Number(/^PING_GRACE=(\d+)$/m.exec(s)?.[1]);
    const wait = Number(/^TIMEOUT=\$\{1:-(\d+)\}$/m.exec(s)?.[1]);
    expect(grace).toBeGreaterThan(0);
    expect(grace).toBeLessThan(wait);
  });

  // The legacy mongo shell writes its connection error to STDOUT, and that
  // text contains a 1 in several places ("...:27999", ":374:17", "code 1"),
  // so a substring test reports a healthy database when nothing answered.
  it('matches the ping result exactly rather than as a substring', () => {
    const s = mongoGateScript();
    // The construct, not the string: the script's own comment names *1* to
    // explain why it is wrong, and that comment is worth keeping.
    expect(s).not.toMatch(/in \*1\*\)/);
    expect(s).toContain('[ "$out" = "1" ]');
  });

  it('re-derives endpoints at run time instead of baking them in', () => {
    // A db_uri change (or a PLMN/IP-plan move) must not need a reinstall.
    expect(mongoGateScript()).toContain('/etc/open5gs/*.yaml');
  });
});

describe('mongo boot gate — db_uri parsing', () => {
  const cases: Array<[string, string, string]> = [
    ['plain host, default port', 'mongodb://127.0.0.1/open5gs', '127.0.0.1/27017'],
    ['explicit port', 'mongodb://10.0.0.5:27018/open5gs', '10.0.0.5/27018'],
    ['credentials are stripped', 'mongodb://user:secret@10.0.0.5:27018/open5gs?authSource=admin', '10.0.0.5/27018'],
    ['options with no database', 'mongodb://db.internal?retryWrites=true', 'db.internal/27017'],
    ['IPv6 literal', 'mongodb://[::1]:27019/open5gs', '::1/27019'],
    ['replica-set seed list', 'mongodb://a.ex:27017,b.ex:27017,c.ex/open5gs?replicaSet=rs0',
      'a.ex/27017 b.ex/27017 c.ex/27017'],
  ];

  for (const [label, uri, expected] of cases) {
    it(`parses ${label}`, () => {
      const dir = tmpdir();
      fs.writeFileSync(path.join(dir, 'udr.yaml'), `db_uri: ${uri}\n`);
      expect(parseEndpoints(dir)).toEqual([expected]);
    });
  }

  it('strips surrounding quotes and leading indentation', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'udr.yaml'), '  db_uri: "mongodb://127.0.0.1:27017/open5gs"\n');
    fs.writeFileSync(path.join(dir, 'pcf.yaml'), "db_uri: 'mongodb://127.0.0.1:27017/open5gs'\n");
    // Both normalise to the same endpoint, and sort -u collapses them.
    expect(parseEndpoints(dir)).toEqual(['127.0.0.1/27017']);
  });

  it('skips a mongodb+srv seedlist rather than guessing a port for it', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'udr.yaml'), 'db_uri: mongodb+srv://cluster0.example.net/open5gs\n');
    expect(parseEndpoints(dir)).toEqual([]);
  });

  it('keeps two different db_uri values as two groups that must both answer', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'udr.yaml'), 'db_uri: mongodb://10.0.0.1/open5gs\n');
    fs.writeFileSync(path.join(dir, 'hss.yaml'), 'db_uri: mongodb://10.0.0.2/open5gs\n');
    expect(parseEndpoints(dir).sort()).toEqual(['10.0.0.1/27017', '10.0.0.2/27017']);
  });

  it('finds nothing to wait for when no config carries a db_uri', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'amf.yaml'), 'amf:\n  sbi: []\n');
    expect(parseEndpoints(dir)).toEqual([]);
  });
});

describe('mongo boot gate — NF drop-in', () => {
  // THE fix. Open5GS exits with status 0 when it cannot reach MongoDB, so
  // systemd records Result=success and Restart=on-failure never fires. Verified
  // live: with on-failure the NF stayed inactive at NRestarts=0; with always it
  // retried and recovered by itself within 6s of MongoDB returning.
  it('sets Restart=always, because on-failure cannot retry an exit-0 failure', () => {
    const d = mongoGateNfDropIn();
    expect(d).toMatch(/^Restart=always$/m);
    expect(d).not.toMatch(/^Restart=on-failure$/m);
  });

  it('bounds a genuinely broken config with a start-limit budget', () => {
    const d = mongoGateNfDropIn();
    expect(d).toMatch(/^StartLimitIntervalSec=\d+$/m);
    expect(d).toMatch(/^StartLimitBurst=\d+$/m);
    expect(d).toMatch(/^RestartSec=\d+$/m);
  });

  it('orders the NF after the readiness gate', () => {
    const d = mongoGateNfDropIn();
    expect(d).toMatch(/^After=open5gs-mongo-ready\.service$/m);
    expect(d).toMatch(/^Wants=open5gs-mongo-ready\.service$/m);
  });

  it('stamps the rev so a stale drop-in is detected rather than assumed current', () => {
    expect(mongoGateNfDropIn()).toContain(`mongo-boot-gate rev ${MONGO_BOOT_GATE_REV}`);
  });
});

describe('mongo boot gate — unit ordering is per-host, not per-assumption', () => {
  // The three real arrangements this project supports: host mongod (AVX),
  // a mongo:4.4 container (no AVX), and a remote/replica-set MongoDB.
  it('wants mongod.service when the host actually has one', () => {
    const u = mongoGateUnit(['mongod.service', 'docker.service']);
    expect(u).toMatch(/^After=network\.target mongod\.service docker\.service$/m);
    expect(u).toMatch(/^Wants=mongod\.service$/m);
  });

  it('orders after docker but never Wants= it, so host mode is not made to need Docker', () => {
    const u = mongoGateUnit(['docker.service']);
    expect(u).toMatch(/^After=network\.target docker\.service$/m);
    expect(u).not.toMatch(/^Wants=/m);
  });

  it('emits no dependency at all for a remote MongoDB', () => {
    const u = mongoGateUnit([]);
    expect(u).toMatch(/^After=network\.target$/m);
    expect(u).not.toMatch(/^Wants=/m);
  });

  it('never kills its own wait: TimeoutStartSec exceeds the script timeout', () => {
    const u = mongoGateUnit([]);
    const wait = Number(/ExecStart=\S+ (\d+)/.exec(u)?.[1]);
    const timeout = Number(/TimeoutStartSec=(\d+)/.exec(u)?.[1]);
    expect(wait).toBeGreaterThan(0);
    expect(timeout).toBeGreaterThan(wait);
  });

  it('stays active after exiting so ordering holds for a later single-NF start', () => {
    expect(mongoGateUnit([])).toMatch(/^RemainAfterExit=yes$/m);
  });
});

describe('mongo boot gate — which NFs are DB-backed', () => {
  it('reads it from the configs that actually carry a db_uri', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'udr.yaml'), 'db_uri: mongodb://127.0.0.1/open5gs\n');
    fs.writeFileSync(path.join(dir, 'hss.yaml'), '  db_uri: mongodb://127.0.0.1/open5gs\n');
    fs.writeFileSync(path.join(dir, 'amf.yaml'), 'amf:\n  sbi: []\n');
    expect(dbBackedServicesFromConfigs(dir).sort()).toEqual(['hss', 'udr']);
  });

  it('ignores a yaml whose name is not a known service', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'udr.yaml'), 'db_uri: mongodb://127.0.0.1/open5gs\n');
    fs.writeFileSync(path.join(dir, 'something-else.yaml'), 'db_uri: mongodb://127.0.0.1/open5gs\n');
    expect(dbBackedServicesFromConfigs(dir)).toEqual(['udr']);
  });

  it('falls back to the canonical four when the config dir is absent', () => {
    // A fresh-host bootstrap can reach the gate before the Open5GS packages
    // have landed; an empty gate there would be silently useless.
    expect(dbBackedServicesFromConfigs('/nonexistent-open5gs-dir').sort())
      .toEqual(['hss', 'pcf', 'pcrf', 'udr']);
  });

  it('falls back rather than returning nothing for an unpopulated dir', () => {
    expect(dbBackedServicesFromConfigs(tmpdir()).sort()).toEqual(['hss', 'pcf', 'pcrf', 'udr']);
  });
});
