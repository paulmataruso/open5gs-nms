import { upsertHssSmsOverIms } from '../ims-controller';
import * as yaml from 'js-yaml';

/**
 * `hss.sms_over_ims` is what tells Open5GS HSS to advertise SMS-over-IMS
 * capability to a 4G subscriber. IMS Configure sets it with a TEXT edit,
 * because hss.yaml is not managed through the YAML repository.
 *
 * HSS is one of the four DB-backed NFs, so a malformed hss.yaml takes 4G S6a
 * down with it -- which is why the write now goes through writeYamlGuarded
 * like smf.yaml and upf.yaml do, and why these tests check the output still
 * parses as YAML rather than only that the right characters appear.
 *
 * Two defects in the previous inline version were reproduced before fixing,
 * and the first two tests below are those exact reproductions.
 */

const URI = 'sip:smsc.ims.mnc001.mcc001.3gppnetwork.org:7090;transport=tcp';

/** This deployment's real hss.yaml, as read from the live host. */
const LIVE = `db_uri: mongodb://127.0.0.1/open5gs
logger:
  level: debug
  file:
    path: /var/log/open5gs/hss.log
global:
  max:
    ue: 1024
hss:
  sms_over_ims: "${URI}"
  freeDiameter: /etc/freeDiameter/hss.conf
  metrics:
    server:
      - address: 127.0.0.8
        port: 9090
`;

const smsOverImsOf = (text: string): unknown =>
  (yaml.load(text) as { hss?: { sms_over_ims?: unknown } }).hss?.sms_over_ims;

describe('the two silent failures this replaced', () => {
  it('updates the real key, not a commented-out copy above it', () => {
    // The old version guarded on raw.includes('sms_over_ims') -- a whole-file
    // substring test -- then replaced the FIRST occurrence. With an ordinary
    // hand-commented line above the real key, the COMMENT was rewritten to
    // the new URI (staying inert) while the live key kept its old value, and
    // Configure reported success.
    const raw = [
      'hss:',
      '  # sms_over_ims: "sip:smsc.OLD.example:7090;transport=tcp"',
      '  sms_over_ims: "sip:smsc.OLD.example:7090;transport=tcp"',
      '  freeDiameter: /etc/freeDiameter/hss.conf',
      '',
    ].join('\n');
    const { yaml: out, changed } = upsertHssSmsOverIms(raw, URI);
    expect(changed).toBe(true);
    // The value HSS actually reads is the new one.
    expect(smsOverImsOf(out)).toBe(URI);
    // And the comment was left alone.
    expect(out).toContain('  # sms_over_ims: "sip:smsc.OLD.example:7090;transport=tcp"');
  });

  it('reports when there is no hss: block instead of writing back unchanged', () => {
    // The old version matched neither branch here and wrote the file back
    // untouched with no error, so the capability was never configured.
    const raw = 'db_uri: mongodb://127.0.0.1/open5gs\nlogger:\n  level: debug\n';
    const res = upsertHssSmsOverIms(raw, URI);
    expect(res.changed).toBe(false);
    expect(res.reason).toBe('no-hss-block');
    expect(res.yaml).toBe(raw);
  });
});

describe('how Configure reports the no-hss-block case', () => {
  it('is reportable as a warning rather than indistinguishable from success', () => {
    // configureIms() collects this into its returned warnings[], which the
    // route both logs and puts in the response, so it can reach the UI. The
    // point is that "there was nowhere to put it" is no longer silent.
    const res = upsertHssSmsOverIms('db_uri: mongodb://127.0.0.1/open5gs\n', URI);
    expect(res.changed).toBe(false);
    expect(res.reason).toBe('no-hss-block');
  });

  it('distinguishes nothing-to-do from nowhere-to-put-it', () => {
    // Both return changed:false, and treating them alike is what hid the bug:
    // one is a healthy repeat Configure, the other is a file we could not edit.
    const current = upsertHssSmsOverIms(LIVE, URI);
    const nowhere = upsertHssSmsOverIms('logger:\n  level: debug\n', URI);
    expect(current.changed).toBe(false);
    expect(nowhere.changed).toBe(false);
    expect(current.reason).not.toBe(nowhere.reason);
  });
});

describe('the live host\'s own file', () => {
  it('is left byte-identical when the value is already current', () => {
    // The real deployment already holds exactly this URI. Re-running Configure
    // must not rewrite the file at all -- not a no-op write, no write.
    const res = upsertHssSmsOverIms(LIVE, URI);
    expect(res.changed).toBe(false);
    expect(res.reason).toBe('already-current');
    expect(res.yaml).toBe(LIVE);
  });

  it('changes only that one line when the URI moves', () => {
    const next = 'sip:smsc.ims.mnc002.mcc002.3gppnetwork.org:7090;transport=tcp';
    const { yaml: out, changed } = upsertHssSmsOverIms(LIVE, next);
    expect(changed).toBe(true);
    const diff = out.split('\n').filter((l, i) => l !== LIVE.split('\n')[i]);
    expect(diff.length).toBe(1);
    expect(diff[0]).toContain('sms_over_ims');
    // Everything else HSS needs is still there and still parses.
    const doc = yaml.load(out) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(['db_uri', 'global', 'hss', 'logger']);
    expect((doc.hss as Record<string, unknown>).freeDiameter)
      .toBe('/etc/freeDiameter/hss.conf');
  });
});

describe('inserting when the key is absent', () => {
  it('places it under hss: and parses', () => {
    const raw = 'hss:\n  freeDiameter: /etc/freeDiameter/hss.conf\n';
    const { yaml: out, changed } = upsertHssSmsOverIms(raw, URI);
    expect(changed).toBe(true);
    expect(smsOverImsOf(out)).toBe(URI);
  });

  it('matches the block\'s existing child indentation, not a fixed two spaces', () => {
    // A 4-space file would otherwise get a 2-space child, which is still valid
    // YAML but silently reformats an operator's file.
    const raw = 'hss:\n    freeDiameter: /etc/freeDiameter/hss.conf\n';
    const { yaml: out } = upsertHssSmsOverIms(raw, URI);
    expect(out).toContain(`\n    sms_over_ims: "${URI}"`);
    expect(smsOverImsOf(out)).toBe(URI);
  });

  it('keeps the other top-level sections intact', () => {
    const raw = 'db_uri: mongodb://127.0.0.1/open5gs\nhss:\n  freeDiameter: /x\nlogger:\n  level: debug\n';
    const doc = yaml.load(upsertHssSmsOverIms(raw, URI).yaml) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(['db_uri', 'hss', 'logger']);
    expect(doc.db_uri).toBe('mongodb://127.0.0.1/open5gs');
  });
});

describe('repeated Configure runs', () => {
  it('is idempotent — the second run reports no change and alters nothing', () => {
    const raw = 'hss:\n  freeDiameter: /x\n';
    const first = upsertHssSmsOverIms(raw, URI);
    expect(first.changed).toBe(true);
    const second = upsertHssSmsOverIms(first.yaml, URI);
    expect(second.changed).toBe(false);
    expect(second.yaml).toBe(first.yaml);
  });

  it('never ends up with two sms_over_ims keys', () => {
    // Duplicate keys are the failure mode a naive append would produce, and
    // js-yaml would then silently take the last one.
    let text = 'hss:\n  freeDiameter: /x\n';
    for (const u of [URI, 'sip:a.example:7090', 'sip:b.example:7090', URI]) {
      text = upsertHssSmsOverIms(text, u).yaml;
    }
    expect((text.match(/^\s*sms_over_ims:/gm) ?? []).length).toBe(1);
    expect(smsOverImsOf(text)).toBe(URI);
  });
});

describe('indentation and position are preserved', () => {
  it('keeps the key\'s own indentation when replacing', () => {
    const raw = 'hss:\n    sms_over_ims: "sip:old:1"\n    freeDiameter: /x\n';
    const { yaml: out } = upsertHssSmsOverIms(raw, URI);
    expect(out).toContain(`    sms_over_ims: "${URI}"`);
    expect(out).not.toMatch(/^sms_over_ims:/m);
  });

  it('does not move the key relative to its siblings', () => {
    const { yaml: out } = upsertHssSmsOverIms(LIVE, 'sip:new.example:7090');
    // Scoped to the hss: block -- a bare two-space filter also catches the
    // children of logger: and global:.
    const lines = out.split('\n');
    const start = lines.findIndex(l => l === 'hss:');
    const rest = lines.slice(start + 1);
    const end = rest.findIndex(l => /^\S/.test(l));
    const block = end === -1 ? rest : rest.slice(0, end);
    const keys = block.filter(l => /^ {2}\S/.test(l)).map(l => l.trim().split(':')[0]);
    expect(keys).toEqual(['sms_over_ims', 'freeDiameter', 'metrics']);
  });
});
