// SigScale OCS (ocs-controller.ts, mounted at /api/ocs, 13 routes) — the
// charging-plans module already exercises the full Gy/Ro subscriber-
// provisioning lifecycle via direct Erlang RPC (charging-plans.test.mjs);
// this module covers ocs-controller.ts's OWN routes instead: install/
// configure/service-lifecycle/config-editor/admin-user management.
//
// This instance has REAL, currently-active billing (charging-plans.test.mjs
// confirms real subscribers assigned to real plans with a live Gy
// connection) — /configure restarts the OCS Erlang service as part of its
// own setup/reconcile flow, and /start, /stop, /restart restart it
// directly, all of which would interrupt in-flight real charging. None of
// those are exercised here. PUT /configs/content on smf.conf (restarts
// open5gs-smfd, a core-17 NF) is also not exercised — same reasoning as
// vowifi.test.mjs's identical exclusion. POST /install and /uninstall are
// not exercised, same reasoning as every other module's install routes.
import { assertOk, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'ocs';

export const CASES = [
  { name: 'POST /install, /configure, /start, /stop, /restart, /uninstall (not exercised)', async run() { return skip('restarts the OCS Erlang service, interrupting real, currently-active billing on this instance — see this file\'s header comment'); } },
  { name: 'PUT /configs/content on smf.conf (not exercised)', async run() { return skip('restarts open5gs-smfd, a core-17 NF — see this file\'s header comment'); } },

  {
    name: 'GET /status',
    async run({ client }) {
      const res = await client.get('/api/ocs/status');
      assertOk(res, 'GET /api/ocs/status');
      if (typeof res.data?.installed !== 'boolean') return fail('response missing boolean "installed"', res.data);
      return pass(`installed=${res.data.installed} serviceActive=${res.data.serviceActive} gyPeerOpen=${res.data.gyPeerOpen}`);
    },
  },
  {
    name: 'GET /configs + GET /configs/content (read-only)',
    async run({ client }) {
      const manifestRes = await client.get('/api/ocs/configs');
      assertOk(manifestRes, 'GET /api/ocs/configs');
      const files = manifestRes.data?.configs ?? manifestRes.data?.files ?? [];
      if (!Array.isArray(files)) return fail('response missing a files/configs array', manifestRes.data);
      let readCount = 0;
      for (const f of files) {
        if (!f.exists) continue;
        const res = await client.get(`/api/ocs/configs/content?path=${encodeURIComponent(f.path)}`);
        assertOk(res, `GET /api/ocs/configs/content (${f.label ?? f.path})`);
        readCount++;
      }
      return pass(`read ${readCount} file(s)`);
    },
  },
  {
    name: 'POST /sync-subscribers',
    async run({ client }) {
      const statusRes = await client.get('/api/ocs/status');
      if (!statusRes.data?.installed) return skip('OCS not installed');
      if (!statusRes.data?.currentConfig?.defaultOfferId) return skip('no defaultOfferId configured on this instance (Setup tab) — a legitimate, environment-specific precondition this route itself requires');
      const res = await client.post('/api/ocs/sync-subscribers', {});
      assertOk(res, 'POST /api/ocs/sync-subscribers');
      return pass('subscriber sync triggered successfully', res.data);
    },
  },
  {
    name: 'POST /users — create a throwaway OCS admin user + input validation',
    async run({ client }) {
      const statusRes = await client.get('/api/ocs/status');
      if (!statusRes.data?.installed) return skip('OCS not installed');

      const badUsernameRes = await client.post('/api/ocs/users', { username: 'bad user!', password: 'validpass123' });
      if (badUsernameRes.status !== 400) return fail(`expected HTTP 400 for an invalid username, got ${badUsernameRes.status}`);
      const shortPasswordRes = await client.post('/api/ocs/users', { username: 'api-regression-test', password: 'ab' });
      if (shortPasswordRes.status !== 400) return fail(`expected HTTP 400 for a too-short password, got ${shortPasswordRes.status}`);

      // No DELETE /users route exists — a real, intentional, low-risk
      // artifact is left behind (a real but harmless Polymer GUI login),
      // same "nothing to revert through the API, not worth engineering
      // around" reasoning as genieacs.test.mjs's backup file.
      const res = await client.post('/api/ocs/users', { username: 'api-regression-test', password: 'ApiRegressionTest123' });
      assertOk(res, 'POST /api/ocs/users');
      return pass(`throwaway admin user created=${res.data?.created}; invalid username/password both correctly rejected (400)`);
    },
  },
];
