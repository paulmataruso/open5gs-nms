import * as fs from 'fs';
import * as path from 'path';
import { osmobscCfg } from '../../../interfaces/rest/gsm-controller';
import {
  ownedDirectivesFromGenerated, upsertVtyPathDirectives, removeVtyPathNode,
} from '../../../domain/services/vty-config-ownership';

// R1 from the 2026-10-10 readiness audit, the most destructive finding in it.
// osmo-bsc.cfg was regenerated wholesale on every GSM Configure, BTS
// add/edit/delete and IP-Plan apply touching BSC/MGW. Against this deployment's
// real file that discarded 67 substantive hand-maintained lines, then restarted
// the BSC and dropped every camped 2G UE.
//
// The fixture is this host's genuine 210-line osmo-bsc.cfg, so these assert
// against a real operator-tuned file rather than a synthetic one.
const LIVE = fs.readFileSync(path.join(__dirname, '__fixtures__osmo-bsc.live'), 'utf-8');
const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__gsm-bts-state.json'), 'utf-8'));

const KEY_TOKENS = [
  { match: /^meas-feed destination\b/, tokens: 2 },
  { match: /^mgw remote-ip\b/, tokens: 2 },
  { match: /^gprs nsvc \d+ remote ip\b/, tokens: 5 },
  { match: /^ipa unit-id\b/, tokens: 2 },
  { match: /^encryption a5\b/, tokens: 2 },
];

const generate = (st = STATE) =>
  osmobscCfg('001', '01', st.btsEntries, st.bscMgwBindIp ?? '127.0.0.1', st.sgsnGbRemoteIp ?? '');
const merge = (live = LIVE, st = STATE) =>
  upsertVtyPathDirectives(live, ownedDirectivesFromGenerated(generate(st), KEY_TOKENS));

// Exactly the lines the audit measured as lost. Each one is load-bearing:
// losing point-code takes down the A-interface and therefore all of 2G.
const PREVIOUSLY_LOST = [
  'point-code 0.23.3',
  'stats interval 5',
  'amr tch-f modes 0 2 5 7',
  'amr tch-f threshold ms 13 25 37',
  'amr tch-h start-mode auto',
  'gprs cell timer reset-retries 3',
  'gprs ns timer tns-alive-retries 10',
  'bs-power-control',
  'ms-power-control',
  'rxqual-thresh-comp lower 5 7 upper 15 18',
  'codec-list fr1 hr1 fr2 fr3 hr3',
  'amr-payload octet-aligned',
  'asp-protocol m3ua',
  'lcls-mode disabled',
  'no access-control-class-ramping',
  'early-classmark-sending-3g allowed',
  'neighbor-list mode automatic',
  'rach max-delay 63',
  'e1_line 0 port 0',
  'no login',
];

describe('osmo-bsc.cfg is merged, not regenerated', () => {
  it('a wholesale regenerate really would destroy all of it (the bug)', () => {
    // Pins the premise: if this ever stops being true the fix is moot.
    const gen = generate();
    const lost = PREVIOUSLY_LOST.filter(l => !gen.includes(l));
    expect(lost.length).toBeGreaterThanOrEqual(18);
    expect(gen).not.toContain('point-code 0.23.3');
  });

  it('every one of those lines survives the merge', () => {
    const out = merge();
    for (const must of PREVIOUSLY_LOST) expect(out).toContain(must);
  });

  it('merging current state over the live file is a byte-for-byte no-op', () => {
    // The strongest check available: the generator's modelled values already
    // match reality, so a correct merge must change nothing at all. It catches
    // both a missing directive (would be appended) and a mis-keyed one (would
    // duplicate).
    expect(merge()).toBe(LIVE);
  });

  it('still applies a real change, deep inside bts 0 / trx 0', () => {
    const st = JSON.parse(JSON.stringify(STATE));
    st.btsEntries[0].arfcn = 777;
    st.btsEntries[0].cellIdentity = 42;
    const out = merge(LIVE, st);
    expect(out).toMatch(/^\s+arfcn 777$/m);
    expect(out).toMatch(/^\s+cell_identity 42$/m);
    expect(out).not.toMatch(/^\s+arfcn 661$/m);
    // ...without collateral damage.
    expect(out).toContain('point-code 0.23.3');
    expect(out).toContain('amr tch-f modes 0 2 5 7');
  });

  it('changing the MGW bind IP rewrites only that directive', () => {
    const out = merge(LIVE, { ...STATE, bscMgwBindIp: '127.0.0.9' });
    expect(out).toMatch(/^\s+mgw remote-ip 127\.0\.0\.9$/m);
    expect(out.split('\n').filter(l => /mgw remote-ip/.test(l))).toHaveLength(1);
    expect(out).toContain('point-code 0.23.3');
  });

  it('deleting a BTS removes its whole subtree, not just a header', () => {
    const out = removeVtyPathNode(LIVE, ['network', 'bts 0']);
    expect(out).not.toMatch(/^\s+bts 0\s*$/m);
    expect(out).not.toMatch(/^\s+trx 0\s*$/m);          // its child
    expect(out).not.toMatch(/^\s+phys_chan_config/m);   // its grandchild
    // Siblings and the parent are untouched.
    expect(out).toMatch(/^network\s*$/m);
    expect(out).toMatch(/^msc 0\s*$/m);
    expect(out).toContain('point-code 0.23.3');
    expect(out).toContain('codec-list fr1 hr1 fr2 fr3 hr3');
  });

  it('the owned set is derived from the generator, so it cannot drift', () => {
    const owned = ownedDirectivesFromGenerated(generate(), KEY_TOKENS);
    expect(owned.length).toBeGreaterThan(50);
    // Node headers define paths; they are not themselves owned content.
    expect(owned.some(d => /^bts \d+$/.test(d.line ?? ''))).toBe(false);
    expect(owned.some(d => /^trx \d+$/.test(d.line ?? ''))).toBe(false);
    // Paths really are nested.
    expect(owned.some(d => d.path.join('/') === 'network/bts 0')).toBe(true);
    expect(owned.some(d => d.path.join('/') === 'network/bts 0/trx 0')).toBe(true);
    expect(owned.some(d => d.path.join('/').startsWith('network/bts 0/trx 0/timeslot'))).toBe(true);
  });

  it('the eight amr-config lines stay distinct rather than collapsing', () => {
    // All eight share a first word; keying on it alone would leave one line.
    const out = merge();
    const amr = out.split('\n').filter(l => /^\s+amr-config /.test(l));
    expect(amr).toHaveLength(8);
    expect(out).toContain('amr-config 5_90k allowed');
    expect(out).toContain('amr-config 12_2k forbidden');
  });

  it('a fresh host with no file falls back to the full template', () => {
    const out = upsertVtyPathDirectives('', ownedDirectivesFromGenerated(generate(), KEY_TOKENS));
    // Nothing to merge into — the caller writes the template instead, which is
    // what writeOsmoBscCfg() does for an empty/missing file.
    expect(out.trim()).toBe('');
  });

  it('is idempotent — merging twice changes nothing further', () => {
    const once = merge();
    expect(merge(once)).toBe(once);
  });
});
