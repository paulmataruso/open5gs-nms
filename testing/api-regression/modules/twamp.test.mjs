// TWAMP (Backhaul Link Quality) — twamp-controller.ts, 19 routes. Lower
// blast radius than most restart-capable modules: twamp-server.service is a
// standalone network-testing reflector with no subscriber/call/RAN traffic
// depending on it — stopping/restarting it only briefly interrupts OTHER
// devices' ability to test THEIR connectivity to this host, so its
// configure/start/stop/restart routes are exercised directly here, same
// treatment as syslog's rsyslog restart, not gated behind
// --include-disruptive like a core-NF restart would be.
//
// POST /install and /uninstall are NOT exercised — same multi-minute
// real-build / no-safe-revert reasoning as every other module's install
// routes (uninstall here is additionally destructive: rm -rf's the whole
// TWAMP_DIR and removes the systemd unit file outright).
import { assertOk, assertEqual, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'twamp';

async function clientInstalled(client) {
  const res = await client.get('/api/twamp/status');
  return res.data?.installed === true;
}
async function serverInstalled(client) {
  const res = await client.get('/api/twamp/server/status');
  return res.data?.installed === true;
}
async function waitForServerSettled(client, wantActive, timeoutMs = 20000, settleMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await client.get('/api/twamp/server/status');
    if (res.data?.serviceActive === wantActive) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  await new Promise(r => setTimeout(r, settleMs));
}

export const CASES = [
  { name: 'POST /install (not exercised)', async run() { return skip('multi-minute real Go toolchain build with no provable revert — covered indirectly by /status.installed'); } },
  { name: 'POST /uninstall (not exercised)', async run() { return skip('destructive: rm -rf\'s the whole install dir and removes the systemd unit file, with no revert — see this file\'s header comment'); } },

  {
    name: 'GET /status (client)',
    async run({ client }) {
      const res = await client.get('/api/twamp/status');
      assertOk(res, 'GET /api/twamp/status');
      if (typeof res.data?.installed !== 'boolean') return fail('response missing boolean "installed"', res.data);
      return pass(`installed=${res.data.installed}`);
    },
  },
  {
    name: 'GET /targets',
    async run({ client }) {
      if (!(await clientInstalled(client))) return skip('twamp-client not installed');
      const res = await client.get('/api/twamp/targets');
      assertOk(res, 'GET /api/twamp/targets');
      if (!Array.isArray(res.data?.data)) return fail('response missing "data" array', res.data);
      return pass(`${res.data.data.length} target(s)`);
    },
  },
  {
    name: 'full target lifecycle: create -> edit -> delete',
    async run({ client, revertQueue }) {
      if (!(await clientInstalled(client))) return skip('twamp-client not installed');
      const listRes = await client.get('/api/twamp/targets');
      const TEST_NAME = 'API-REGRESSION-TEST-TARGET';
      if (listRes.data.data.some(t => t.name === TEST_NAME)) {
        return fail(`A target named "${TEST_NAME}" already exists — refusing to touch it.`);
      }

      const createRes = await client.post('/api/twamp/targets', {
        name: TEST_NAME, host: '192.0.2.1', port: 862, protocol: 'light', mode: 'unauthenticated', packetCount: 10, pollIntervalSeconds: 300, enabled: false,
      });
      assertOk(createRes, 'POST /api/twamp/targets');
      const targetId = createRes.data?.data?._id;
      if (!targetId) return fail('create response missing data._id', createRes.data);
      revertQueue.push(`delete test twamp target ${TEST_NAME}`, async () => {
        const current = await client.get('/api/twamp/targets');
        if (current.data?.data?.some(t => t._id === targetId)) {
          await client.delete(`/api/twamp/targets/${targetId}`);
        }
      });

      const afterCreate = await client.get('/api/twamp/targets');
      const created = afterCreate.data.data.find(t => t._id === targetId);
      if (!created) return fail('created target not found in subsequent list');
      assertEqual(created.host, '192.0.2.1', 'created target host');
      assertEqual(created.enabled, false, 'created target enabled flag');

      const editRes = await client.put(`/api/twamp/targets/${targetId}`, { packetCount: 5 });
      assertOk(editRes, 'PUT /api/twamp/targets/:id');
      const afterEdit = await client.get('/api/twamp/targets');
      assertEqual(afterEdit.data.data.find(t => t._id === targetId)?.packetCount, 5, 'edited target packetCount');

      const delRes = await client.delete(`/api/twamp/targets/${targetId}`);
      assertOk(delRes, 'DELETE /api/twamp/targets/:id');
      const afterDelete = await client.get('/api/twamp/targets');
      if (afterDelete.data.data.some(t => t._id === targetId)) return fail('target still present in list after delete');

      return pass('full create->edit->delete cycle verified', { targetId });
    },
  },
  {
    // Runs against a REAL, already-configured target (never a throwaway
    // one) — this is a read-only TWAMP probe (connect-test-disconnect, no
    // config change on either end), so it's safe to run against a real
    // radio even though it's not something this suite created or will
    // delete.
    name: 'POST /targets/:id/test against a real existing target (read-only probe)',
    async run({ client }) {
      if (!(await clientInstalled(client))) return skip('twamp-client not installed');
      const listRes = await client.get('/api/twamp/targets');
      const real = listRes.data.data[0];
      if (!real) return skip('no existing targets configured on this instance to test against');
      const res = await client.post(`/api/twamp/targets/${real._id}/test`, {});
      if (res.status >= 500) return fail(`on-demand test errored: HTTP ${res.status}`, res.data);
      if (typeof res.data?.success !== 'boolean') return fail('response missing boolean "success"', res.data);
      return pass(`probe against "${real.name}" returned success=${res.data.success}`, { note: res.data.error });
    },
  },
  {
    name: 'full history/settings cycle: read -> edit -> revert',
    async run({ client, revertQueue }) {
      if (!(await clientInstalled(client))) return skip('twamp-client not installed');
      const before = await client.get('/api/twamp/history/settings');
      assertOk(before, 'GET /api/twamp/history/settings');
      const original = before.data.retentionDays;

      revertQueue.push('revert twamp history retentionDays', async () => {
        await client.put('/api/twamp/history/settings', { retentionDays: original });
      });

      const testValue = original === 30 ? 60 : 30;
      const putRes = await client.put('/api/twamp/history/settings', { retentionDays: testValue });
      assertOk(putRes, 'PUT /api/twamp/history/settings');
      const afterSet = await client.get('/api/twamp/history/settings');
      assertEqual(afterSet.data.retentionDays, testValue, 'retentionDays after set');

      const invalidRes = await client.put('/api/twamp/history/settings', { retentionDays: 99999 });
      if (invalidRes.status !== 400) return fail(`expected HTTP 400 for an out-of-range retentionDays, got ${invalidRes.status}`);

      const revertRes = await client.put('/api/twamp/history/settings', { retentionDays: original });
      assertOk(revertRes, 'PUT /api/twamp/history/settings (revert)');
      const afterRevert = await client.get('/api/twamp/history/settings');
      assertEqual(afterRevert.data.retentionDays, original, 'retentionDays after revert');

      return pass(`toggled ${original} -> ${testValue} -> ${original}; out-of-range value correctly rejected`);
    },
  },
  {
    name: 'GET /history/summary and /history/series',
    async run({ client }) {
      if (!(await clientInstalled(client))) return skip('twamp-client not installed');
      const summaryRes = await client.get('/api/twamp/history/summary');
      assertOk(summaryRes, 'GET /api/twamp/history/summary');
      if (!Array.isArray(summaryRes.data?.data)) return fail('summary response missing "data" array', summaryRes.data);

      const missingTargetRes = await client.get('/api/twamp/history/series');
      if (missingTargetRes.status !== 400) return fail(`expected HTTP 400 for a missing targetId, got ${missingTargetRes.status}`);

      const listRes = await client.get('/api/twamp/targets');
      const real = listRes.data.data[0];
      if (!real) return pass('summary OK; series validation OK; no existing target to test series against');
      const seriesRes = await client.get(`/api/twamp/history/series?targetId=${real._id}`);
      assertOk(seriesRes, 'GET /api/twamp/history/series');
      if (!Array.isArray(seriesRes.data?.data)) return fail('series response missing "data" array', seriesRes.data);
      return pass(`summary: ${summaryRes.data.data.length} entr(y/ies); series: ${seriesRes.data.data.length} bucket(s) for "${real.name}"`);
    },
  },
  {
    name: 'GET /server/status',
    async run({ client }) {
      const res = await client.get('/api/twamp/server/status');
      assertOk(res, 'GET /api/twamp/server/status');
      if (typeof res.data?.installed !== 'boolean') return fail('response missing boolean "installed"', res.data);
      return pass(`installed=${res.data.installed} serviceActive=${res.data.serviceActive}`);
    },
  },
  {
    name: 'POST /server/configure with current values (idempotent, restarts twamp-server)',
    async run({ client }) {
      if (!(await serverInstalled(client))) return skip('twamp-server not installed');
      const before = await client.get('/api/twamp/server/status');
      const cfg = before.data.currentConfig;
      if (!cfg) return skip('twamp-server has no saved config yet — Configure has never been run');

      const res = await client.post('/api/twamp/server/configure', {
        listenIp: cfg.listenIp, listenPort: cfg.listenPort,
        enableFull: cfg.enableFull, enableLight: cfg.enableLight, modes: cfg.modes,
        allowCidrs: cfg.allowCidrs,
      });
      assertOk(res, 'POST /api/twamp/server/configure');
      await waitForServerSettled(client, true);
      const after = await client.get('/api/twamp/server/status');
      if (!after.data?.serviceActive) return fail('twamp-server is not active after re-applying its existing config');
      assertEqual(after.data.currentConfig.listenIp, cfg.listenIp, 'listenIp after re-configure');
      return pass('re-applied existing server config (no functional change); service active afterward');
    },
  },
  {
    name: 'POST /server/stop then /server/start',
    async run({ client }) {
      if (!(await serverInstalled(client))) return skip('twamp-server not installed');
      const before = await client.get('/api/twamp/server/status');
      if (!before.data?.serviceActive) return skip('twamp-server is not currently active — skipping to avoid leaving a pre-existing down service in an ambiguous state');

      const stopRes = await client.post('/api/twamp/server/stop', {});
      assertOk(stopRes, 'POST /api/twamp/server/stop');
      await waitForServerSettled(client, false);
      const afterStop = await client.get('/api/twamp/server/status');
      if (afterStop.data?.serviceActive) return fail('server still reports active immediately after /stop');

      const startRes = await client.post('/api/twamp/server/start', {});
      assertOk(startRes, 'POST /api/twamp/server/start');
      await waitForServerSettled(client, true);
      const afterStart = await client.get('/api/twamp/server/status');
      if (!afterStart.data?.serviceActive) return fail('server did not come back active after /start');

      return pass('stop -> start cycle verified; server active again');
    },
  },
  {
    name: 'GET /server/connections',
    async run({ client }) {
      if (!(await serverInstalled(client))) return skip('twamp-server not installed');
      const res = await client.get('/api/twamp/server/connections');
      assertOk(res, 'GET /api/twamp/server/connections');
      if (!Array.isArray(res.data?.data)) return fail('response missing "data" array', res.data);
      return pass(`${res.data.data.length} connection(s)`);
    },
  },
  {
    name: 'GET /server/metrics',
    async run({ client }) {
      if (!(await serverInstalled(client))) return skip('twamp-server not installed');
      const before = await client.get('/api/twamp/server/status');
      if (!before.data?.serviceActive) return skip('twamp-server is not currently active');
      const res = await client.get('/api/twamp/server/metrics');
      if (res.status >= 500) return fail(`unexpected HTTP ${res.status}`, res.data);
      return pass(`HTTP ${res.status}`);
    },
  },
];
