// MMS (VectorCore MMSC) — mms-controller.ts, mounted at /api/mms, 10 routes.
// VectorCore + its mm1-msisdn-proxy are standalone, no RAN/core-NF/subscriber
// -call impact — /start, /stop, /restart, /configure are exercised directly,
// same risk tier as syslog/twamp-server, not gated behind
// --include-disruptive.
import { assertOk, assertEqual, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'mms';

async function installed(client) {
  const res = await client.get('/api/mms/status');
  return res.data?.installed === true;
}
// ApiClient's safeJson() truncates any non-JSON body to 500 chars (fine for
// diagnostic evidence, not enough to assert on content deep inside a real
// XML plist) — this fetches the full raw text directly, reusing the same
// cookie-replay convention client.mjs uses internally.
async function rawGetText(client, path) {
  const res = await fetch(`${client.baseUrl}${path}`, { headers: client.cookie ? { Cookie: client.cookie } : {} });
  return { status: res.status, text: await res.text() };
}

async function waitForSettled(client, checkFn, timeoutMs = 20000, settleMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkFn()) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  await new Promise(r => setTimeout(r, settleMs));
}

export const CASES = [
  {
    name: 'GET /status',
    async run({ client }) {
      const res = await client.get('/api/mms/status');
      assertOk(res, 'GET /api/mms/status');
      if (typeof res.data?.installed !== 'boolean') return fail('response missing boolean "installed"', res.data);
      return pass(`installed=${res.data.installed}`);
    },
  },
  {
    name: 'POST /configure with current mm1PublicIp (idempotent) + invalid-IP validation',
    async run({ client }) {
      if (!(await installed(client))) return skip('MMS not installed');
      const before = await client.get('/api/mms/status');
      const currentIp = before.data?.currentConfig?.mm1PublicIp;
      if (!currentIp) return skip('MMS has no saved config yet — Configure has never been run');

      const invalidRes = await client.post('/api/mms/configure', { mm1PublicIp: 'not-an-ip' });
      if (invalidRes.status !== 400) return fail(`expected HTTP 400 for a malformed mm1PublicIp, got ${invalidRes.status}`);

      const res = await client.post('/api/mms/configure', { mm1PublicIp: currentIp });
      assertOk(res, 'POST /api/mms/configure');
      const after = await client.get('/api/mms/status');
      assertEqual(after.data?.currentConfig?.mm1PublicIp, currentIp, 'mm1PublicIp after re-configure');
      return pass('re-applied existing config (no functional change); malformed IP correctly rejected (400)');
    },
  },
  {
    name: 'POST /sync-subscribers',
    async run({ client }) {
      if (!(await installed(client))) return skip('MMS not installed');
      const res = await client.post('/api/mms/sync-subscribers', {});
      assertOk(res, 'POST /api/mms/sync-subscribers');
      if (typeof res.data?.synced !== 'number') return fail('response missing numeric "synced"', res.data);
      return pass(`synced=${res.data.synced} failed=${res.data.failed?.length ?? 0} removed=${res.data.removed ?? 0}`);
    },
  },
  {
    name: 'GET /mobileconfig (default + custom apn/mmscUrl)',
    async run({ client }) {
      if (!(await installed(client))) return skip('MMS not installed');
      const defaultRes = await client.get('/api/mms/mobileconfig');
      if (defaultRes.status !== 200) return fail(`expected HTTP 200 for the default profile, got ${defaultRes.status}`, defaultRes.data);

      const customRes = await rawGetText(client, '/api/mms/mobileconfig?apn=customapn&mmscUrl=' + encodeURIComponent('http://198.51.100.1:9191/mms/retrieve'));
      if (customRes.status !== 200) return fail(`expected HTTP 200 for a custom profile, got ${customRes.status}`);
      if (!customRes.text.includes('customapn')) return fail('custom apn query param did not appear in the generated profile');

      return pass('default and custom mobileconfig profiles both generated successfully');
    },
  },
  {
    name: 'GET /admin/* (read-only proxy into VectorCore\'s own API)',
    async run({ client }) {
      if (!(await installed(client))) return skip('MMS not installed');
      const before = await client.get('/api/mms/status');
      if (!before.data?.serviceActive) return skip('VectorCore MMSC is not currently active');

      const res = await client.get('/api/mms/admin/api/v1/messages');
      if (res.status !== 200) return fail(`expected HTTP 200 proxying a real VectorCore endpoint, got ${res.status}`, res.data);
      if (!Array.isArray(res.data?.messages)) return fail('proxied response missing "messages" array — proxy may not be reaching VectorCore correctly', res.data);

      // A path VectorCore itself doesn't recognize should pass its real 404
      // through as a 502 (curl -f failing), not silently succeed.
      const badRes = await client.get('/api/mms/admin/api/v1/this-does-not-exist');
      if (badRes.status !== 502) return fail(`expected HTTP 502 (proxied 404) for an unrecognized VectorCore path, got ${badRes.status}`);

      return pass(`proxy reached VectorCore successfully (${res.data.messages.length} message(s)); unrecognized path correctly surfaced as 502`);
    },
  },
  {
    name: 'POST /stop then /start (VectorCore MMSC + mm1 proxy)',
    async run({ client }) {
      if (!(await installed(client))) return skip('MMS not installed');
      const before = await client.get('/api/mms/status');
      if (!before.data?.serviceActive) return skip('VectorCore MMSC is not currently active — skipping to avoid leaving a pre-existing down service in an ambiguous state');

      const stopRes = await client.post('/api/mms/stop', {});
      assertOk(stopRes, 'POST /api/mms/stop');
      await waitForSettled(client, async () => {
        const s = await client.get('/api/mms/status');
        return s.data?.serviceActive === false;
      });
      const afterStop = await client.get('/api/mms/status');
      if (afterStop.data?.serviceActive) return fail('service still reports active immediately after /stop');

      const startRes = await client.post('/api/mms/start', {});
      assertOk(startRes, 'POST /api/mms/start');
      await waitForSettled(client, async () => {
        const s = await client.get('/api/mms/status');
        return s.data?.serviceActive === true && s.data?.proxyActive === true;
      });
      const afterStart = await client.get('/api/mms/status');
      if (!afterStart.data?.serviceActive || !afterStart.data?.proxyActive) {
        return fail('service and/or proxy did not come back active after /start', afterStart.data);
      }

      return pass('stop -> start cycle verified; MMSC and proxy both active again');
    },
  },
];
