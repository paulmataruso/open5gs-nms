// Call History (CDR) — cdr-controller.ts, mounted at /api/cdr, 5 routes.
// POST /kamailio-acc restarts kamailio-scscf via the SAME setCdrAccountingEnabled()
// path documented in ims.test.mjs's header — same Type=simple restart-race
// risk, so this uses the same poll-then-settle pattern before issuing the
// second (revert) restart.
import { assertOk, assertEqual, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'cdr';

async function waitForScscfSettled(client) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const res = await client.get('/api/ims/status');
    if (res.data?.services?.scscf === true) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  await new Promise(r => setTimeout(r, 4000));
}

export const CASES = [
  {
    name: 'GET / (list, paginated + filtered)',
    async run({ client }) {
      const res = await client.get('/api/cdr/?pageSize=5');
      assertOk(res, 'GET /api/cdr/');
      if (!Array.isArray(res.data?.rows)) return fail('response missing "rows" array', res.data);
      return pass(`${res.data.rows.length} record(s) (of ${res.data.total ?? '?'} total)`);
    },
  },
  {
    name: 'GET / with filters (sourceSystem, disposition, date range)',
    async run({ client }) {
      const res = await client.get('/api/cdr/?sourceSystem=pstn&disposition=answered&from=2020-01-01T00:00:00.000Z&to=2030-01-01T00:00:00.000Z&page=1&pageSize=10');
      assertOk(res, 'GET /api/cdr/ (filtered)');
      if (!Array.isArray(res.data?.rows)) return fail('response missing "rows" array', res.data);
      for (const r of res.data.rows) {
        if (r.sourceSystem !== 'pstn') return fail(`filter sourceSystem=pstn leaked a record with sourceSystem=${r.sourceSystem}`, r);
        if (r.disposition !== 'answered') return fail(`filter disposition=answered leaked a record with disposition=${r.disposition}`, r);
      }
      return pass(`${res.data.rows.length} filtered record(s), all matching both filters`);
    },
  },
  {
    name: 'full retention settings cycle: read -> edit -> validate -> revert',
    async run({ client, revertQueue }) {
      const before = await client.get('/api/cdr/settings');
      assertOk(before, 'GET /api/cdr/settings');
      const original = before.data.retentionDays;

      revertQueue.push('revert cdr retentionDays', async () => {
        await client.put('/api/cdr/settings', { retentionDays: original });
      });

      const testValue = original === 90 ? 120 : 90;
      const putRes = await client.put('/api/cdr/settings', { retentionDays: testValue });
      assertOk(putRes, 'PUT /api/cdr/settings');
      const afterSet = await client.get('/api/cdr/settings');
      assertEqual(afterSet.data.retentionDays, testValue, 'retentionDays after set');

      const invalidRes = await client.put('/api/cdr/settings', { retentionDays: 99999 });
      if (invalidRes.status !== 400) return fail(`expected HTTP 400 for an out-of-range retentionDays, got ${invalidRes.status}`);

      const revertRes = await client.put('/api/cdr/settings', { retentionDays: original });
      assertOk(revertRes, 'PUT /api/cdr/settings (revert)');
      const afterRevert = await client.get('/api/cdr/settings');
      assertEqual(afterRevert.data.retentionDays, original, 'retentionDays after revert');

      return pass(`toggled ${original} -> ${testValue} -> ${original}; out-of-range value correctly rejected`);
    },
  },
  {
    name: 'POST /sync-now',
    async run({ client }) {
      const res = await client.post('/api/cdr/sync-now', {});
      assertOk(res, 'POST /api/cdr/sync-now');
      return pass('manual sync triggered successfully');
    },
  },
  {
    disruptive: true,
    name: 'POST /kamailio-acc toggle — restarts kamailio-scscf',
    async run({ client, revertQueue }) {
      const statusRes = await client.get('/api/ims/status');
      if (!statusRes.data?.installed) return skip('IMS not installed');
      const original = statusRes.data.cdrAccountingEnabled;
      if (typeof original !== 'boolean') return skip('cdrAccountingEnabled not present in /api/ims/status on this instance');
      const testValue = !original;

      revertQueue.push('revert kamailio-acc toggle', async () => {
        const current = await client.get('/api/ims/status');
        if (current.data?.cdrAccountingEnabled !== original) {
          await client.post('/api/cdr/kamailio-acc', { enabled: original });
          await waitForScscfSettled(client);
        }
      });

      const invalidRes = await client.post('/api/cdr/kamailio-acc', { enabled: 'not-a-boolean' });
      if (invalidRes.status !== 400) return fail(`expected HTTP 400 for a non-boolean enabled, got ${invalidRes.status}`);

      const setRes = await client.post('/api/cdr/kamailio-acc', { enabled: testValue });
      assertOk(setRes, 'POST /api/cdr/kamailio-acc (test value)');
      await waitForScscfSettled(client);
      const afterSet = await client.get('/api/ims/status');
      assertEqual(afterSet.data.cdrAccountingEnabled, testValue, 'cdrAccountingEnabled after set');

      const revertRes = await client.post('/api/cdr/kamailio-acc', { enabled: original });
      assertOk(revertRes, 'POST /api/cdr/kamailio-acc (revert)');
      await waitForScscfSettled(client);
      const afterRevert = await client.get('/api/ims/status');
      assertEqual(afterRevert.data.cdrAccountingEnabled, original, 'cdrAccountingEnabled after revert');

      return pass(`toggled ${original} -> ${testValue} -> ${original}; invalid input correctly rejected`);
    },
  },
];
