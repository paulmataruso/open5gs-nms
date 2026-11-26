import * as fs from 'fs';
import { inferConfig } from '../validation-controller';

// fs's exports are non-configurable on Node 20, so jest.spyOn cannot redefine
// readFileSync -- the module has to be mocked at require time, keeping every
// other fs function real (validation-controller touches the filesystem at
// module load).
jest.mock('fs', () => {
  const real = jest.requireActual<typeof import('fs')>('fs');
  return { ...real, readFileSync: jest.fn() };
});

/**
 * inferConfig() reads the live amf/mme/smf/upf YAML to build the simulated
 * RAN's config. It used to recover mcc/mnc by padding the PARSED number
 * (`padStart(3)` / `padStart(2)`), which cannot reconstruct a width: a real
 * 3-digit MNC with a leading zero (`mnc: 070`) parses to 70 and pads back to
 * "70" -- a different network. This deployment itself ran MNC 070 before
 * migrating to 001/01, so the case is real rather than hypothetical.
 *
 * It now shares the repository's raw-text recovery
 * (restoreMccMncSdFromRawYaml), which is the only source that still holds the
 * original digits.
 */
describe('inferConfig PLMN width', () => {
  const files: Record<string, string> = {};
  const readFileSync = fs.readFileSync as unknown as jest.Mock;
  /** When true every read throws, for the "nothing readable" case. */
  let allMissing = false;

  beforeEach(() => {
    // A file a fixture does not define returns EMPTY rather than throwing:
    // an empty document yields the same "section absent" result, without
    // readYaml's (correct) warning writing ~35 JSON log lines per test into
    // the CI output. Only the explicit allMissing case exercises the throw.
    readFileSync.mockImplementation((p: unknown): string => {
      if (allMissing) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const name = String(p).split('/').pop() ?? '';
      return files[name] ?? '';
    });
  });
  afterEach(() => {
    readFileSync.mockReset();
    allMissing = false;
    for (const k of Object.keys(files)) delete files[k];
  });

  it('keeps a 3-digit MNC with a leading zero intact', () => {
    files['amf.yaml'] = [
      'amf:',
      '  plmn_support:',
      '    - plmn_id:',
      '        mcc: 001',
      '        mnc: 070',
      '      s_nssai:',
      '        - sst: 1',
    ].join('\n') + '\n';

    const cfg = inferConfig();
    expect(cfg.plmn.mcc).toBe('001');
    // The whole point: padding the parsed 70 would have produced '70'.
    expect(cfg.plmn.mnc).toBe('070');
  });

  it('keeps a 2-digit MNC with a leading zero intact', () => {
    files['amf.yaml'] = [
      'amf:',
      '  plmn_support:',
      '    - plmn_id:',
      '        mcc: 001',
      '        mnc: 01',
      '      s_nssai:',
      '        - sst: 1',
    ].join('\n') + '\n';

    const cfg = inferConfig();
    expect(cfg.plmn.mcc).toBe('001');
    expect(cfg.plmn.mnc).toBe('01');
  });

  it('leaves a PLMN with no leading zeros alone', () => {
    files['amf.yaml'] = [
      'amf:',
      '  plmn_support:',
      '    - plmn_id:',
      '        mcc: 310',
      '        mnc: 260',
      '      s_nssai:',
      '        - sst: 1',
    ].join('\n') + '\n';

    const cfg = inferConfig();
    expect(cfg.plmn.mcc).toBe('310');
    expect(cfg.plmn.mnc).toBe('260');
  });

  it('still pads a file that genuinely holds a bare single-digit mcc', () => {
    // srsenb rejects anything that is not a 3-digit MCC, so the width floor
    // stays as a backstop for a malformed file.
    files['amf.yaml'] = [
      'amf:',
      '  plmn_support:',
      '    - plmn_id:',
      '        mcc: 1',
      '        mnc: 1',
      '      s_nssai:',
      '        - sst: 1',
    ].join('\n') + '\n';

    const cfg = inferConfig();
    expect(cfg.plmn.mcc).toBe('001');
    expect(cfg.plmn.mnc).toBe('01');
  });

  it('keeps a quoted PLMN intact', () => {
    files['amf.yaml'] = [
      'amf:',
      '  plmn_support:',
      '    - plmn_id:',
      "        mcc: '001'",
      "        mnc: '070'",
      '      s_nssai:',
      '        - sst: 1',
    ].join('\n') + '\n';

    const cfg = inferConfig();
    expect(cfg.plmn.mcc).toBe('001');
    expect(cfg.plmn.mnc).toBe('070');
  });

  it('falls back to its defaults when no file can be read', () => {
    allMissing = true;
    const cfg = inferConfig();
    expect(cfg.plmn).toEqual({ mcc: '999', mnc: '70' });
  });
});
