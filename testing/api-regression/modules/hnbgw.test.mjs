// 3G UMTS (OsmoHNBGW) — hnbgw-controller.ts, mounted at /api/hnbgw, 13
// routes. Unlike every other radio-RAN module in this suite, this one has
// a genuinely safe software-only test path: OsmoHNodeB, a real software
// test HNB with no physical radio hardware involved at all (CLAUDE.md's
// own description: "a software test HNB... proved a full live HNBAP
// registration end-to-end before any real hardware was touched"). This
// instance already has one deployed, so the test here is a real remove ->
// deploy cycle against it — confirmed safe to re-run quickly: the deploy
// script checks the already-built binary + build revision first and exits
// immediately ("nothing to do") rather than re-running the from-source
// build, so this doesn't risk an unexpected multi-minute compile.
//
// POST /install, /configure, /start, /stop, /restart, PUT /configs/content,
// /configs/restart, /uninstall are NOT exercised — all of these affect the
// real OsmoHNBGW/MGW/point-code wiring a real ip.access nano3G (the actual
// hardware target per CLAUDE.md) would depend on, same standing-caution
// class as this module's own osmo-hnbgw service.
import { assertOk, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'hnbgw';

async function waitForSettled(client, checkFn, timeoutMs = 60000, settleMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkFn()) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  await new Promise(r => setTimeout(r, settleMs));
}

export const CASES = [
  { name: 'POST /install, /configure, /start, /stop, /restart, /configs/restart, /uninstall; PUT /configs/content (not exercised)', async run() { return skip('affects the real OsmoHNBGW/MGW/point-code wiring a real ip.access nano3G would depend on — see this file\'s header comment'); } },

  {
    name: 'GET /status',
    async run({ client }) {
      const res = await client.get('/api/hnbgw/status');
      assertOk(res, 'GET /api/hnbgw/status');
      if (typeof res.data?.installedOnDisk !== 'boolean') return fail('response missing boolean "installedOnDisk"', res.data);
      return pass(`installedOnDisk=${res.data.installedOnDisk} configured=${res.data.configured} virtualHnbDeployed=${res.data.virtualHnbDeployed}`);
    },
  },
  {
    name: 'GET /configs + GET /configs/content (read-only)',
    async run({ client }) {
      const manifestRes = await client.get('/api/hnbgw/configs');
      assertOk(manifestRes, 'GET /api/hnbgw/configs');
      const files = manifestRes.data?.files ?? manifestRes.data?.configs ?? [];
      let readCount = 0;
      for (const f of files) {
        if (!f.exists) continue;
        const res = await client.get(`/api/hnbgw/configs/content?path=${encodeURIComponent(f.path)}`);
        assertOk(res, `GET /api/hnbgw/configs/content (${f.label ?? f.path})`);
        readCount++;
      }
      return pass(`read ${readCount} file(s)`);
    },
  },
  {
    name: 'full virtual HNB lifecycle: remove -> verify gone -> deploy -> verify connected (software-only, no real radio)',
    async run({ client, revertQueue }) {
      const before = await client.get('/api/hnbgw/status');
      if (!before.data?.installedOnDisk || !before.data?.configured) return skip('OsmoHNBGW not installed/configured');
      if (!before.data?.virtualHnbInstalled) return skip('OsmoHNodeB (virtual HNB) not built on this instance — would trigger a real multi-minute first-time build, not attempted here');
      const wasDeployed = before.data?.virtualHnbDeployed === true;

      revertQueue.push('restore virtual HNB deployed state', async () => {
        const current = await client.get('/api/hnbgw/status');
        if (wasDeployed && !current.data?.virtualHnbDeployed) {
          await client.post('/api/hnbgw/virtual-hnb/deploy', {}).catch(() => {});
        } else if (!wasDeployed && current.data?.virtualHnbDeployed) {
          await client.post('/api/hnbgw/virtual-hnb/remove', {}).catch(() => {});
        }
      });

      if (wasDeployed) {
        const removeRes = await client.post('/api/hnbgw/virtual-hnb/remove', {});
        assertOk(removeRes, 'POST /api/hnbgw/virtual-hnb/remove');
        await waitForSettled(client, async () => {
          const s = await client.get('/api/hnbgw/status');
          return s.data?.services?.['osmo-hnodeb'] === false;
        });
      }

      const deployRes = await client.post('/api/hnbgw/virtual-hnb/deploy', {});
      if (deployRes.status !== 200) return fail(`expected HTTP 200 from /virtual-hnb/deploy, got ${deployRes.status}`, deployRes.data);
      await waitForSettled(client, async () => {
        const s = await client.get('/api/hnbgw/status');
        return s.data?.services?.['osmo-hnodeb'] === true;
      });

      // Real bug found and fixed while building this suite: service-active
      // is NOT sufficient — the deployed config can be wrong (or stale,
      // from a since-changed iuhLocalIp) while systemd still happily
      // reports the process running. The real, functional check is whether
      // the HNBGW's own live HNB list shows it actually registered — see
      // this file's header comment and the README's "Real bugs found"
      // entry for the two actual bugs this exposed.
      const after = await client.get('/api/hnbgw/status');
      if (!after.data?.services?.['osmo-hnodeb']) return fail('osmo-hnodeb is not active after /virtual-hnb/deploy', after.data);
      if (!after.data?.hnbListRaw?.includes('1 HNB connected')) {
        return fail('osmo-hnodeb service is active, but the HNBGW\'s own "show hnb all" does not show it connected — a service-active check alone would have missed this', { hnbListRaw: after.data.hnbListRaw });
      }
      if (!wasDeployed) return pass('deployed successfully and confirmed connected (was not previously deployed)');

      return pass('remove -> deploy cycle verified; osmo-hnodeb active AND genuinely re-registered with the real HNBGW', { hnbListRaw: after.data.hnbListRaw });
    },
  },
];
