import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeYamlGuarded } from '../../../interfaces/rest/ims-controller';

// The post-condition guard around every smf.yaml write. The point is not that
// the transforms are correct — that is smf-ims-session-upf-dnn.test.ts — it is
// that broken YAML can never reach disk no matter which code path has a bug.
// That is what would have contained the original corruption without anyone
// knowing its cause, so it needs its own coverage.

const GOOD = `logger:
  level: info
global:
  max:
    ue: 1024
smf:
  sbi:
    client:
      scp:
        - uri: http://scp.example:7777
  session:
    - subnet: 10.45.0.0/16
      dnn: internet
`;

// What the pre-fix code actually produced.
const CORRUPT = `          dnn: ims
    - subnet: 10.46.0.0/16
      gateway: 10.46.0.1
`;

let tmp: string;
let file: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smfguard-'));
  file = path.join(tmp, 'smf.yaml');
});

const read = () => fs.readFileSync(file, 'utf-8');

describe('writeYamlGuarded — never write invalid YAML', () => {
  it('applies a good transform and writes the result', () => {
    fs.writeFileSync(file, GOOD);
    writeYamlGuarded(file, (raw: string) => raw.replace('level: info', 'level: debug'), 'test');
    expect(read()).toContain('level: debug');
  });

  it('refuses an unparseable file, and leaves it byte-identical', () => {
    fs.writeFileSync(file, CORRUPT);
    const before = read();
    expect(() => writeYamlGuarded(file, (raw: string) => raw, 'remove the IMS session'))
      .toThrow(/not valid YAML/);
    expect(read()).toBe(before);   // the critical property: untouched
  });

  it('names the backup so the operator can actually recover', () => {
    fs.writeFileSync(file, CORRUPT);
    expect(() => writeYamlGuarded(file, (raw: string) => raw, 'test'))
      .toThrow(/\.ims-smf\.bak/);
  });

  it('refuses a file that parses to something other than a mapping', () => {
    fs.writeFileSync(file, '- just\n- a\n- list\n');
    const before = read();
    expect(() => writeYamlGuarded(file, (raw: string) => raw, 'test')).toThrow(/not a mapping/);
    expect(read()).toBe(before);
  });

  it('refuses a transform whose OUTPUT is unparseable — the post-condition', () => {
    fs.writeFileSync(file, GOOD);
    const before = read();
    expect(() => writeYamlGuarded(file, () => '  bad:\n- broken: [', 'test'))
      .toThrow(/unusable/);
    expect(read()).toBe(before);
  });

  it('refuses a transform that drops a top-level key', () => {
    // Exactly the shape the original bug took: a "successful" edit that
    // silently removed unrelated sections.
    fs.writeFileSync(file, GOOD);
    const before = read();
    expect(() => writeYamlGuarded(
      file,
      (raw: string) => raw.split('\n').filter((l: string) => !/^(logger|  level)/.test(l)).join('\n'),
      'test',
    )).toThrow(/would drop top-level key\(s\): logger/);
    expect(read()).toBe(before);
  });

  it('would have contained the original corruption', () => {
    // Replay the real bug: a transform that reduces the whole document to a few
    // session lines. The guard must stop it writing, whatever the cause.
    fs.writeFileSync(file, GOOD);
    const before = read();
    const theOriginalBug = () => CORRUPT;
    expect(() => writeYamlGuarded(file, theOriginalBug, 'add the IMS session')).toThrow();
    expect(read()).toBe(before);
  });

  it('allows an edit that legitimately removes an IMS-owned key', () => {
    // The guard must not be so strict that Disable cannot do its job: removing
    // smf.p-cscf is nested, not top-level, so it is permitted.
    const withPcscf = GOOD + '  p-cscf:\n    - 10.46.0.1\n';
    fs.writeFileSync(file, withPcscf);
    writeYamlGuarded(
      file,
      (raw: string) => raw.split('\n').filter((l: string) => !/p-cscf|10\.46\.0\.1/.test(l)).join('\n'),
      'remove p-cscf',
    );
    expect(read()).not.toContain('p-cscf');
    expect(read()).toContain('scp');   // nothing else lost
  });
});

// upf.yaml is the other file IMS rewrites on every stop/start, and
// removeUpfImsSession carried the identical defect to its smf twin — missed in
// the first pass because only the smf functions were examined.
describe('upf.yaml gets the same treatment', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { removeUpfImsSession, updateUpfImsSession } = require('../../../interfaces/rest/ims-controller');
  const yaml = require('js-yaml');

  // A upf.yaml with a second `dnn: ims` outside the session list — the shape
  // that destroys the file under the old document-wide search.
  const UPF = `logger:
  level: info
upf:
  pfcp:
    server:
      - address: 127.0.0.7
  gtpu:
    server:
      - address: 127.0.0.7
  metrics:
    server:
      - address: 127.0.0.7
        port: 9090
  session:
    - subnet: 10.45.0.0/16
      gateway: 10.45.0.1
      dnn: internet
      dev: ogstun
    - subnet: 10.46.0.0/24
      gateway: 10.46.0.1
      dnn: ims
      dev: ogstun2
`;

  it('removes only the ims session and keeps the rest', () => {
    const out = removeUpfImsSession(UPF);
    const d = yaml.load(out);
    expect(d.upf.session.map((s: any) => s.dnn)).toEqual(['internet']);
    expect(d.upf.pfcp.server[0].address).toBe('127.0.0.7');
    expect(d.upf.metrics.server[0].port).toBe(9090);
    expect(d.logger.level).toBe('info');
  });

  it('is idempotent, and adding back is too', () => {
    const removed = removeUpfImsSession(UPF);
    expect(removeUpfImsSession(removed)).toBe(removed);
    const readded = updateUpfImsSession(removed);
    expect(yaml.load(readded).upf.session.map((s: any) => s.dnn).sort()).toEqual(['ims', 'internet']);
    expect(updateUpfImsSession(readded)).toBe(readded);
  });

  it('leaves a file it cannot understand alone instead of wrecking it', () => {
    // No `upf:` key at all — the session range cannot be resolved.
    const odd = 'logger:\n  level: info\nsession:\n  - dnn: ims\n';
    expect(removeUpfImsSession(odd)).toBe(odd);
  });
});
