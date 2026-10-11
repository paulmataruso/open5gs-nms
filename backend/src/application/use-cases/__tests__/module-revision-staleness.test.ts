import * as fs from 'fs';
import * as path from 'path';
import { revisionStaleness } from '../../../domain/services/module-revision';

// Every optional module used to record getAppVersion() at install/configure
// time and report itself stale whenever the running app version differed. So
// cutting ANY release — a docs fix, an unrelated module's bug fix — put the
// "Updates available" prompt in front of the operator with nothing real to do.
// It was also too quiet in the other direction: editing a module's own config
// generator without bumping the app version left it claiming to be current.
//
// Staleness is now keyed on per-module install/config revisions, the way VoWiFi,
// SecGW and the Kamailio source build already did it — which is precisely why
// those three stayed correctly silent through the releases that made everything
// else shout.

const SRC = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');

describe('revisionStaleness semantics', () => {
  it('matching revisions are not stale', () => {
    expect(revisionStaleness({
      installed: true, hasSavedConfig: true,
      installedWithRev: 1, configuredWithRev: 1,
      expectedInstallRev: 1, expectedConfigRev: 1,
    })).toEqual({ installStale: false, configStale: false });
  });

  it('a bumped revision is stale', () => {
    expect(revisionStaleness({
      installed: true, hasSavedConfig: true,
      installedWithRev: 1, configuredWithRev: 1,
      expectedInstallRev: 2, expectedConfigRev: 2,
    })).toEqual({ installStale: true, configStale: true });
  });

  it('an unrecorded revision counts as stale — we genuinely do not know', () => {
    expect(revisionStaleness({
      installed: true, hasSavedConfig: true,
      installedWithRev: undefined, configuredWithRev: null,
      expectedInstallRev: 1, expectedConfigRev: 1,
    })).toEqual({ installStale: true, configStale: true });
  });

  it('a module that is not installed is not stale, it is absent', () => {
    expect(revisionStaleness({
      installed: false, hasSavedConfig: false,
      expectedInstallRev: 1, expectedConfigRev: 1,
    })).toEqual({ installStale: false, configStale: false });
  });

  it('never-configured is not config-stale — there is nothing to bring up to date', () => {
    const r = revisionStaleness({
      installed: true, hasSavedConfig: false,
      installedWithRev: 1, configuredWithRev: undefined,
      expectedInstallRev: 1, expectedConfigRev: 1,
    });
    expect(r.configStale).toBe(false);
  });
});

describe('no module decides staleness from the app version any more', () => {
  const CONTROLLERS = [
    'interfaces/rest/ims-controller.ts',
    'interfaces/rest/mms-controller.ts',
    'interfaces/rest/vectorcore-smsc-controller.ts',
    'interfaces/rest/pstn-controller.ts',
    'interfaces/rest/twamp-controller.ts',
    'interfaces/rest/asterisk-2g-controller.ts',
  ];

  it.each(CONTROLLERS)('%s compares revisions, not getAppVersion()', (rel) => {
    const src = read(rel);
    // The old shape, in either spelling.
    expect(src).not.toMatch(/!==\s*appVersion/);
    expect(src).not.toMatch(/!==\s*getAppVersion\(\)/);
  });

  it.each(CONTROLLERS)('%s still reports the app version for display', (rel) => {
    // Keeping "configured by 0.64" visible is useful; it just must not decide.
    expect(read(rel)).toMatch(/WithVersion/);
  });

  it('every converted module declares its own revision constants', () => {
    const expected: Array<[string, string[]]> = [
      ['interfaces/rest/ims-controller.ts', ['IMS_INSTALL_REV', 'IMS_CONFIG_REV']],
      ['interfaces/rest/mms-controller.ts', ['MMS_INSTALL_REV', 'MMS_CONFIG_REV']],
      ['interfaces/rest/vectorcore-smsc-controller.ts', ['VECTORCORE_SMSC_INSTALL_REV', 'VECTORCORE_SMSC_CONFIG_REV']],
      ['interfaces/rest/pstn-controller.ts', ['PSTN_CONFIG_REV']],
      ['interfaces/rest/twamp-controller.ts', ['TWAMP_INSTALL_REV', 'TWAMP_CONFIG_REV']],
      ['interfaces/rest/asterisk-2g-controller.ts', ['ASTERISK_2G_CONFIG_REV']],
    ];
    for (const [rel, consts] of expected) {
      const src = read(rel);
      for (const c of consts) expect(src).toMatch(new RegExp(`export const ${c} = \\d+;`));
    }
  });

  it('each module records its revision when it installs or configures', () => {
    // A constant nobody writes into state would make everything permanently
    // stale — the failure mode opposite to the one being fixed.
    const pairs: Array<[string, RegExp]> = [
      ['interfaces/rest/ims-controller.ts', /configuredWithRev = IMS_CONFIG_REV/],
      ['interfaces/rest/ims-controller.ts', /installedWithRev: IMS_INSTALL_REV/],
      ['interfaces/rest/mms-controller.ts', /installedWithRev: MMS_INSTALL_REV/],
      ['interfaces/rest/mms-controller.ts', /configuredWithRev: MMS_CONFIG_REV/],
      ['interfaces/rest/vectorcore-smsc-controller.ts', /installedWithRev: VECTORCORE_SMSC_INSTALL_REV/],
      ['interfaces/rest/vectorcore-smsc-controller.ts', /configuredWithRev: VECTORCORE_SMSC_CONFIG_REV/],
      ['interfaces/rest/pstn-controller.ts', /configuredWithRev: PSTN_CONFIG_REV/],
      ['interfaces/rest/twamp-controller.ts', /installedWithRev: TWAMP_INSTALL_REV/],
      ['interfaces/rest/twamp-controller.ts', /configuredWithRev: TWAMP_CONFIG_REV/],
      ['interfaces/rest/asterisk-2g-controller.ts', /configuredWithRev: ASTERISK_2G_CONFIG_REV/],
    ];
    for (const [rel, re] of pairs) expect(read(rel)).toMatch(re);
  });

  it('IMS keeps its stronger content check alongside the revision', () => {
    // A revision says "the generator changed"; the content check says "what is
    // on disk differs". Both are needed — see module-revision.ts's header.
    const src = read('interfaces/rest/ims-controller.ts');
    expect(src).toMatch(/checkImsTemplateStaleness/);
    expect(src).toMatch(/staleTemplates/);
  });
});
