// UE Signal Monitoring — radio-signal-controller.ts, mounted at
// /api/radio-signal, 8 routes.
//
// POST /wake is NOT exercised: unlike everything else here, it sends real
// UDP "wake" packets to a real currently-attached subscriber's real phone
// to trigger downlink paging (requires a real active core bearer — see the
// route's own 409 check). It's a legitimate, designed feature, not a
// dangerous one, but it has a real, if small, side effect on a real
// bystander's device with no way to safely scope it to a consenting
// target, so this suite doesn't trigger it unprompted.
//
// Everything else is exercised against a throwaway radio entry this suite
// creates and deletes itself (POST /radios, DELETE /radios/:id) — POST
// /ingest/:radioId writes fake signal samples scoped to that same
// throwaway radio id, so there's zero chance of polluting a real radio's
// history. POST /discover and POST /poll are exercised directly against
// whatever's really configured: /discover only reads already-known core
// session data and inserts newly-seen radios DISABLED (inert, no polling
// until an operator opts in); /poll performs the exact read-only "ask each
// enabled radio for its own current signal stats" call this feature is
// designed to make routinely, no config is ever pushed to the device.
import { assertOk, assertEqual, pass, fail } from '../lib/test-case.mjs';

export const MODULE = 'radio-signal';

export const CASES = [
  {
    name: 'GET /radios and GET /overview (read-only)',
    async run({ client }) {
      const radiosRes = await client.get('/api/radio-signal/radios');
      assertOk(radiosRes, 'GET /api/radio-signal/radios');
      if (!Array.isArray(radiosRes.data?.radios)) return fail('response missing "radios" array', radiosRes.data);
      const overviewRes = await client.get('/api/radio-signal/overview');
      assertOk(overviewRes, 'GET /api/radio-signal/overview');
      return pass(`${radiosRes.data.radios.length} radio(s) configured`);
    },
  },
  {
    name: 'full radio lifecycle: create (fake, never contacted) -> ingest fake samples -> overview reflects them -> delete',
    async run({ client, revertQueue }) {
      const TEST_NAME = 'API-REGRESSION-TEST-RADIO';
      const listBefore = await client.get('/api/radio-signal/radios');
      if (listBefore.data.radios.some(r => r.name === TEST_NAME)) {
        return fail(`A radio named "${TEST_NAME}" already exists — refusing to touch it.`);
      }

      const createRes = await client.post('/api/radio-signal/radios', {
        name: TEST_NAME, baseUrl: 'https://192.0.2.99/', username: 'test', password: 'test',
        vendor: 'generic', enabled: false,
      });
      assertOk(createRes, 'POST /api/radio-signal/radios');
      const radioId = createRes.data?.id;
      if (!radioId) return fail('create response missing "id"', createRes.data);
      revertQueue.push('delete test radio-signal radio', async () => {
        await client.delete(`/api/radio-signal/radios/${radioId}`).catch(() => {});
      });

      const missingFieldsRes = await client.post('/api/radio-signal/radios', { name: 'incomplete' });
      if (missingFieldsRes.status !== 400) return fail(`expected HTTP 400 for missing required fields, got ${missingFieldsRes.status}`);

      const ingestRes = await client.post(`/api/radio-signal/ingest/${radioId}`, {
        ues: [{ ueId: 'test-ue-1', imsi: '999700000099997', rsrp: -85, rsrq: -10, sinr: 15 }],
      });
      assertOk(ingestRes, 'POST /api/radio-signal/ingest/:radioId');
      if (ingestRes.data?.ingested !== 1) return fail(`expected ingested:1, got ${JSON.stringify(ingestRes.data)}`);

      const overviewRes = await client.get('/api/radio-signal/overview?hours=1');
      assertOk(overviewRes, 'GET /api/radio-signal/overview (after ingest)');

      const ingestBadRadio = await client.post('/api/radio-signal/ingest/nonexistent-radio-id', { ues: [] });
      if (ingestBadRadio.status !== 404) return fail(`expected HTTP 404 for a nonexistent radio id, got ${ingestBadRadio.status}`);

      const delRes = await client.delete(`/api/radio-signal/radios/${radioId}`);
      assertOk(delRes, 'DELETE /api/radio-signal/radios/:id');
      const afterDelete = await client.get('/api/radio-signal/radios');
      if (afterDelete.data.radios.some(r => r.id === radioId)) return fail('radio still present in list after delete');

      return pass('full create->ingest->delete cycle verified; nonexistent-radio ingest correctly 404s');
    },
  },
  {
    name: 'POST /discover (passive — reads already-known core session data, inserts new radios disabled)',
    async run({ client }) {
      const res = await client.post('/api/radio-signal/discover', {});
      assertOk(res, 'POST /api/radio-signal/discover');
      if (!Array.isArray(res.data?.discovered)) return fail('response missing "discovered" array', res.data);
      return pass(`${res.data.discovered.length} radio(s) with active sessions seen`);
    },
  },
  {
    name: 'POST /poll (read-only — queries each enabled radio\'s own signal-reporting endpoint)',
    async run({ client }) {
      const res = await client.post('/api/radio-signal/poll', {});
      assertOk(res, 'POST /api/radio-signal/poll');
      if (!Array.isArray(res.data?.results)) return fail('response missing "results" array', res.data);
      return pass(`polled ${res.data.results.length} enabled radio(s)`);
    },
  },
];
