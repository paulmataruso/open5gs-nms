import { readFileSync } from 'fs';
import { join } from 'path';
import { PlmnMigrationUseCase } from '../plmn-migration-usecase';
import type { AllConfigs } from '../../../domain/interfaces/config-repository';

/**
 * Phase E must verify every PLMN-bearing list Phase A rewrites.
 *
 * It did not. Phase A rewrites six -- mme.gummei, mme.tai, amf.guami, amf.tai,
 * amf.plmn_support, nrf.serving -- plus smf.info[].tai, and Phase E checked
 * three. A stale `amf.guami` has AMF handing out 5G-GUTIs under the OLD PLMN
 * and a stale `mme.tai` has MME broadcasting the old TAI, while the wizard
 * reported the migration consistent. For a tool whose only job is to say
 * whether the migration finished, that is the worst failure mode available.
 *
 * MME's check also used `.every` on a possibly-empty array, which is vacuously
 * true, so a MISSING gummei reported OK -- while AMF and NRF required
 * `length > 0`. The rule is now uniform and stated per list.
 *
 * The first test below reads the source rather than the behaviour, deliberately:
 * the invariant is "verify covers apply", and the only way to pin that is to
 * compare the two sets of paths. Same technique as the frontend-mirror drift
 * test.
 */
const SRC = readFileSync(
  join(__dirname, '..', 'plmn-migration-usecase.ts'),
  'utf-8',
);

function makeUseCase(): PlmnMigrationUseCase {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return new PlmnMigrationUseCase(
    {} as never, {} as never, {} as never, logger as never, {} as never,
  );
}

const lists = (configs: AllConfigs): Array<{ label: string; present: boolean; required: boolean; entries: unknown[] }> =>
  (makeUseCase() as unknown as {
    plmnBearingLists(c: AllConfigs): Array<{ label: string; present: boolean; required: boolean; entries: unknown[] }>;
  }).plmnBearingLists(configs);

describe('Phase E covers every path Phase A rewrites', () => {
  it('declares a check for each replacePlmnId target and the smf tai loop', () => {
    // Every `x.y.z = this.replacePlmnId(...)` assignment in applyPhaseA.
    const targets = [...SRC.matchAll(/(\w+)Raw\.(\w+)\.(\w+)\s*=\s*this\.replacePlmnId\(/g)]
      .map(m => `${m[2]}.${m[3]}`);
    expect(targets.length).toBeGreaterThanOrEqual(6);

    const declared = lists({
      mme: { rawYaml: {} }, amf: { rawYaml: {} }, smf: { rawYaml: {} }, nrf: { rawYaml: {} },
    } as unknown as AllConfigs).map(l => l.label).join(' | ');

    for (const t of targets) {
      const [nf, field] = t.split('.');
      // e.g. "mme.gummei" must appear as "mme.yaml gummei ..."
      expect(declared).toMatch(new RegExp(`${nf}\\.yaml ${field}\\b`));
    }
  });

  it('covers the smf info[].tai loop, which is not a replacePlmnId call', () => {
    const declared = lists({ smf: { rawYaml: {} } } as unknown as AllConfigs).map(l => l.label);
    expect(declared.some(l => l.includes('smf.yaml info[].tai'))).toBe(true);
  });
});

describe('empty-list semantics are uniform and explicit', () => {
  const allPresent = {
    mme: { rawYaml: {} }, amf: { rawYaml: {} }, smf: { rawYaml: {} }, nrf: { rawYaml: {} },
  } as unknown as AllConfigs;

  it('treats every identity list as required, so a MISSING one cannot read as OK', () => {
    const required = lists(allPresent).filter(l => l.required).map(l => l.label);
    expect(required).toEqual([
      'mme.yaml gummei plmn_id',
      'mme.yaml tai plmn_id',
      'amf.yaml guami plmn_id',
      'amf.yaml tai plmn_id',
      'amf.yaml plmn_support plmn_id',
      'nrf.yaml serving plmn_id',
    ]);
  });

  it('treats smf info[].tai as optional, since it only exists with per-TAI slices', () => {
    const smfList = lists(allPresent).find(l => l.label.includes('smf.yaml info[].tai'));
    expect(smfList!.required).toBe(false);
  });

  it('marks an absent NF as not present rather than failing it, for a 5G-only core', () => {
    const only5g = { amf: { rawYaml: {} }, nrf: { rawYaml: {} } } as unknown as AllConfigs;
    const mme = lists(only5g).filter(l => l.label.startsWith('mme.'));
    expect(mme.every(l => l.present === false)).toBe(true);
    expect(lists(only5g).find(l => l.label.startsWith('amf.yaml guami'))!.present).toBe(true);
  });

  it('flattens smf info[].tai across every info entry', () => {
    const configs = {
      smf: { rawYaml: { smf: { info: [
        { tai: [{ plmn_id: { mcc: '001', mnc: '01' } }] },
        { tai: [{ plmn_id: { mcc: '001', mnc: '01' } }, { plmn_id: { mcc: '001', mnc: '01' } }] },
      ] } } },
    } as unknown as AllConfigs;
    expect(lists(configs).find(l => l.label.includes('info[].tai'))!.entries).toHaveLength(3);
  });

  it('reads the real entries from each list', () => {
    const configs = {
      mme: { rawYaml: { mme: {
        gummei: [{ plmn_id: { mcc: '001', mnc: '01' } }],
        tai: [{ plmn_id: { mcc: '001', mnc: '01' } }],
      } } },
      amf: { rawYaml: { amf: {
        guami: [{ plmn_id: { mcc: '001', mnc: '01' } }],
        tai: [{ plmn_id: { mcc: '001', mnc: '01' } }],
        plmn_support: [{ plmn_id: { mcc: '001', mnc: '01' } }],
      } } },
      nrf: { rawYaml: { nrf: { serving: [{ plmn_id: { mcc: '001', mnc: '01' } }] } } },
    } as unknown as AllConfigs;
    for (const l of lists(configs).filter(x => x.required)) {
      expect(l.entries).toHaveLength(1);
    }
  });
});
