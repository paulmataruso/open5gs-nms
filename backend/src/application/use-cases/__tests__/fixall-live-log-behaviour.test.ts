// Behavioural counterpart to fixall-live-log.test.ts: drives the real
// ModuleFixAllUseCase and asserts the status snapshot exposes a module's log
// WHILE that module is still running. Before the fix this returned an empty
// results array for the whole run.
//
// The Kamailio fixer is the one stubbed, because it is the longest and quietest
// real step — the one that made the box look hung — and it has a small,
// mockable surface.
const buildState: { status: string; currentStepLabel: string; error: string | null } = {
  status: 'preparing', currentStepLabel: 'preparing', error: null,
};
let patchRev: number | null = null;

jest.mock('../../../interfaces/rest/kamailio-source-build-controller', () => ({
  getKamailioSourceBuildStaleness: () => ({
    installed: true,
    buildStale: patchRev !== 2,
    builtWithPatchRev: patchRev,
    expectedPatchRev: 2,
  }),
  startKamailioRebuildForFixAll: () => { buildState.status = 'building'; buildState.currentStepLabel = 'compiling'; },
  loadKamailioBuildState: () => buildState,
  isKamailioSourceBuildComplete: () => true,
  KAMAILIO_APT_PKGS: [],
}));

import { ModuleFixAllUseCase } from '../module-fixall-usecase';

const noopLogger: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const noopAudit: any = { log: async () => {} };

describe('Fix All exposes a running module\'s log mid-flight', () => {
  it('shows the in-progress module and its output before the run finishes', async () => {
    const uc = new ModuleFixAllUseCase({} as any, {} as any, 'mongodb://x/y', noopLogger, noopAudit);

    // Only kamailio is stale, so the run is exactly the one long step.
    jest.spyOn(uc, 'getStaleStatus').mockResolvedValue([{
      moduleId: 'kamailio', label: 'Kamailio (IMS core modules)',
      installStale: true, configStale: false, canAutoFix: true,
    } as any]);

    const started = uc.startFixAll('tester');
    expect(started).toEqual({ started: true });

    // Poll the way the UI does, while the build is still "running".
    let sawLiveLog = false;
    let sawCurrentModule = false;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 100));
      const st = uc.getRunState();
      if (st.status !== 'running') break;
      if (st.currentModule === 'kamailio') sawCurrentModule = true;
      const km = st.results.find((r: any) => r.moduleId === 'kamailio');
      if (km && km.log.some((l: string) => /Kamailio rebuild started/.test(l))) {
        sawLiveLog = true;
        // This is the whole point: output is visible while status is still running.
        expect(st.status).toBe('running');
        break;
      }
    }

    expect(sawCurrentModule).toBe(true);
    expect(sawLiveLog).toBe(true);

    // Let the stubbed build finish so the run terminates cleanly.
    patchRev = 2;
    buildState.status = 'complete';
    buildState.currentStepLabel = 'Complete';
    for (let i = 0; i < 100 && uc.getRunState().status === 'running'; i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    const final = uc.getRunState();
    expect(final.status).toBe('complete');
    const km = final.results.find((r: any) => r.moduleId === 'kamailio')!;
    expect(km.installSuccess).toBe(true);
    expect(km.log.join('\n')).toContain('Kamailio rebuild complete');
  }, 30000);
});
