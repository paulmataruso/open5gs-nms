// Subscriber CRUD — create a clearly-marked throwaway test subscriber,
// edit it, read it back, then delete it. The delete IS the revert here (no
// separate undo needed beyond "if something failed before we got to
// delete, delete it in the revert queue instead").
//
// Test IMSI is in the 999-70 range — an old, now-unused test PLMN this
// project itself migrated off of (see CLAUDE.md's PLMN reference section),
// so it's extremely unlikely to collide with a real subscriber on any
// instance this suite runs against. If a subscriber with this exact IMSI
// already exists, the create case fails loudly rather than silently
// clobbering someone else's data.
import { assertOk, assertEqual, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'subscribers';

const TEST_IMSI = '999700000000001';
const TEST_NICKNAME_1 = 'API-REGRESSION-TEST-SUBSCRIBER';
const TEST_NICKNAME_2 = 'API-REGRESSION-TEST-SUBSCRIBER-EDITED';

function basePayload(nickname) {
  return {
    imsi: TEST_IMSI,
    msisdn: ['9997000000001'],
    nickname,
    security: {
      k: '00112233445566778899aabbccddeeff',
      opc: 'ffeeddccbbaa99887766554433221100',
      amf: '8000',
    },
    ambr: {
      uplink: { value: 1, unit: 3 },
      downlink: { value: 1, unit: 3 },
    },
    slice: [{
      sst: 1,
      default_indicator: true,
      session: [{
        name: 'internet',
        type: 1,
        ambr: {
          uplink: { value: 1, unit: 3 },
          downlink: { value: 1, unit: 3 },
        },
        qos: {
          index: 9,
          arp: { priority_level: 8, pre_emption_capability: 1, pre_emption_vulnerability: 1 },
        },
      }],
    }],
  };
}

export const CASES = [
  {
    name: 'create test subscriber',
    async run({ client, revertQueue }) {
      const existing = await client.get(`/api/subscribers/${TEST_IMSI}`);
      if (existing.status === 200) {
        return fail(
          `A subscriber with the reserved test IMSI ${TEST_IMSI} already exists on this instance — ` +
          `refusing to touch it. Delete it manually (or pick a different TEST_IMSI in this file) before re-running.`,
        );
      }

      const createRes = await client.post('/api/subscribers/', basePayload(TEST_NICKNAME_1));
      // Register the cleanup immediately, before even checking createRes.ok —
      // if the server partially created the record despite a weird response,
      // we still want to try deleting it.
      revertQueue.push(`delete test subscriber ${TEST_IMSI}`, async () => {
        // The suite's own "delete test subscriber" case normally already
        // removes it — check first so that expected, successful path
        // doesn't show up as a confusing "revert failed" (delete-of-
        // already-deleted) in the report.
        const stillThere = await client.get(`/api/subscribers/${TEST_IMSI}`);
        if (stillThere.status === 200) {
          await client.delete(`/api/subscribers/${TEST_IMSI}`);
        }
      });
      assertOk(createRes, 'POST /api/subscribers/');

      const readBack = await client.get(`/api/subscribers/${TEST_IMSI}`);
      assertOk(readBack, 'GET /api/subscribers/:imsi after create');
      assertEqual(readBack.data?.imsi, TEST_IMSI, 'created subscriber imsi');
      assertEqual(readBack.data?.nickname, TEST_NICKNAME_1, 'created subscriber nickname');

      return pass('created and read back successfully', { imsi: TEST_IMSI });
    },
  },
  {
    name: 'edit test subscriber (nickname + msisdn)',
    async run({ client }) {
      const existing = await client.get(`/api/subscribers/${TEST_IMSI}`);
      if (existing.status !== 200) {
        return skip('create case did not leave a subscriber in place (see its own result)');
      }

      const updateRes = await client.put(`/api/subscribers/${TEST_IMSI}`, {
        ...basePayload(TEST_NICKNAME_2),
        msisdn: ['9997000000002'],
      });
      assertOk(updateRes, 'PUT /api/subscribers/:imsi');

      const readBack = await client.get(`/api/subscribers/${TEST_IMSI}`);
      assertOk(readBack, 'GET /api/subscribers/:imsi after edit');
      assertEqual(readBack.data?.nickname, TEST_NICKNAME_2, 'edited subscriber nickname');
      assertEqual(readBack.data?.msisdn?.[0], '9997000000002', 'edited subscriber msisdn');

      return pass('edit took effect and was independently read back', { imsi: TEST_IMSI });
    },
  },
  {
    name: 'subscriber list includes the test subscriber',
    async run({ client }) {
      const listRes = await client.get('/api/subscribers/');
      assertOk(listRes, 'GET /api/subscribers/');
      const list = Array.isArray(listRes.data) ? listRes.data : listRes.data?.subscribers;
      if (!Array.isArray(list)) {
        return fail('GET /api/subscribers/ did not return a recognizable array', { shape: typeof listRes.data });
      }
      const found = list.some(s => s.imsi === TEST_IMSI);
      if (!found) {
        return fail(`Test subscriber ${TEST_IMSI} exists via GET /:imsi but is missing from the list endpoint`);
      }
      return pass(`found in list of ${list.length} subscribers`);
    },
  },
  {
    name: 'delete test subscriber',
    async run({ client }) {
      const delRes = await client.delete(`/api/subscribers/${TEST_IMSI}`);
      assertOk(delRes, 'DELETE /api/subscribers/:imsi');

      const readBack = await client.get(`/api/subscribers/${TEST_IMSI}`);
      if (readBack.status !== 404) {
        return fail(`Subscriber still readable (HTTP ${readBack.status}) after delete — expected 404`);
      }
      return pass('confirmed gone (404) after delete');
    },
  },
];
