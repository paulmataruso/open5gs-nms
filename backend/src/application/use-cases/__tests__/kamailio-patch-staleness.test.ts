import * as fs from 'fs';
import * as path from 'path';

// The cdp process-slot patch was lost once and was unrecoverable from the GUI:
// IMS Install deliberately skips its own cdp step when a source build is active
// (patching from apt 5.8.8 source would drop an ABI-incompatible module over
// the 6.0.8 one), and the 6.0.8 pipeline that owns the patches is never re-run
// automatically. So a build missing a patch stayed missing it, with no way for
// an operator to see or fix it without a shell.
//
// These guard the three things that close that loop: the patch set has a
// recorded revision, a successful build stamps it, and Fix All offers the
// rebuild — but ONLY when the deployed build actually predates the set.

const SRC = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');

describe('Kamailio patch-set staleness', () => {
  // The exact patch set the 6.0.8 pipeline applies, as of KAMAILIO_PATCH_REV 2.
  // Asserting the SET rather than a count: a patch could be swapped one-for-one
  // and a count would not notice. If you change this list you must bump
  // KAMAILIO_PATCH_REV, or every existing deployment will keep reporting itself
  // current while missing the new patch — which is the exact bug this guards.
  const EXPECTED_PATCHES = [
    'CCR_C_PATCH',
    'CDP_ACCTSM_C_PATCH',
    'CDP_COMMON_C_PATCH',
    'CDP_MOD_C_PATCH',
    'CMD_C_PATCH_KAMAILIO6',
    'IMS_RO_C_PATCH',
    'SAVE_C_PATCH',
    'SECVERIFY_C_PATCH',
  ];

  it('applies exactly the patch set the current revision claims', () => {
    const mods = read('application/use-cases/kamailio-ims-modules-build.ts');
    const pipeline = read('application/use-cases/kamailio-source-build.ts');

    expect(mods).toMatch(/export const KAMAILIO_PATCH_REV = 2;/);

    // Note the pattern: CMD_C_PATCH_KAMAILIO6 does NOT end in `_PATCH`, so a
    // naive /_PATCH\}/ match silently misses it and undercounts by one.
    const applied = [...new Set(
      [...pipeline.matchAll(/\$\{([A-Z0-9_]*PATCH[A-Z0-9_]*)\}/g)].map(m => m[1]),
    )].sort();
    expect(applied).toEqual([...EXPECTED_PATCHES].sort());

    // And each one must actually be defined, not just interpolated.
    for (const p of applied) expect(mods).toContain(`export const ${p} =`);
  });

  it('only a SUCCESSFUL build stamps the revision', () => {
    const ctl = read('interfaces/rest/kamailio-source-build-controller.ts');
    // A failed build must stay stale so it keeps being offered as fixable.
    expect(ctl).toMatch(/if \(allActive\) s\.builtWithPatchRev = KAMAILIO_PATCH_REV;/);
  });

  it('a build predating the tracking field is treated as stale', () => {
    const ctl = read('interfaces/rest/kamailio-source-build-controller.ts');
    expect(ctl).toMatch(/builtWithPatchRev = state\.builtWithPatchRev \?\? null/);
    expect(ctl).toMatch(/buildStale: installed && builtWithPatchRev !== KAMAILIO_PATCH_REV/);
  });

  it('Fix All offers the rebuild, and marks it auto-fixable', () => {
    const fx = read('application/use-cases/module-fixall-usecase.ts');
    expect(fx).toMatch(/export type ModuleId = 'kamailio'/);
    expect(fx).toMatch(/this\.getKamailioStatus\(\),/);
    expect(fx).toMatch(/case 'kamailio': \{/);
    // canAutoFix must be true — the operator is not expected to use a shell.
    const status = fx.slice(fx.indexOf('private getKamailioStatus()'), fx.indexOf('private async getImsStatus()'));
    expect(status).toMatch(/canAutoFix: true/);
  });

  it('the rebuild only runs when the build is genuinely stale', () => {
    // This is what keeps a ~9-minute all-services-restart off a healthy
    // deployment: no staleness, no entry in the list, no rebuild.
    const fx = read('application/use-cases/module-fixall-usecase.ts');
    const status = fx.slice(fx.indexOf('private getKamailioStatus()'), fx.indexOf('private async getImsStatus()'));
    expect(status).toMatch(/if \(!s\.installed \|\| !s\.buildStale\) return null;/);
  });

  it('kamailio is ordered before ims, so Configure re-enables N5 after the swap', () => {
    const fx = read('application/use-cases/module-fixall-usecase.ts');
    const order = fx.match(/const MODULE_ORDER: ModuleId\[\] = \[([^\]]+)\]/)![1];
    const ids = order.split(',').map(x => x.trim().replace(/'/g, ''));
    expect(ids.indexOf('kamailio')).toBe(0);
    expect(ids.indexOf('kamailio')).toBeLessThan(ids.indexOf('ims'));
  });

  it('the rebuild re-checks staleness rather than trusting a "complete" status', () => {
    // The entire premise of this module is that a build can report success
    // while still missing a patch.
    const fx = read('application/use-cases/module-fixall-usecase.ts');
    expect(fx).toMatch(/if \(after\.buildStale\) \{/);
  });

  it('the frontend can render it', () => {
    const api = fs.readFileSync(path.resolve(SRC, '../../frontend/src/api/modules.ts'), 'utf-8');
    const modal = fs.readFileSync(path.resolve(SRC, '../../frontend/src/components/common/StaleModulesModal.tsx'), 'utf-8');
    expect(api).toMatch(/export type ModuleId = 'kamailio'/);
    // Missing from FEATURE_FLAG_BY_MODULE would silently filter it out of the modal.
    expect(modal).toMatch(/kamailio: FEATURES\.ims,/);
  });
});
