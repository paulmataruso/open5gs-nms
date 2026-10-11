// IP Plan Tool — ip-plan-controller.ts, mounted at /api/ip-plan, 5 routes.
// GET / and GET /suggest and POST /propose are all pure reads/previews —
// confirmed by reading the source: /propose never writes anything, it only
// reads each module's current live config plus the host's real interfaces
// and computes non-colliding suggestions in memory.
//
// POST /apply is deliberately NOT exercised: per its own doc comment, a
// full run can be "minutes — IMS alone is 14+ sequential service restarts,"
// and it can live-apply new addresses across secgw/vowifi/gsm/ims/pstn/mms
// and up to all 7 core-17 address fields in one batch. This is the single
// highest blast-radius write path in the entire product — bulk re-
// addressing a live deployment — and is not something to trigger from an
// unattended test run. GET /apply/status is exercised (read-only, safe
// even with no job running).
import { assertOk, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'ip-plan';

export const CASES = [
  { name: 'POST /apply (not exercised)', async run() { return skip('bulk live re-addressing across up to 7+ modules including a 14+-service-restart IMS pass — see this file\'s header comment'); } },

  {
    name: 'GET / (current registry, read-only)',
    async run({ client }) {
      const res = await client.get('/api/ip-plan/');
      assertOk(res, 'GET /api/ip-plan/');
      if (!Array.isArray(res.data?.entries)) return fail('response missing "entries" array', res.data);
      return pass(`${res.data.entries.length} entries`);
    },
  },
  {
    name: 'GET /suggest (detected main interface)',
    async run({ client }) {
      const res = await client.get('/api/ip-plan/suggest');
      assertOk(res, 'GET /api/ip-plan/suggest');
      if (!res.data?.mainInterface?.cidr) return fail('response missing mainInterface.cidr', res.data);
      return pass(`detected ${res.data.mainInterface.name} (${res.data.mainInterface.cidr})`);
    },
  },
  {
    name: 'POST /propose — pure preview, never writes anything',
    async run({ client }) {
      const suggestRes = await client.get('/api/ip-plan/suggest');
      const subnet = suggestRes.data?.mainInterface?.cidr;
      if (!subnet) return skip('could not detect a main interface subnet to propose against');

      const before = await client.get('/api/ip-plan/');

      const invalidRes = await client.post('/api/ip-plan/propose', { subnet: 'not-a-cidr' });
      if (invalidRes.status !== 400) return fail(`expected HTTP 400 for an invalid subnet, got ${invalidRes.status}`);

      const res = await client.post('/api/ip-plan/propose', { subnet });
      assertOk(res, 'POST /api/ip-plan/propose');
      if (!Array.isArray(res.data?.entries)) return fail('response missing "entries" array', res.data);

      // Confirm this really was a pure preview — the live registry must be
      // byte-identical before and after.
      const after = await client.get('/api/ip-plan/');
      if (JSON.stringify(before.data.entries) !== JSON.stringify(after.data.entries)) {
        return fail('the live registry changed after calling /propose — this route is supposed to be a read-only preview');
      }

      return pass(`${res.data.entries.length} entries proposed against ${subnet}; confirmed the live registry is unchanged; invalid subnet correctly rejected`);
    },
  },
  {
    name: 'GET /apply/status (read-only, safe even idle)',
    async run({ client }) {
      const res = await client.get('/api/ip-plan/apply/status');
      if (res.status >= 500) return fail(`unexpected HTTP ${res.status}`, res.data);
      return pass(`HTTP ${res.status}`);
    },
  },
];
