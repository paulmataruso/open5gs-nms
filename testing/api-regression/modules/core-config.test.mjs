// Core-17 NF config. GET /api/config/:service reads one NF; POST
// /api/config/apply writes ALL 17 at once and restarts the affected live
// NFs (SERVICE_RESTART_ORDER in apply-config.ts) — a real, live-traffic-
// affecting action, not a sandboxed write. That single case is marked
// `disruptive: true` and is skipped unless the suite is run with
// --include-disruptive. The read-only validate case is always safe to run.
import { assertOk, assertEqual, pass, fail } from '../lib/test-case.mjs';

export const MODULE = 'core-config';

const CORE_17 = [
  'nrf', 'scp', 'amf', 'smf', 'upf', 'ausf', 'udm', 'udr',
  'pcf', 'nssf', 'bsf', 'sepp1', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu',
];

export const CASES = [
  // POST /api/config/sync-sd is NOT exercised: it rewrites SMF's config AND
  // every subscriber's slice (SD/SST) assignment in one action — a real,
  // broad subscriber-data mutation with no safe, generic revert.
  { name: 'POST /api/config/sync-sd (not exercised)', async run() { return { status: 'skipped', detail: 'rewrites SMF config and every subscriber\'s slice assignment in one action, with no safe generic revert' }; } },

  {
    name: 'GET / (all 17 configs at once) and GET /topology/graph',
    async run({ client }) {
      const allRes = await client.get('/api/config/');
      assertOk(allRes, 'GET /api/config/');
      const topoRes = await client.get('/api/config/topology/graph');
      assertOk(topoRes, 'GET /api/config/topology/graph');
      return pass('bulk config read and topology graph both read successfully');
    },
  },
  {
    name: 'read all 17 core NF configs',
    async run({ client }) {
      const missing = [];
      for (const service of CORE_17) {
        const res = await client.get(`/api/config/${service}`);
        if (!res.ok || res.data?.success !== true) missing.push(service);
      }
      if (missing.length > 0) {
        return fail(`Could not read config for: ${missing.join(', ')}`);
      }
      return pass(`all ${CORE_17.length} core NF configs readable`);
    },
  },
  {
    name: 'validate current config (read-only)',
    async run({ client }) {
      const res = await client.post('/api/config/validate');
      assertOk(res, 'POST /api/config/validate');
      if (res.data?.success !== true) {
        return fail('validate endpoint returned success:false', res.data);
      }
      return pass(`valid=${res.data.data?.valid}, errors=${res.data.data?.errors?.length ?? 0}`);
    },
  },
  {
    // The one genuinely disruptive case in this module: edits AMF's
    // amf_name (a purely cosmetic label — never read for routing, PLMN
    // matching, or security, the lowest-risk field in the whole bundle)
    // via a real bulk Apply cycle, verifies it took, then reverts via a
    // second real bulk Apply with the pristine original bundle. Both
    // Applies restart whichever live NFs actually changed — on a
    // production host that means a brief AMF restart, twice.
    name: 'edit + revert amf_name via a full Apply cycle',
    disruptive: true,
    async run({ client, revertQueue }) {
      const originalBundle = {};
      for (const service of CORE_17) {
        const res = await client.get(`/api/config/${service}`);
        assertOk(res, `GET /api/config/${service}`);
        originalBundle[service] = res.data.data;
      }
      const originalAmfName = originalBundle.amf?.amf?.amf_name;
      if (!originalAmfName) {
        return fail('amf.amf.amf_name not found in the fetched AMF config — shape may have changed');
      }

      const testBundle = structuredClone(originalBundle);
      const testName = `${originalAmfName}-API-TEST`;
      testBundle.amf.amf.amf_name = testName;

      // Queue the revert BEFORE applying the test change — if the test
      // apply itself fails partway through, we still want to try putting
      // the original bundle back.
      revertQueue.push('revert amf_name to its original value via Apply', async () => {
        // Avoid a redundant third restart cycle if the in-test revert below
        // already succeeded — only re-apply if amf_name is still the test value.
        const current = await client.get('/api/config/amf');
        if (current.data?.data?.amf?.amf_name === testName) {
          await client.post('/api/config/apply', originalBundle);
        }
      });

      const applyRes = await client.post('/api/config/apply', testBundle);
      assertOk(applyRes, 'POST /api/config/apply (test value)');
      if (applyRes.data?.data?.success !== true) {
        return fail('Apply (test value) reported success:false', applyRes.data.data);
      }

      const readBack = await client.get('/api/config/amf');
      assertOk(readBack, 'GET /api/config/amf after apply');
      assertEqual(readBack.data?.data?.amf?.amf_name, testName, 'amf_name after test apply');

      // Revert now (not just at suite-end) so the window with a modified
      // amf_name on a live host is as short as possible.
      const revertRes = await client.post('/api/config/apply', originalBundle);
      assertOk(revertRes, 'POST /api/config/apply (revert)');
      const revertReadBack = await client.get('/api/config/amf');
      assertEqual(revertReadBack.data?.data?.amf?.amf_name, originalAmfName, 'amf_name after revert');

      return pass('amf_name changed, verified, and reverted via two real Apply cycles', {
        originalAmfName, testName,
      });
    },
  },
];
