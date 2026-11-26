import pino from 'pino';
import * as yaml from 'js-yaml';
import { YamlConfigRepository } from '../yaml-config-repository';
import { IHostExecutor } from '../../../domain/interfaces/host-executor';

/**
 * deepMerge and YAML round-trip preservation for the 17 NF config files.
 *
 * Converted to jest on 2026-11-26 from src/infrastructure/yaml/
 * yaml-config-repository.test.ts, which was a standalone ts-node script with
 * its own console-based runner. Two things were wrong with it, and both are the
 * reason this file exists rather than an edit in place:
 *
 *  1. jest's testMatch is `**\/__tests__\/**\/*.test.ts`, so sitting outside
 *     __tests__ meant CI never ran a single one of these assertions -- 404
 *     lines of coverage for the config WRITE path, dormant.
 *  2. it inlined its own copy of deepMerge, under a comment claiming the copy
 *     "mirrors the private method exactly". A test of a copy cannot fail when
 *     the real method changes, which is the same duplication that hid two real
 *     defects elsewhere this session.
 *
 * Every assertion from that file is preserved below, now run against the real
 * private method through the instance.
 */
const logger = pino({ level: 'silent' });

interface RepoInternals {
  deepMerge(base: unknown, overlay: unknown): unknown;
  parseGtpc(raw: unknown): { addr: string; port?: number } | undefined;
  fixMccMncSdFromRawYaml(rawYaml: string, doc: unknown): unknown;
}

function makeRepo(exec: Partial<IHostExecutor> = {}): {
  repo: YamlConfigRepository;
  internals: RepoInternals;
} {
  const repo = new YamlConfigRepository(exec as IHostExecutor, '/etc/open5gs', logger);
  return { repo, internals: repo as unknown as RepoInternals };
}

const { internals } = makeRepo();
const merge = (base: unknown, overlay: unknown): unknown => internals.deepMerge(base, overlay);

/**
 * Read a dotted path out of an untyped document, numeric segments indexing
 * arrays. Keeps these assertions free of `any`, which matters here: a test file
 * full of `any` reads is how a document's real shape stops being checked.
 */
function at(doc: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (Array.isArray(node)) return node[Number(key)];
    if (typeof node === 'object' && node !== null) return (node as Record<string, unknown>)[key];
    return undefined;
  }, doc);
}

/** Parse a YAML fixture and deep-clone it, the way a save path receives it. */
function loadAndClone(text: string): { onDisk: unknown; copy: Record<string, unknown> } {
  const onDisk = yaml.load(text);
  return { onDisk, copy: JSON.parse(JSON.stringify(onDisk)) as Record<string, unknown> };
}

describe('deepMerge', () => {
  it('keeps base keys the overlay does not mention, and overlay wins on conflict', () => {
    expect(merge({ a: 1, b: 2 }, { b: 99 })).toEqual({ a: 1, b: 99 });
  });

  it('merges nested objects key by key', () => {
    const base = { amf: { ngap: { server: [{ address: '10.0.0.1' }], dev: 'eth0' }, sbi: { port: 7777 } } };
    const overlay = { amf: { ngap: { server: [{ address: '10.0.0.2' }] } } };
    expect(merge(base, overlay)).toEqual({
      amf: { ngap: { server: [{ address: '10.0.0.2' }], dev: 'eth0' }, sbi: { port: 7777 } },
    });
  });

  it('replaces arrays wholesale rather than merging them', () => {
    // Critical: removing a session pool in the UI must actually remove it.
    const base = { upf: { session: [{ subnet: '10.45.0.0/16' }, { subnet: '10.46.0.0/16' }] } };
    const overlay = { upf: { session: [{ subnet: '10.45.0.0/16' }] } };
    expect(merge(base, overlay)).toEqual({ upf: { session: [{ subnet: '10.45.0.0/16' }] } });
  });

  it('preserves an unknown top-level section the NMS never models', () => {
    const base = { amf: { ngap: { server: [{ address: '1.2.3.4' }] } }, custom_section: { key: 'value' } };
    const overlay = { amf: { ngap: { server: [{ address: '5.6.7.8' }] } } };
    const result = merge(base, overlay);
    expect(at(result, 'custom_section.key')).toBe('value');
    expect(at(result, 'amf.ngap.server.0.address')).toBe('5.6.7.8');
  });

  it('applies an explicit null from the overlay', () => {
    expect(merge({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1, b: null });
  });

  it('preserves a deeply nested hand-added section (mme time timers)', () => {
    const base = {
      mme: {
        s1ap: { server: [{ address: '10.0.1.175' }] },
        time: { t3402: { value: 720 }, t3412: { value: 3240 } },
      },
    };
    const overlay = { mme: { s1ap: { server: [{ address: '10.0.1.200' }] } } };
    const result = merge(base, overlay);
    expect(at(result, 'mme.s1ap.server.0.address')).toBe('10.0.1.200');
    expect(at(result, 'mme.time.t3402.value')).toBe(720);
    expect(at(result, 'mme.time.t3412.value')).toBe(3240);
  });

  describe('edge cases', () => {
    it('returns the base unchanged for an empty overlay', () => {
      const base = { a: 1, b: { c: 2 } };
      expect(merge(base, {})).toEqual(base);
    });

    it('lets the overlay win when the base is not a mapping', () => {
      expect(merge(null, { a: 1 })).toEqual({ a: 1 });
      expect(merge('string', { a: 1 })).toEqual({ a: 1 });
    });

    it('lets a scalar overlay replace an object base', () => {
      expect(merge({ a: 1 }, 42)).toBe(42);
    });

    it('applies an undefined overlay value without disturbing siblings', () => {
      const result = merge({ a: 1 }, { b: undefined });
      expect(at(result, 'a')).toBe(1);
      expect(at(result, 'b')).toBeUndefined();
    });
  });
});

describe('deepMerge: realistic whole-document round trips', () => {
  it('preserves every untouched field of a real amf.yaml', () => {
    const { onDisk, copy: nmsDoc } = loadAndClone(`
logger:
  file:
    path: /var/log/open5gs/amf.log

global:
  max:
    ue: 1024

amf:
  sbi:
    server:
      - address: 127.0.0.5
        port: 7777
    client:
      nrf:
        - uri: http://127.0.0.10:7777
  ngap:
    server:
      - address: 10.0.1.155
  guami:
    - plmn_id:
        mcc: '999'
        mnc: '70'
      amf_id:
        region: 2
        set: 1
  security:
    integrity_order:
      - NIA2
      - NIA1
  # This is a comment that will be lost (expected)
  amf_name: open5gs-amf0
`);

    (at(nmsDoc, 'amf.ngap.server.0') as Record<string, unknown>).address = '10.0.1.200';

    const merged = merge(onDisk, nmsDoc);
    expect(at(merged, 'amf.ngap.server.0.address')).toBe('10.0.1.200');
    expect(at(merged, 'amf.amf_name')).toBe('open5gs-amf0');
    expect(at(merged, 'amf.guami.0.plmn_id.mcc')).toBe('999');
    expect(at(merged, 'logger.file.path')).toBe('/var/log/open5gs/amf.log');
    expect(at(merged, 'global.max.ue')).toBe(1024);
    expect(at(merged, 'amf.security.integrity_order.0')).toBe('NIA2');
  });

  it('documents that a session-pool `dev:` is lost when the NMS omits it', () => {
    // Arrays replace, so a hand-added dev: inside a session entry survives only
    // if the NMS sends it back. The editors do send it; this pins the rule that
    // explains why they have to.
    const onDisk = {
      smf: {
        session: [
          { subnet: '10.45.0.0/16', gateway: '10.45.0.1', dev: 'ogstun2' },
          { subnet: '2001:db8::/48', gateway: '2001:db8::1' },
        ],
        pfcp: { server: [{ address: '127.0.0.4' }] },
      },
    };
    const nmsDoc = {
      smf: {
        session: [
          { subnet: '10.45.0.0/16', gateway: '10.45.0.1' },
          { subnet: '2001:db8::/48', gateway: '2001:db8::1' },
        ],
        pfcp: { server: [{ address: '127.0.0.4' }] },
      },
    };
    const merged = merge(onDisk, nmsDoc);
    expect(at(merged, 'smf.session')).toHaveLength(2);
    expect(at(merged, 'smf.session.0.subnet')).toBe('10.45.0.0/16');
    expect(at(merged, 'smf.session.0.dev')).toBeUndefined();
    expect(at(merged, 'smf.pfcp.server.0.address')).toBe('127.0.0.4');
  });

  it('keeps a session pool `dev:`/`dnn:` when the NMS does send them', () => {
    const onDisk = {
      upf: {
        session: [{ subnet: '10.45.0.0/16', gateway: '10.45.0.1' }],
        gtpu: { server: [{ address: '10.0.1.155' }] },
      },
    };
    const nmsDoc = {
      upf: {
        session: [{ subnet: '10.45.0.0/16', gateway: '10.45.0.1', dev: 'ogstun2', dnn: 'internet' }],
        gtpu: { server: [{ address: '10.0.1.155' }] },
      },
    };
    const merged = merge(onDisk, nmsDoc);
    expect(at(merged, 'upf.session.0.dev')).toBe('ogstun2');
    expect(at(merged, 'upf.session.0.dnn')).toBe('internet');
    expect(at(merged, 'upf.session.0.subnet')).toBe('10.45.0.0/16');
  });

  it('survives a parse -> modify -> merge -> dump -> parse cycle', () => {
    const { onDisk, copy: nmsWrite } = loadAndClone(`
amf:
  sbi:
    server:
      - address: 127.0.0.5
        port: 7777
  ngap:
    server:
      - address: 10.0.1.155
  amf_name: open5gs-amf0
  custom_field: keep_me
logger:
  file:
    path: /var/log/open5gs/amf.log
`);

    (at(nmsWrite, 'amf.ngap.server.0') as Record<string, unknown>).address = '192.168.1.100';

    const reparsed = yaml.load(yaml.dump(merge(onDisk, nmsWrite)));
    expect(at(reparsed, 'amf.ngap.server.0.address')).toBe('192.168.1.100');
    expect(at(reparsed, 'amf.amf_name')).toBe('open5gs-amf0');
    expect(at(reparsed, 'amf.custom_field')).toBe('keep_me');
    expect(at(reparsed, 'amf.sbi.server.0.port')).toBe(7777);
    expect(at(reparsed, 'logger.file.path')).toBe('/var/log/open5gs/amf.log');
  });

  it('keeps a hand-added mme time: section across a full dump cycle', () => {
    const { onDisk, copy: nmsWrite } = loadAndClone(`
mme:
  s1ap:
    server:
      - address: 10.0.1.175
  gtpc:
    server:
      - address: 127.0.0.2
  gummei:
    - plmn_id:
        mcc: '999'
        mnc: '70'
      mme_gid: 2
      mme_code: 1
  # manually added timers:
  time:
    t3402:
      value: 720
    t3412:
      value: 3240
logger:
  file:
    path: /var/log/open5gs/mme.log
`);

    (at(nmsWrite, 'mme.s1ap.server.0') as Record<string, unknown>).address = '10.0.1.200';

    const reparsed = yaml.load(yaml.dump(merge(onDisk, nmsWrite)));
    expect(at(reparsed, 'mme.s1ap.server.0.address')).toBe('10.0.1.200');
    expect(at(reparsed, 'mme.time.t3402.value')).toBe(720);
    expect(at(reparsed, 'mme.time.t3412.value')).toBe(3240);
    expect(at(reparsed, 'mme.gummei.0.mme_gid')).toBe(2);
    expect(at(reparsed, 'logger.file.path')).toBe('/var/log/open5gs/mme.log');
  });
});

// Real bug, 2026-11-26: gtpc was the one endpoint read without a server[]
// branch, so on every real config (which uses the nested form exclusively) it
// fell through to resolveAddr(undefined) -> '127.0.0.1'.
describe('parseGtpc', () => {
  const parse = (raw: unknown): { addr: string; port?: number } | undefined => internals.parseGtpc(raw);

  it('reads the nested server[] form every real config uses', () => {
    expect(parse({ server: [{ address: '127.0.0.4' }] })).toEqual({ addr: '127.0.0.4', port: undefined });
  });

  it('carries an explicit port through', () => {
    expect(parse({ server: [{ address: '127.0.0.2', port: 2123 }] })).toEqual({ addr: '127.0.0.2', port: 2123 });
  });

  it('takes the first entry of a list-valued address', () => {
    expect(parse({ server: [{ address: ['127.0.0.3', '10.0.0.3'] }] })?.addr).toBe('127.0.0.3');
  });

  it('still accepts the legacy flat form', () => {
    expect(parse({ addr: '127.0.0.4', port: 2123 })).toEqual({ addr: '127.0.0.4', port: 2123 });
  });

  it('returns undefined rather than a loopback default when nothing is configured', () => {
    // Returning the default is exactly what made the wrong address look real.
    expect(parse(undefined)).toBeUndefined();
    expect(parse({})).toBeUndefined();
    expect(parse({ server: [] })).toBeUndefined();
    expect(parse({ server: [{ port: 2123 }] })).toBeUndefined();
  });
});

// fixMccMncSdFromRawYaml index-matches text occurrences against the parsed
// tree, so the scan has to run in document order and must not skip a form.
describe('fixMccMncSdFromRawYaml', () => {
  const fix = (text: string, doc: unknown): unknown => internals.fixMccMncSdFromRawYaml(text, doc);

  it('restores leading zeros js-yaml would have eaten', () => {
    const text = 'plmn_id:\n  mcc: 001\n  mnc: 01\n';
    expect(fix(text, { plmn_id: { mcc: 1, mnc: 1 } })).toEqual({ plmn_id: { mcc: '001', mnc: '01' } });
  });

  it('assigns each occurrence in document order', () => {
    const text = 'a:\n  mcc: 001\nb:\n  mcc: 310\n';
    expect(fix(text, { a: { mcc: 1 }, b: { mcc: 310 } })).toEqual({ a: { mcc: '001' }, b: { mcc: '310' } });
  });

  it('does not shift later occurrences when one is quoted', () => {
    // The bare-only pattern used to skip the quoted entry, so '310' landed on
    // the first mcc and everything after it was off by one.
    const text = "a:\n  mcc: '001'\nb:\n  mcc: 310\n";
    expect(fix(text, { a: { mcc: '001' }, b: { mcc: 310 } })).toEqual({ a: { mcc: '001' }, b: { mcc: '310' } });
  });

  it('handles double-quoted sd alongside bare mcc/mnc', () => {
    const text = 'plmn_id:\n  mcc: 001\n  mnc: 01\ns_nssai:\n  - sst: 1\n    sd: "000019"\n';
    const doc = { plmn_id: { mcc: 1, mnc: 1 }, s_nssai: [{ sst: 1, sd: '000019' }] };
    expect(fix(text, doc)).toEqual({ plmn_id: { mcc: '001', mnc: '01' }, s_nssai: [{ sst: 1, sd: '000019' }] });
  });
});

// CLAUDE.md pattern #2: saveRaw() re-reads the file and merges the incoming doc
// on top so unknown keys survive. A file that cannot be parsed used to be
// reported as an empty document, indistinguishable from no file at all, which
// turned the merge into a silent full overwrite.
describe('saveRaw refuses to overwrite a file it could not parse', () => {
  function repoReading(content: string, written: string[]): YamlConfigRepository {
    const exec: Partial<IHostExecutor> = {
      readFile: () => Promise.resolve(content),
      writeFile: (_path: string, data: string) => { written.push(data); return Promise.resolve(); },
    };
    return makeRepo(exec).repo;
  }

  it('throws instead of writing when the on-disk YAML is malformed', async () => {
    const written: string[] = [];
    // A genuine js-yaml error: a block mapping cannot follow a scalar value.
    const repo = repoReading('pcf:\n  sbi: oops\n   bad indent: [\n', written);
    await expect(repo.savePcf({ rawYaml: { pcf: { sbi: {} } } })).rejects.toThrow(/could not be parsed/);
    expect(written).toHaveLength(0);
  });

  it('writes normally when the on-disk YAML parses', async () => {
    const written: string[] = [];
    const repo = repoReading('pcf:\n  policy: keep_me\n', written);
    await repo.savePcf({ rawYaml: { pcf: { sbi: { server: [{ address: '127.0.0.13' }] } } } });
    expect(written).toHaveLength(1);
    const reparsed = yaml.load(written[0]);
    expect(at(reparsed, 'pcf.policy')).toBe('keep_me');
    expect(at(reparsed, 'pcf.sbi.server.0.address')).toBe('127.0.0.13');
  });

  it('writes fresh when the file is simply absent', async () => {
    const written: string[] = [];
    const exec: Partial<IHostExecutor> = {
      readFile: () => Promise.reject(new Error('ENOENT')),
      writeFile: (_path: string, data: string) => { written.push(data); return Promise.resolve(); },
    };
    const { repo } = makeRepo(exec);
    await repo.savePcf({ rawYaml: { pcf: { sbi: { server: [{ address: '127.0.0.13' }] } } } });
    expect(written).toHaveLength(1);
  });

  it('writes fresh when the file exists but is empty', async () => {
    const written: string[] = [];
    const repo = repoReading('\n', written);
    await repo.savePcf({ rawYaml: { pcf: { metrics: { server: [{ address: '127.0.0.13' }] } } } });
    expect(written).toHaveLength(1);
  });
});
