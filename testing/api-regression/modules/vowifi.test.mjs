// VoWiFi (ePDG) — vowifi-controller.ts, mounted at /api/vowifi, 10 routes.
// Unlike IMS/SMS/PSTN's config editors, EVERY entry in this module's config
// manifest restarts something on a bare PUT (no separate "write only, restart
// later" step) — two of the six entries (smf.conf's S6b peer, hss.conf's Swx
// peer) restart open5gs-smfd/open5gs-hssd, both core-17 NFs. Those two, plus
// /configure (which also restarts open5gs-smfd), are gated disruptive and
// NOT exercised live this session, same treatment as every other core-17-NF
// -restarting route in this suite. The remaining four manifest entries only
// restart VoWiFi's own VectorCore ePDG/AAA daemons — with activeClients:0 on
// this instance, restarting those (directly, and via /start, /stop,
// /restart) carries no real blast radius right now, so those ARE exercised
// directly.
//
// POST /install and /uninstall are not exercised, same reasoning as every
// other module's install/uninstall routes.
import { assertOk, assertEqual, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'vowifi';

async function installedAndConfigured(client) {
  const res = await client.get('/api/vowifi/status');
  return res.data?.installStatus === 'complete' && res.data?.configured === true;
}
async function waitForSettled(client, checkFn, timeoutMs = 45000, settleMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkFn()) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  await new Promise(r => setTimeout(r, settleMs));
}

export const CASES = [
  { name: 'POST /install (not exercised)', async run() { return skip('multi-minute real build with no provable revert — see this file\'s header comment'); } },
  { name: 'POST /uninstall (not exercised)', async run() { return skip('full uninstall with no provable revert — see this file\'s header comment'); } },
  { name: 'POST /configure (not exercised)', async run() { return skip('restarts open5gs-smfd, a core-17 NF — see this file\'s header comment'); } },
  { name: 'PUT /configs/content on smf.conf / hss.conf (not exercised)', async run() { return skip('both restart a core-17 NF (open5gs-smfd / open5gs-hssd) unconditionally on write, unlike every other module\'s config editor — see this file\'s header comment'); } },

  {
    name: 'GET /status',
    async run({ client }) {
      const res = await client.get('/api/vowifi/status');
      assertOk(res, 'GET /api/vowifi/status');
      if (typeof res.data?.installStatus !== 'string') return fail('response missing string "installStatus"', res.data);
      return pass(`installStatus=${res.data.installStatus} configured=${res.data.configured}`);
    },
  },
  {
    name: 'GET /configs manifest',
    async run({ client }) {
      const res = await client.get('/api/vowifi/configs');
      assertOk(res, 'GET /api/vowifi/configs');
      if (!Array.isArray(res.data?.configs) || res.data.configs.length !== 6) return fail('expected a 6-entry manifest', res.data);
      return pass(`${res.data.configs.length} manifest entries`);
    },
  },
  {
    name: 'GET /configs/content for every existing manifest entry + disallowed path check',
    async run({ client }) {
      const manifestRes = await client.get('/api/vowifi/configs');
      let readCount = 0;
      for (const f of manifestRes.data.configs) {
        if (!f.exists) continue;
        const res = await client.get(`/api/vowifi/configs/content?path=${encodeURIComponent(f.path)}`);
        assertOk(res, `GET /api/vowifi/configs/content (${f.label})`);
        readCount++;
      }
      const disallowed = await client.get('/api/vowifi/configs/content?path=/etc/passwd');
      if (disallowed.status !== 400) return fail(`expected HTTP 400 for a disallowed path, got ${disallowed.status}`);
      return pass(`read ${readCount} file(s); disallowed path correctly refused (400)`);
    },
  },
  {
    name: 'PUT /configs/content — round-trip identical content on epdg.yaml (restarts vowifi-vectorcore-epdg only, 0 active clients)',
    async run({ client }) {
      if (!(await installedAndConfigured(client))) return skip('VoWiFi not installed/configured');
      const manifestRes = await client.get('/api/vowifi/configs');
      const target = manifestRes.data.configs.find(f => f.label === 'epdg.yaml' && f.exists);
      if (!target) return skip('epdg.yaml not present on this instance');

      const statusBefore = await client.get('/api/vowifi/status');
      if ((statusBefore.data?.activeClients ?? 0) > 0) return skip(`${statusBefore.data.activeClients} active VoWiFi client(s) right now — skipping to avoid a real session restart`);

      const before = await client.get(`/api/vowifi/configs/content?path=${encodeURIComponent(target.path)}`);
      const putRes = await client.put('/api/vowifi/configs/content', { path: target.path, content: before.data.content });
      assertOk(putRes, 'PUT /api/vowifi/configs/content');
      await waitForSettled(client, async () => {
        const s = await client.get('/api/vowifi/status');
        return s.data?.services?.['vowifi-vectorcore-epdg'] === true;
      });
      const after = await client.get(`/api/vowifi/configs/content?path=${encodeURIComponent(target.path)}`);
      assertEqual(after.data.content, before.data.content, 'epdg.yaml content after round-trip write');
      const statusAfter = await client.get('/api/vowifi/status');
      if (!statusAfter.data?.services?.['vowifi-vectorcore-epdg']) return fail('vowifi-vectorcore-epdg is not active after the round-trip write+restart');
      return pass('round-tripped epdg.yaml unchanged; epdg service active afterward');
    },
  },
  {
    name: 'GET /admin/* (read-only proxy into VectorCore ePDG\'s own API)',
    async run({ client }) {
      if (!(await installedAndConfigured(client))) return skip('VoWiFi not installed/configured');
      const statusRes = await client.get('/api/vowifi/status');
      if (!statusRes.data?.services?.['vowifi-vectorcore-epdg']) return skip('vowifi-vectorcore-epdg is not currently active');
      const res = await client.get('/api/vowifi/admin/api/v1/status');
      if (res.status >= 500 && res.status !== 502) return fail(`unexpected HTTP ${res.status}`, res.data);
      return pass(`HTTP ${res.status}`);
    },
  },
  {
    name: 'POST /stop then /start (VectorCore ePDG + AAA, 0 active clients)',
    async run({ client }) {
      if (!(await installedAndConfigured(client))) return skip('VoWiFi not installed/configured');
      const before = await client.get('/api/vowifi/status');
      if ((before.data?.activeClients ?? 0) > 0) return skip(`${before.data.activeClients} active VoWiFi client(s) right now — skipping to avoid dropping a real session`);
      if (!before.data?.services?.['vowifi-vectorcore-epdg'] || !before.data?.services?.['vowifi-vectorcore-aaa']) {
        return skip('vowifi-vectorcore-epdg/aaa are not both currently active — skipping to avoid an ambiguous pre-existing state');
      }

      const stopRes = await client.post('/api/vowifi/stop', {});
      assertOk(stopRes, 'POST /api/vowifi/stop');
      await waitForSettled(client, async () => {
        const s = await client.get('/api/vowifi/status');
        return s.data?.services?.['vowifi-vectorcore-epdg'] === false && s.data?.services?.['vowifi-vectorcore-aaa'] === false;
      });
      const afterStop = await client.get('/api/vowifi/status');
      if (afterStop.data?.services?.['vowifi-vectorcore-epdg'] || afterStop.data?.services?.['vowifi-vectorcore-aaa']) {
        return fail('service(s) still report active immediately after /stop');
      }

      const startRes = await client.post('/api/vowifi/start', {});
      assertOk(startRes, 'POST /api/vowifi/start');
      await waitForSettled(client, async () => {
        const s = await client.get('/api/vowifi/status');
        return s.data?.services?.['vowifi-vectorcore-epdg'] === true && s.data?.services?.['vowifi-vectorcore-aaa'] === true;
      });
      const afterStart = await client.get('/api/vowifi/status');
      if (!afterStart.data?.services?.['vowifi-vectorcore-epdg'] || !afterStart.data?.services?.['vowifi-vectorcore-aaa']) {
        return fail('service(s) did not come back active after /start', afterStart.data);
      }

      return pass('stop -> start cycle verified; both ePDG and AAA active again');
    },
  },
];
