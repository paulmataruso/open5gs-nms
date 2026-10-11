// Charging Plans — full lifecycle against a real SigScale OCS backend (this
// isn't a DB-only feature: create/update/delete all make real OCS RPC calls
// via provisionPlanOffers()/deprovisionPlanOffers(), and assign makes a real
// assignSubscribersToPlan() call). Not disruptive in the "restarts a live
// core NF" sense — these are normal, intended-use API calls, not service
// restarts — so this module runs by default, not gated.
//
// Uses its own throwaway test subscriber (separate reserved IMSI from
// subscribers.test.mjs, since module load order isn't guaranteed and each
// module should be fully self-contained) for the assign/usage/unassign
// cycle, and cleans it up itself.
import { assertOk, assertEqual, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'charging-plans';

const TEST_PLAN_NAME = 'API-REGRESSION-TEST-PLAN';
const TEST_IMSI = '999700000000002'; // distinct from subscribers.test.mjs's 999700000000001
const UNLIMITED_PLAN_NAME = 'Unlimited';

async function ocsConfigured(client) {
  const res = await client.get('/api/ocs/status');
  return res.data?.installed === true && res.data?.hasSavedConfig === true;
}

export const CASES = [
  {
    name: 'GET / (list plans)',
    async run({ client }) {
      const res = await client.get('/api/charging-plans/');
      assertOk(res, 'GET /api/charging-plans/');
      if (!Array.isArray(res.data?.data)) return fail('response missing "data" array', res.data);
      return pass(`${res.data.data.length} plan(s)`);
    },
  },
  {
    name: 'full lifecycle: create -> edit -> assign -> usage -> delete (cascades plan+OCS) -> delete plan',
    async run({ client, revertQueue }) {
      if (!(await ocsConfigured(client))) {
        return skip('SigScale OCS not installed/configured on this instance — charging plans need a real OCS backend');
      }

      // ── refuse to collide with pre-existing data, same policy as subscribers.test.mjs ──
      const listRes = await client.get('/api/charging-plans/');
      assertOk(listRes, 'GET /api/charging-plans/ (pre-check)');
      if (listRes.data.data.some(p => p.name === TEST_PLAN_NAME)) {
        return fail(`A plan named "${TEST_PLAN_NAME}" already exists — refusing to touch it. Delete it manually before re-running.`);
      }
      const subRes = await client.get(`/api/subscribers/${TEST_IMSI}`);
      if (subRes.status === 200) {
        return fail(`A subscriber with the reserved test IMSI ${TEST_IMSI} already exists — refusing to touch it.`);
      }

      // ── create plan ──
      const createRes = await client.post('/api/charging-plans/', {
        name: TEST_PLAN_NAME, dataCapGB: 1, voiceCapMinutes: 10,
      });
      if (!createRes.ok) {
        return fail(`POST /api/charging-plans/ failed: HTTP ${createRes.status} — ${JSON.stringify(createRes.data)}`);
      }
      const planId = createRes.data?.data?._id;
      if (!planId) return fail('create response missing plan _id', createRes.data);
      revertQueue.push(`delete test charging plan ${TEST_PLAN_NAME}`, async () => {
        const current = await client.get('/api/charging-plans/');
        const plan = current.data?.data?.find(p => p._id === planId);
        if (!plan) return; // already gone — nothing to do
        // If subscribers are still (or again) attached, the delete endpoint
        // refuses — move them to Unlimited first so cleanup can't silently
        // no-op the way the original, less careful version of this test did.
        if (plan.imsis?.length > 0) {
          const plansListRes = await client.get('/api/charging-plans/');
          const unlimitedPlan = plansListRes.data?.data?.find(p => p.name === UNLIMITED_PLAN_NAME);
          if (unlimitedPlan) {
            await client.post(`/api/charging-plans/${unlimitedPlan._id}/assign`, { imsis: plan.imsis });
          }
        }
        const delRes = await client.delete(`/api/charging-plans/${planId}`);
        if (!delRes.ok) {
          throw new Error(`could not delete test plan ${planId}: HTTP ${delRes.status} — ${JSON.stringify(delRes.data)}`);
        }
      });

      const afterCreate = await client.get('/api/charging-plans/');
      const createdPlan = afterCreate.data.data.find(p => p._id === planId);
      if (!createdPlan) return fail('created plan not found in subsequent list');
      assertEqual(createdPlan.dataCapGB, 1, 'created plan dataCapGB');
      assertEqual(createdPlan.voiceCapMinutes, 10, 'created plan voiceCapMinutes');

      // ── edit plan (caps) ──
      const editRes = await client.put(`/api/charging-plans/${planId}`, { dataCapGB: 2, voiceCapMinutes: 20 });
      assertOk(editRes, 'PUT /api/charging-plans/:id');
      const afterEdit = await client.get('/api/charging-plans/');
      const editedPlan = afterEdit.data.data.find(p => p._id === planId);
      assertEqual(editedPlan?.dataCapGB, 2, 'edited plan dataCapGB');
      assertEqual(editedPlan?.voiceCapMinutes, 20, 'edited plan voiceCapMinutes');

      // ── create the throwaway test subscriber to assign ──
      const subCreateRes = await client.post('/api/subscribers/', {
        imsi: TEST_IMSI,
        msisdn: ['9997000000002'],
        nickname: 'API-REGRESSION-TEST-SUBSCRIBER-2',
        security: { k: '00112233445566778899aabbccddeeff', opc: 'ffeeddccbbaa99887766554433221100', amf: '8000' },
        ambr: { uplink: { value: 1, unit: 3 }, downlink: { value: 1, unit: 3 } },
        slice: [{
          sst: 1, default_indicator: true,
          session: [{
            name: 'internet', type: 1,
            ambr: { uplink: { value: 1, unit: 3 }, downlink: { value: 1, unit: 3 } },
            qos: { index: 9, arp: { priority_level: 8, pre_emption_capability: 1, pre_emption_vulnerability: 1 } },
          }],
        }],
      });
      revertQueue.push(`delete test subscriber ${TEST_IMSI}`, async () => {
        const stillThere = await client.get(`/api/subscribers/${TEST_IMSI}`);
        if (stillThere.status !== 200) return;
        // Deleting now cascades to pull this IMSI out of any charging
        // plan's imsis[] automatically (see subscriber-management.ts's
        // delete()) — no need to reassign off a plan first.
        const delRes = await client.delete(`/api/subscribers/${TEST_IMSI}`);
        if (!delRes.ok) {
          throw new Error(`could not delete test subscriber ${TEST_IMSI}: HTTP ${delRes.status} — ${JSON.stringify(delRes.data)}`);
        }
      });
      assertOk(subCreateRes, 'POST /api/subscribers/ (for assign test)');

      // ── assign to test plan ──
      const assignRes = await client.post(`/api/charging-plans/${planId}/assign`, { imsis: [TEST_IMSI] });
      assertOk(assignRes, 'POST /api/charging-plans/:id/assign');
      if (assignRes.data?.assigned !== 1) {
        return fail(`expected assigned=1, got ${JSON.stringify(assignRes.data)} — OCS-side assignment may have failed or conflicted`);
      }
      const afterAssign = await client.get('/api/charging-plans/');
      const assignedPlan = afterAssign.data.data.find(p => p._id === planId);
      if (!assignedPlan?.imsis?.includes(TEST_IMSI)) {
        return fail(`plan's imsis[] does not include ${TEST_IMSI} after a reported-successful assign`, assignedPlan);
      }

      // ── usage (real OCS bucket query for the assigned subscriber) ──
      const usageRes = await client.get(`/api/charging-plans/${planId}/usage`);
      assertOk(usageRes, 'GET /api/charging-plans/:id/usage');
      const usageEntry = Array.isArray(usageRes.data?.data)
        ? usageRes.data.data.find(u => u.imsi === TEST_IMSI)
        : usageRes.data?.data?.[TEST_IMSI];
      if (!usageEntry) {
        return fail('usage response does not include the just-assigned test subscriber', usageRes.data);
      }

      // ── delete subscriber directly (still assigned to the test plan) —
      // NOT a reassign-to-Unlimited first. A fresh test subscriber always
      // has full, unused balance on whatever plan they're first assigned
      // to, and EnsurePlan's HasRealBalance check deliberately refuses to
      // silently reassign real unused balance away (protects a real
      // subscriber's money) — so trying to "unassign" a never-used test
      // subscriber via reassignment would always conflict by design, not
      // a bug. Deleting the subscriber directly instead exercises the real
      // cleanup path (subscriber-management.ts's delete(), which pulls
      // this IMSI from nms_charging_plans.imsis[] AND tears down the real
      // OCS service+product via removeSubscriberFromOcs()) and verifies
      // BOTH sides of that cascade actually took effect. ──
      const subDelRes = await client.delete(`/api/subscribers/${TEST_IMSI}`);
      assertOk(subDelRes, 'DELETE /api/subscribers/:imsi');

      const afterSubDelete = await client.get('/api/charging-plans/');
      const planAfterSubDelete = afterSubDelete.data.data.find(p => p._id === planId);
      if (planAfterSubDelete?.imsis?.includes(TEST_IMSI)) {
        return fail(
          'deleted subscriber is still listed in the plan\'s imsis[] — the Mongo-side cascade ' +
          '($pull in subscriber-management.ts delete()) did not take effect',
        );
      }

      // ── plan should now delete cleanly (imsis[] empty) ──
      const planDelRes = await client.delete(`/api/charging-plans/${planId}`);
      assertOk(planDelRes, 'DELETE /api/charging-plans/:id');
      const afterDelete = await client.get('/api/charging-plans/');
      if (afterDelete.data.data.some(p => p._id === planId)) {
        return fail('plan still present in list after delete');
      }

      return pass('full create->edit->assign->usage->delete(cascades plan+OCS)->delete-plan cycle verified', { planId });
    },
  },
  {
    name: '"Unlimited" default plan exists and is auto-provisioned',
    async run({ client }) {
      if (!(await ocsConfigured(client))) {
        return skip('SigScale OCS not installed/configured on this instance');
      }
      const res = await client.get('/api/charging-plans/');
      assertOk(res, 'GET /api/charging-plans/');
      const unlimited = res.data.data.find(p => p.name === UNLIMITED_PLAN_NAME);
      if (!unlimited) return fail(`No "${UNLIMITED_PLAN_NAME}" plan found`);
      // CLAUDE.md: "1,000,000 GB / 1,000,000 min — a deliberately huge
      // finite cap" and the UI renders >=100,000 as "Unlimited" — confirm
      // the real stored values are actually in that huge-cap range, not
      // just a plan that happens to share the display name.
      if (unlimited.dataCapGB < 100000 || unlimited.voiceCapMinutes < 100000) {
        return fail(`"${UNLIMITED_PLAN_NAME}" plan exists but caps look too small to render as Unlimited in the UI`, unlimited);
      }
      return pass(`dataCapGB=${unlimited.dataCapGB} voiceCapMinutes=${unlimited.voiceCapMinutes}`);
    },
  },
  {
    name: 'create with invalid payload is rejected (negative/missing caps)',
    async run({ client }) {
      const res = await client.post('/api/charging-plans/', { name: 'should-not-be-created', dataCapGB: -1, voiceCapMinutes: 10 });
      if (res.status !== 400) {
        return fail(`expected HTTP 400 for an invalid payload, got ${res.status}`, res.data);
      }
      // Confirm it really wasn't created despite any weirdness in the error path.
      const listRes = await client.get('/api/charging-plans/');
      if (listRes.data.data.some(p => p.name === 'should-not-be-created')) {
        return fail('plan was created in Mongo despite a 400 response — partial-failure bug');
      }
      return pass('correctly rejected with HTTP 400, nothing created');
    },
  },
  {
    name: 'delete is refused while subscribers are still assigned',
    async run({ client, revertQueue }) {
      if (!(await ocsConfigured(client))) {
        return skip('SigScale OCS not installed/configured on this instance');
      }
      const listRes = await client.get('/api/charging-plans/');
      const unlimited = listRes.data.data.find(p => p.name === UNLIMITED_PLAN_NAME);
      if (!unlimited || !unlimited.imsis || unlimited.imsis.length === 0) {
        return skip('no plan with at least one assigned subscriber available to test the delete-guard against');
      }
      const res = await client.delete(`/api/charging-plans/${unlimited._id}`);
      if (res.status !== 400) {
        return fail(`expected HTTP 400 (refused — subscribers still assigned), got ${res.status}`, res.data);
      }
      // Nothing to revert — a correctly-refused delete changed nothing.
      return pass(`correctly refused to delete a plan with ${unlimited.imsis.length} assigned subscriber(s)`);
    },
  },
];
