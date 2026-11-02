import * as fs from 'fs';
import * as path from 'path';

// Guards the fix for a real, reported bug: the Radio Provisioning tab showed a
// radio's OLD address while GenieACS itself had the right one. Both halves are
// easy to reintroduce — the stale-preferring expression reads as a sensible
// fallback, and the Sercomm projection reads as complete.

const REPO = path.resolve(__dirname, '../../../../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf-8');

const GENIE = read('backend/src/interfaces/rest/genieacs-controller.ts');
const NR    = read('backend/src/interfaces/rest/sercomm-nr-controller.ts');
const FEMTO = read('frontend/src/components/autoconfig/FemtoConfigTab.tsx');
const BAI   = read('frontend/src/components/autoconfig/BaicellsAcsTab.tsx');
const TYPES = read('frontend/src/api/genieacs.ts');
const TW    = read('frontend/tailwind.config.js');

describe('ACS device IP resolution — wiring', () => {
  test('neither radio list resolves the IP by hand any more', () => {
    // The exact shape of the bug: prefer the cached interface address, fall
    // back to ConnectionRequestURL only when it is ABSENT.
    expect(GENIE).not.toMatch(/!directIp && crUrl/);
    // And no call site reads the cached parameter straight into an `ip` field.
    expect(GENIE).not.toMatch(/ip:\s*getParam\([^)]*IPv4Address/);
    const uses = GENIE.match(/resolveAcsDeviceIp\(/g) ?? [];
    expect(uses.length).toBe(2); // Baicells toRadio() + the Sercomm 4G list
  });

  test('the Sercomm projection fetches ConnectionRequestURL, not only the cached address', () => {
    // Without it in the MongoDB-style field whitelist, GenieACS strips the
    // parameter before the resolver can see it — the tab then has no way to
    // notice its own staleness. Same class of bug as the neighbour-table
    // projection gap already recorded in this file.
    const sercommBlock = GENIE.slice(
      GENIE.indexOf("router.get('/devices/sercomm'"),
      GENIE.indexOf("router.post('/preview-sercomm/"),
    );
    expect(sercommBlock).toMatch(/ACS_DEVICE_IP_PARAM/);
    expect(sercommBlock).toMatch(/ACS_CONNECTION_REQUEST_PARAM/);
  });

  test('both projections carry both parameters', () => {
    for (const param of ['ACS_DEVICE_IP_PARAM', 'ACS_CONNECTION_REQUEST_PARAM']) {
      expect((GENIE.match(new RegExp(param, 'g')) ?? []).length).toBeGreaterThanOrEqual(2);
    }
    expect(GENIE).toMatch(/'Device\.ManagementServer\.ConnectionRequestURL'/); // Baicells list
  });

  test('the Sercomm NR tab keeps using the live URL host', () => {
    // It was already right, and is the precedent the other two now follow.
    expect(NR).toMatch(/ConnectionRequestURL/);
  });

  test('a disagreement is explained in the UI rather than silently resolved', () => {
    for (const [name, src] of [['FemtoConfigTab', FEMTO], ['BaicellsAcsTab', BAI]] as const) {
      expect(src).toMatch(/ipStaleAlternative/);
      expect(src).toMatch(/AlertTriangle/);
      // The marker is an icon, so it needs a real accessible name.
      expect(src).toMatch(/aria-label=\{`GenieACS also holds an older address/);
      expect(name).toBeTruthy();
    }
    expect(TYPES).toMatch(/ipStaleAlternative\?:/);
    expect(TYPES).toMatch(/ipSource\?:/);
  });

  // ── RF On no longer reports success it has not checked ────────────────────

  test('the Sercomm RF route assesses the precondition instead of trusting the task', () => {
    // "GenieACS accepted the task" is not "the radio is transmitting": with SAS
    // enabled and no grant the firmware reverts AdminState minutes later, which
    // is how this was found. CLAUDE.md: verify, don't trust "success".
    const rfBlock = GENIE.slice(
      GENIE.indexOf("router.post('/rf-sercomm/:deviceId'"),
      GENIE.indexOf("router.post('/rf-sercomm-all'"),
    );
    expect(rfBlock).toMatch(/assessSercommRf\(/);
    expect(rfBlock).toMatch(/precondition: pre/);
    // The unconditional claim it replaced.
    expect(rfBlock).not.toMatch(/res\.json\(\{ success: true, message: `RF \$\{enable/);
  });

  test('assessing the precondition can never turn a queued write into a failure', () => {
    // A radio that will not answer a connection request still had its write
    // queued, so the assessment is advisory and must swallow its own errors.
    const helper = GENIE.slice(
      GENIE.indexOf('async function assessSercommRf('),
      GENIE.indexOf('// Refreshes the Baicells'),
    );
    expect(helper).toMatch(/catch \{\s*return null;\s*\}/);
    expect(helper).toMatch(/Promise<SercommRfPrecondition \| null>/);
    // 202 means queued, not delivered — still worth reporting the cache.
    expect(helper).toMatch(/gpv\.status !== 202/);
  });

  test('the UI reports a blocked precondition rather than a success toast', () => {
    expect(FEMTO).toMatch(/r\.precondition\?\.blocked/);
    expect(FEMTO).toMatch(/toast\.error\(/);
    // A null precondition means "could not re-read", which must not be
    // rendered as blocked OR silently as fine without the normal path.
    expect(FEMTO).toMatch(/toast\.success\(`\$\{radio\.serial\}: RF/);
  });

  test('the staleness marker uses a theme token that actually exists', () => {
    // Tailwind silently generates nothing for an undefined custom colour, so
    // the icon would render unstyled with no error anywhere.
    for (const src of [FEMTO, BAI]) {
      const tokens = [...src.matchAll(/text-(nms-[a-z-]+)"/g)].map(m => m[1]);
      expect(tokens).toContain('nms-amber');
    }
    expect(TW).toMatch(/'nms-amber':/);
  });
});
