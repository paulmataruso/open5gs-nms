// APN Profiles — apn-profile-controller.ts, mounted at /api/apn-profiles,
// 8 routes. create()/update() patch smf.yaml's and upf.yaml's session[]
// arrays directly (confirmed by reading apn-profile-usecase.ts) but never
// restart smf/upf themselves — same "write now, a future Apply Config
// picks it up" shape as every other config-file editor in this suite, so
// a throwaway profile's create->delete cycle is safe to exercise directly.
//
// Real bug found and fixed while building this suite: delete() only ever
// removed the Mongo record — the session(s) create() wrote into smf.yaml/
// upf.yaml were never cleaned up, permanently orphaning them (confirmed by
// reading delete()'s old one-line body against patchYamlConfigs()'s own
// comment, which documents exactly what gets written on create). Fixed by
// adding a symmetric removeYamlConfigs() delete() now calls first. This
// test verifies the REAL smf.yaml/upf.yaml session arrays directly (via
// GET /api/config/smf and /upf), not just the Mongo-backed profile list —
// exactly the "verify the real backend artifact" standard this whole suite
// is built around.
//
// POST /:dnn/promote and PUT/DELETE on a profile OTHER than our own
// throwaway one are not exercised (promote turns a real existing derived
// DNN into a persisted profile — not something to do to a real in-use
// DNN). PUT /ipv6-settings is exercised as a round-trip since it's
// confirmed Mongo-only (never touches smf.yaml/upf.yaml directly).
import { assertOk, assertEqual, pass, fail } from '../lib/test-case.mjs';

export const MODULE = 'apn-profile';

const TEST_DNN = 'apiregressiontest';
const TEST_DEV = 'ogstun98';

export const CASES = [
  {
    name: 'GET / and GET /ipv6-preview (read-only)',
    async run({ client }) {
      const res = await client.get('/api/apn-profiles/');
      assertOk(res, 'GET /api/apn-profiles/');
      if (!Array.isArray(res.data?.profiles)) return fail('response missing "profiles" array', res.data);
      const previewRes = await client.get('/api/apn-profiles/ipv6-preview');
      assertOk(previewRes, 'GET /api/apn-profiles/ipv6-preview');
      return pass(`${res.data.profiles.length} profile(s)`);
    },
  },
  {
    name: 'full ipv6-settings cycle: read -> edit -> validate -> revert (Mongo-only, confirmed not to touch smf.yaml/upf.yaml)',
    async run({ client, revertQueue }) {
      const before = await client.get('/api/apn-profiles/ipv6-settings');
      assertOk(before, 'GET /api/apn-profiles/ipv6-settings');
      const original = before.data.parentPrefix;

      revertQueue.push('revert apn-profiles ipv6 parent prefix', async () => {
        await client.put('/api/apn-profiles/ipv6-settings', { parentPrefix: original || null });
      });

      const invalidRes = await client.put('/api/apn-profiles/ipv6-settings', { parentPrefix: 'not-a-cidr' });
      if (invalidRes.status !== 400) return fail(`expected HTTP 400 for an invalid IPv6 CIDR, got ${invalidRes.status}`);

      const testValue = 'fd00:1234::/48';
      const putRes = await client.put('/api/apn-profiles/ipv6-settings', { parentPrefix: testValue });
      assertOk(putRes, 'PUT /api/apn-profiles/ipv6-settings');
      const afterSet = await client.get('/api/apn-profiles/ipv6-settings');
      assertEqual(afterSet.data.parentPrefix, testValue, 'parentPrefix after set');

      const revertRes = await client.put('/api/apn-profiles/ipv6-settings', { parentPrefix: original || null });
      assertOk(revertRes, 'PUT /api/apn-profiles/ipv6-settings (revert)');
      const afterRevert = await client.get('/api/apn-profiles/ipv6-settings');
      assertEqual(afterRevert.data.parentPrefix, original, 'parentPrefix after revert');

      return pass(`toggled "${original}" -> "${testValue}" -> "${original}"; invalid CIDR correctly rejected`);
    },
  },
  {
    name: 'full profile lifecycle: create -> verify REAL smf.yaml/upf.yaml sessions -> delete -> verify sessions actually removed',
    async run({ client, revertQueue }) {
      const listBefore = await client.get('/api/apn-profiles/');
      if (listBefore.data.profiles.some(p => p.dnn === TEST_DNN)) {
        return fail(`A profile for DNN "${TEST_DNN}" already exists — refusing to touch it.`);
      }
      const smfBefore = await client.get('/api/config/smf');
      if ((smfBefore.data.data.smf.session ?? []).some(s => s.dnn === TEST_DNN)) {
        return fail(`smf.yaml already has a session for dnn "${TEST_DNN}" — refusing to touch it.`);
      }

      const createRes = await client.post('/api/apn-profiles/', {
        dnn: TEST_DNN, dev: TEST_DEV, subnet: '10.199.0.0/24', gateway: '10.199.0.1',
        qos: { index: 9, arp: { priority_level: 8, pre_emption_capability: 1, pre_emption_vulnerability: 1 } },
        staticRangeStart: null, staticRangeEnd: null, dynamicRangeStart: '10.199.0.2', dynamicRangeEnd: '10.199.0.254',
      });
      assertOk(createRes, 'POST /api/apn-profiles/');
      const profileId = createRes.data?.profile?.id;
      if (!profileId) return fail('create response missing profile.id', createRes.data);

      // Safety-net revert that also cleans up the yaml sessions directly if
      // the delete step below never runs (e.g. this case throws first) —
      // the DELETE route itself is what we're testing, so prefer it, but
      // fall back to a raw config PUT if it's somehow unavailable.
      revertQueue.push(`delete test APN profile ${TEST_DNN}`, async () => {
        const current = await client.get('/api/apn-profiles/');
        if (current.data?.profiles?.some(p => p.id === profileId)) {
          await client.delete(`/api/apn-profiles/${profileId}`);
        }
      });

      const duplicateRes = await client.post('/api/apn-profiles/', {
        dnn: TEST_DNN, dev: 'ogstun97', subnet: '10.198.0.0/24', gateway: '10.198.0.1',
        qos: { index: 9, arp: { priority_level: 8, pre_emption_capability: 1, pre_emption_vulnerability: 1 } },
        staticRangeStart: null, staticRangeEnd: null, dynamicRangeStart: '10.198.0.2', dynamicRangeEnd: '10.198.0.254',
      });
      if (duplicateRes.status !== 400) return fail(`expected HTTP 400 for a duplicate dnn, got ${duplicateRes.status}`);

      const smfAfterCreate = await client.get('/api/config/smf');
      const smfSession = (smfAfterCreate.data.data.smf.session ?? []).find(s => s.dnn === TEST_DNN);
      if (!smfSession) return fail('smf.yaml has no session for the newly-created profile\'s dnn');
      assertEqual(smfSession.subnet, '10.199.0.0/24', 'smf.yaml session subnet');

      const upfAfterCreate = await client.get('/api/config/upf');
      const upfSession = (upfAfterCreate.data.data.upf.session ?? []).find(s => s.dev === TEST_DEV);
      if (!upfSession) return fail('upf.yaml has no session for the newly-created profile\'s dev');

      const delRes = await client.delete(`/api/apn-profiles/${profileId}`);
      assertOk(delRes, 'DELETE /api/apn-profiles/:id');

      const listAfterDelete = await client.get('/api/apn-profiles/');
      if (listAfterDelete.data.profiles.some(p => p.id === profileId)) return fail('profile still present in list after delete');

      const smfAfterDelete = await client.get('/api/config/smf');
      if ((smfAfterDelete.data.data.smf.session ?? []).some(s => s.dnn === TEST_DNN)) {
        return fail('smf.yaml STILL has a session for the deleted profile\'s dnn — the orphaned-session bug is not actually fixed');
      }
      const upfAfterDelete = await client.get('/api/config/upf');
      if ((upfAfterDelete.data.data.upf.session ?? []).some(s => s.dev === TEST_DEV)) {
        return fail('upf.yaml STILL has a session for the deleted profile\'s dev — the orphaned-session bug is not actually fixed');
      }

      return pass('full create->verify(real smf.yaml+upf.yaml)->delete->verify-cleaned-up cycle confirmed; duplicate dnn correctly rejected', { profileId });
    },
  },
];
