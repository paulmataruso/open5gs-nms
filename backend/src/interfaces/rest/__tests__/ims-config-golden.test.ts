import * as fs from 'fs';
import * as path from 'path';
import {
  scscfIncludeCfg, icscfIncludeCfg, smscIncludeCfg, pcscfIncludeCfg,
  scscfDiameterXml, pcscfDiameterXml, icscfDiameterXml,
  type ScscfIncludeParams,
} from '../ims-controller';

/**
 * Golden-master tests for the generated IMS config files.
 *
 * WHY THIS EXISTS. The IMS configs running on the production deployment WORK,
 * and the standing requirement is that any refactor must still produce the
 * same files. "The tests pass" and "it looks equivalent" are not evidence of
 * that; a byte comparison is. So each file under `golden/ims/` is the exact
 * output of its generator for this deployment's real parameters -- and every
 * one of them was verified byte-identical to the file actually live on the
 * host at the time it was captured (2026-11-27), not merely to the code's
 * current behaviour. They are a record of a working network, so a diff here
 * is a real change in what the host would be told to do.
 *
 * WHAT A FAILURE MEANS. Either the change was not meant to alter output -- in
 * which case the diff is the bug, and it is readable because these are files
 * rather than inline strings -- or it was deliberate, in which case regenerate
 * with:
 *
 *     UPDATE_GOLDEN=1 npx jest ims-config-golden
 *
 * and the resulting diff is what a reviewer should be looking at. Never
 * regenerate to make a red test green without reading the diff: that is
 * exactly how a working config silently becomes a broken one.
 *
 * WHY THESE PARAMETERS. They are the live values from the deployment's own
 * `.ims-config.json`, including all four optional features switched ON
 * (VectorCore SMS routing, Ro voice charging, CDR accounting, SIP tracing).
 * That combination matters: it is the state in which a generator that drops a
 * flag is detectable. Nothing here is a credential the repository does not
 * already contain -- the Kamailio default DB password appears 30 times in
 * `backend/src` already, and every address appears in several files.
 */
const GOLDEN_DIR = path.join(__dirname, 'golden', 'ims');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

const IMS_DOMAIN = 'ims.mnc001.mcc001.3gppnetwork.org';
const EPC_DOMAIN = 'epc.mnc001.mcc001.3gppnetwork.org';

// Every generated IMS file, with the real parameters that produced the live
// copy. Adding a generator here is the cheapest way to extend this coverage.
const CASES: ReadonlyArray<readonly [string, () => string]> = [
  ['scscf.cfg', (): string => scscfIncludeCfg({
    scscfIp: '127.0.1.2', scscfPort: 6060, mcc: '001', mnc: '01', imsDomain: IMS_DOMAIN, additionalDomains: [],
    routeSmsToVectorcore: { ip: '127.0.1.5', port: 5060 },
    voiceCharging: { ocsOriginHost: `ocs.${EPC_DOMAIN}` },
    cdrAccounting: true, sipTracing: true,
  })],
  ['icscf.cfg', (): string => icscfIncludeCfg({
    icscfIp: '127.0.1.1', icscfPort: 4060, imsDomain: IMS_DOMAIN,
    additionalDomains: [], sipTracing: true,
  })],
  ['smsc.cfg', (): string => smscIncludeCfg({ smscIp: '10.0.1.178', imsDomain: IMS_DOMAIN })],
  ['pcscf.cfg', (): string => pcscfIncludeCfg({
    pcscfIp: '10.0.1.178', pcscfPort: 5060, imsDomain: IMS_DOMAIN, epcDomain: EPC_DOMAIN,
    additionalDomains: [], http2N5Available: true, sipTracing: true,
  })],
  ['icscf.xml', (): string => icscfDiameterXml({ icscfIp: '127.0.1.1', imsDomain: IMS_DOMAIN })],
  ['scscf.xml', (): string => scscfDiameterXml({
    scscfIp: '127.0.1.2', imsDomain: IMS_DOMAIN,
    ocsPeer: { fqdn: `ocs.${EPC_DOMAIN}`, port: 3868 },
  })],
  ['pcscf.xml', (): string => pcscfDiameterXml({
    pcscfIp: '10.0.1.178', imsDomain: IMS_DOMAIN,
    pcrfFqdn: `pcrf.${EPC_DOMAIN}`, pcrfPort: 3868,
  })],
];

describe('generated IMS config files match the known-good host output', () => {
  test.each(CASES.map(([n]) => n))('%s is byte-identical to its golden master', (name) => {
    const gen = CASES.find(([n]) => n === name)![1]();
    const file = path.join(GOLDEN_DIR, name);
    if (UPDATE) { fs.writeFileSync(file, gen); return; }
    expect(fs.existsSync(file)).toBe(true);
    // Compared as text so a failure prints a line diff rather than a length.
    expect(gen).toBe(fs.readFileSync(file, 'utf-8'));
  });

  test('every golden file has a case, so none is silently orphaned', () => {
    const onDisk = fs.readdirSync(GOLDEN_DIR).sort();
    expect(onDisk).toEqual(CASES.map(([n]) => n).sort());
  });
});

/**
 * The flag-coupling tests below exist for a specific, recorded failure mode.
 *
 * SIX call sites regenerate `scscf.cfg` through `scscfIncludeCfg()`, and every
 * feature flag in its parameter object is OPTIONAL (`cdrAccounting?`,
 * `sipTracing?`, ...). So a setter that forgets to pass one does not fail --
 * it silently regenerates the file with that feature OFF. One toggle turning
 * another feature off is precisely the "I changed something in IMS and
 * something else broke" symptom, and it has happened: `sipTracingEnabled` was
 * written into the generated config but omitted from the persisted state, so
 * the next setter to run read it back as absent.
 *
 * The existing `*-wiring.test.ts` files each check one setting in isolation,
 * which is why that slipped through -- no test asserted two features ON at the
 * same time. These do.
 */
describe('scscf.cfg flag coupling: one feature must not disable another', () => {
  const base = { scscfIp: '127.0.1.2', scscfPort: 6060, imsDomain: IMS_DOMAIN, mcc: '001', mnc: '01' };
  const VECTORCORE = { ip: '127.0.1.5', port: 5060 };
  const RO = { ocsOriginHost: `ocs.${EPC_DOMAIN}` };

  // Each flag and the define that proves it reached the file.
  const MARKERS = {
    blockImsSms: '#!define BLOCK_IMS_SMS',
    routeSmsToVectorcore: '#!define ROUTE_SMS_TO_VECTORCORE',
    voiceCharging: '#!define WITH_RO',
    cdrAccounting: '#!define WITH_CDR',
    sipTracing: '#!define CAPTURE_TRACE_ON',
  } as const;

  test('all four live features on together produce all four defines', () => {
    const cfg = scscfIncludeCfg({
      ...base, routeSmsToVectorcore: VECTORCORE, voiceCharging: RO,
      cdrAccounting: true, sipTracing: true,
    });
    for (const k of ['routeSmsToVectorcore', 'voiceCharging', 'cdrAccounting', 'sipTracing'] as const) {
      expect(cfg).toContain(MARKERS[k]);
    }
    // BLOCK_IMS_SMS is mutually exclusive with VectorCore routing by
    // construction, so it must be absent in this combination.
    expect(cfg).not.toContain(MARKERS.blockImsSms);
  });

  // The real regression shape: turn each feature on ALONE and confirm the
  // others are absent, then on TOGETHER and confirm none is lost. A generator
  // that mishandles one flag fails one of these rather than going unnoticed.
  test.each([
    ['cdrAccounting', { cdrAccounting: true }, 'cdrAccounting'],
    ['sipTracing', { sipTracing: true }, 'sipTracing'],
    ['voiceCharging', { voiceCharging: RO }, 'voiceCharging'],
    ['routeSmsToVectorcore', { routeSmsToVectorcore: VECTORCORE }, 'routeSmsToVectorcore'],
    ['blockImsSms', { blockImsSms: true }, 'blockImsSms'],
  ] as ReadonlyArray<readonly [string, Record<string, unknown>, keyof typeof MARKERS]>)(
    '%s alone sets only its own define',
    (_label, only, key) => {
      const cfg = scscfIncludeCfg({ ...base, ...only });
      expect(cfg).toContain(MARKERS[key]);
      for (const [k, marker] of Object.entries(MARKERS)) {
        if (k !== key) expect(cfg).not.toContain(marker);
      }
    },
  );

  test('no flags set produces none of the defines', () => {
    const cfg = scscfIncludeCfg(base);
    for (const marker of Object.values(MARKERS)) expect(cfg).not.toContain(marker);
  });

  // Adding a flag must not be able to remove an unrelated one. Built by
  // accumulation so the assertion is "everything switched on so far is still
  // on", which is the property the six call sites keep breaking.
  test('flags accumulate without dropping the ones already set', () => {
    const steps: ReadonlyArray<readonly [Record<string, unknown>, keyof typeof MARKERS]> = [
      [{ cdrAccounting: true }, 'cdrAccounting'],
      [{ sipTracing: true }, 'sipTracing'],
      [{ voiceCharging: RO }, 'voiceCharging'],
      [{ routeSmsToVectorcore: VECTORCORE }, 'routeSmsToVectorcore'],
    ];
    let params: ScscfIncludeParams = { ...base };
    const expected: string[] = [];
    for (const [add, key] of steps) {
      params = { ...params, ...add };
      expected.push(MARKERS[key]);
      const cfg = scscfIncludeCfg(params);
      for (const marker of expected) expect(cfg).toContain(marker);
    }
  });
});
