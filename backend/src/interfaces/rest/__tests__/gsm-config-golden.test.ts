import * as fs from 'fs';
import * as path from 'path';
import {
  osmobscCfg, osmomgwCfg, osmopcuCfg, osmosgsnCfg, osmoggsnCfg, osmobtsVirtualCfg, btsBlock,
} from '../gsm-controller';
import type { BtsEntry } from '../gsm-controller';

/**
 * Golden-master tests for the generated Osmocom 2G config files.
 *
 * WHY THIS EXISTS. These files drive real GSM hardware transmitting on real
 * spectrum, and this module's own history is three separate config-FIDELITY
 * bugs rather than logic bugs: `configureSms()` blindly overwriting
 * `osmo-msc.cfg` and destroying live SS7/ciphering/SMPP config; the VTY merge
 * skipping directives whose parent node was absent, so osmo-bsc never learned
 * about any BTS at all; and `codec-support fr` under-declaring the real
 * nanoBTS's AMR capability, which was misdiagnosed for a day as an unfixable
 * hardware RF fault. Every one of those is invisible to a test that only
 * checks a function returns successfully, and visible immediately in a diff of
 * the file it produces. Same reasoning as ims-config-golden.test.ts, applied
 * to the module where a wrong byte reaches an antenna.
 *
 * WHAT WAS VERIFIED AGAINST THE LIVE HOST, 2026-11-28. All six Osmocom
 * daemons were active on this deployment at capture time, so these are not
 * merely a record of the code's current behaviour:
 *
 *   osmo-mgw.cfg, osmo-pcu.cfg, osmo-ggsn.cfg   BYTE-IDENTICAL to the live
 *                                               file in /etc/osmocom
 *   osmo-bsc.cfg, osmo-sgsn.cfg                 all 109 generated directives
 *                                               present in the live file
 *   osmo-bts-virtual.cfg                        NOT verifiable, see below
 *
 * The split is not arbitrary. The first three are written by `writeHostCfg`,
 * a full overwrite, so the generated text IS the file and byte-equality is
 * the right check. `osmo-bsc.cfg` and `osmo-sgsn.cfg` go through the
 * ownership MERGE (`writeOsmoBscCfg`/`writeSgsnCfg` -> upsertVtyPathDirectives)
 * precisely so an operator's own directives survive a regenerate, so the live
 * file is a superset by design — 210 lines against 91 for osmo-bsc — and
 * demanding byte-equality there would be demanding that the merge not work.
 * Containment is the strongest true claim, and it held for every directive.
 *
 * `osmo-bts-virtual.cfg` could not be verified because this deployment's BTS
 * is `remote-abis-ip` (a real nanoBTS), so the NMS has never written that
 * file here — the copy on the host is the Osmocom package default from April
 * 2024. Its golden is therefore a record of the generator only, and that
 * limit is stated rather than quietly folded in with the rest.
 *
 * WHAT A FAILURE MEANS. Either the change was not meant to alter output — in
 * which case the diff is the bug — or it was deliberate, in which case
 * regenerate with
 *
 *     UPDATE_GOLDEN=1 npx jest gsm-config-golden
 *
 * and the diff is what a reviewer should read. Never regenerate to turn a red
 * test green without reading it: on this module that is how a BTS stops
 * coming up.
 *
 * WHY THESE PARAMETERS. They are this deployment's real live values, read
 * from `/etc/osmocom/.nms-gsm-bts-state.json` and the PLMN in `mme.yaml`:
 * PLMN 001-01, one remote-abis-ip nanoBTS on PCS1900 ARFCN 661 at
 * 172.16.0.108, EGPRS on, SGSN Gb peer 172.16.0.168. GPRS is ON in the
 * captured state, which matters: it is the configuration in which the
 * `gprs nsvc` family is emitted at all, and a generator that drops it is
 * detectable.
 *
 * No credential is committed here. The live `osmo-msc.cfg` is deliberately
 * NOT in this set: it carries two real SMPP passwords, one of which is a
 * deployment-specific value that appears nowhere in this repository. It is
 * also not produced by these generators — `sms-controller.ts` states it never
 * writes an smpp/esme block to that file, which arrives by live VTY command —
 * and its merge already has four test files of its own.
 */

const GOLDEN_DIR = path.join(__dirname, 'golden', 'gsm');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** The live nanoBTS, verbatim from this host's own state file. */
const LIVE_BTS: BtsEntry[] = [{
  id: 'ecb33bc2-c660-49f9-9486-f5ce6be9cc38',
  name: 'ip.access nanoBTS',
  backend: 'remote-abis-ip',
  unitId: 1,
  band: 'PCS1900',
  arfcn: 661,
  cellIdentity: 2,
  locationAreaCode: 1,
  baseStationIdCode: 63,
  remoteIp: '172.16.0.108',
  gprsMode: 'egprs',
  blocked: false,
  lteEarfcns: [0],
}];

const CASES: Array<{ file: string; render: () => string }> = [
  { file: 'osmo-bsc.cfg', render: () => osmobscCfg('001', '01', LIVE_BTS, '127.0.0.1', '172.16.0.168') },
  { file: 'osmo-mgw.cfg', render: () => osmomgwCfg('127.0.0.1', '127.0.0.1') },
  { file: 'osmo-pcu.cfg', render: () => osmopcuCfg() },
  { file: 'osmo-sgsn.cfg', render: () => osmosgsnCfg('127.0.0.1', '127.0.0.5', '127.0.0.1', 'internet') },
  { file: 'osmo-ggsn.cfg', render: () => osmoggsnCfg('127.0.0.5', 'internet', 'apn-gprs', '10.45.0.128/25', '10.0.1.180', '9.9.9.9') },
  { file: 'osmo-bts-virtual.cfg', render: () => osmobtsVirtualCfg(1, 'PCS1900', '127.0.0.1') },
];

describe('generated Osmocom configs match their golden masters', () => {
  it.each(CASES.map((c) => [c.file, c] as const))('%s', (file, c) => {
    const golden = path.join(GOLDEN_DIR, file);
    const rendered = c.render();
    if (UPDATE) {
      fs.writeFileSync(golden, rendered, 'utf-8');
      return;
    }
    expect(fs.readFileSync(golden, 'utf-8')).toBe(rendered);
  });

  it('the golden directory holds exactly the files under test', () => {
    // A golden left behind after its generator is deleted stops being
    // checked by anything while still looking like coverage.
    expect(fs.readdirSync(GOLDEN_DIR).sort()).toEqual(CASES.map((c) => c.file).sort());
  });
});

/**
 * The properties below are NOT a second copy of the golden files. Each one
 * encodes a specific real incident, so that a regenerate-without-reading
 * cannot quietly undo it: a golden diff asks a human to notice, these fail on
 * their own.
 */
describe('directives that a real incident put there', () => {
  const bsc = osmobscCfg('001', '01', LIVE_BTS, '127.0.0.1', '172.16.0.168');

  it('declares AMR alongside full-rate in codec-support', () => {
    // `codec-support fr` alone under-declared the nanoBTS's own AMR
    // capability (it advertises AMR in its real OML feature vector), which
    // made every TCH assignment fail. That was misdiagnosed as an unfixable
    // hardware RF reliability problem for a day before the config was read.
    expect(bsc).toMatch(/^\s*codec-support fr amr\s*$/m);
  });

  it('sets radio-link-timeout to 64, osmo-bsc\'s real maximum', () => {
    // Raised from 32 as a mitigation for intermittent T200/Radio Link
    // Failure drops on real hardware. `infinite` is deliberately NOT used:
    // a genuinely dead link would then never release its channel.
    expect(bsc).toMatch(/^\s*radio-link-timeout 64\s*$/m);
  });

  it('emits the gprs nsvc remote address only while GPRS is on', () => {
    // The outage this prevents: leftover `gprs nsvc 0 remote ip ...` lines
    // with `gprs mode none` made osmo-bsc reject the whole file ("GPRS is
    // not enabled on BTS 0") and took 2G down. The generator must stop
    // emitting them, which is what lets the owned-family prune remove them.
    expect(bsc).toContain('gprs nsvc 0 remote ip 172.16.0.168');
    const off = osmobscCfg('001', '01',
      [{ ...LIVE_BTS[0], gprsMode: 'none' }], '127.0.0.1', '172.16.0.168');
    expect(off).not.toContain('gprs nsvc');
    expect(off).toMatch(/^\s*gprs mode none\s*$/m);
  });

  it('a blocked BTS is not expressed in the file at all', () => {
    // Administrative lock is applied over the VTY via `rf_locked` on the TRX,
    // because `change-adm-state` at the OML pseudo-node is silently reverted
    // by osmo-bsc's own reconciliation loop. So the generated config must NOT
    // try to encode the lock — if a future change starts emitting something
    // here, the two mechanisms will disagree and the file will win on restart.
    const blocked = osmobscCfg('001', '01',
      [{ ...LIVE_BTS[0], blocked: true }], '127.0.0.1', '172.16.0.168');
    expect(blocked).toBe(bsc);
  });

  it('gives each BTS its own index and its own ipa unit-id', () => {
    // Two BTSes sharing an index silently collapse into one in osmo-bsc's own
    // numbering.
    const two = osmobscCfg('001', '01',
      [LIVE_BTS[0], { ...LIVE_BTS[0], id: 'second', unitId: 2, remoteIp: '172.16.0.109' }],
      '127.0.0.1', '172.16.0.168');
    expect(two).toMatch(/^\s*bts 0\s*$/m);
    expect(two).toMatch(/^\s*bts 1\s*$/m);
    expect(two).toMatch(/^\s*ipa unit-id 1 0\s*$/m);
    expect(two).toMatch(/^\s*ipa unit-id 2 0\s*$/m);
  });

  it('never writes a BTS\'s IP address into osmo-bsc.cfg', () => {
    // Measured, and the opposite of the obvious expectation: `remoteIp` is in
    // the BTS state and in the UI, and it appears NOWHERE in the generated
    // file. That is correct — an ip.access nanoBTS dials the BSC over
    // Abis/IP and is identified by its `ipa unit-id`, so the BSC never
    // addresses it. remoteIp is used for the things that really do reach out
    // to the unit: the meas-feed peer and the VTY rf_locked path.
    //
    // Pinned because adding the address here is a plausible-looking "fix"
    // that encodes the Abis/IP relationship backwards, and nothing else would
    // catch it: osmo-bsc would still start, and the BTS would still connect.
    expect(bsc).not.toContain('172.16.0.108');
    const moved = osmobscCfg('001', '01',
      [{ ...LIVE_BTS[0], remoteIp: '10.9.9.9' }], '127.0.0.1', '172.16.0.168');
    expect(moved).toBe(bsc);
  });

  it('btsBlock renders one BTS at the index it is given', () => {
    // Exercised directly because writeOsmoBscCfg prunes `bts N` nodes by
    // index, so the index in the text and the index it prunes must agree.
    expect(btsBlock(LIVE_BTS[0], 3)).toMatch(/^\s*bts 3\s*$/m);
    expect(btsBlock(LIVE_BTS[0], 0)).toMatch(/^\s*bts 0\s*$/m);
  });
});
