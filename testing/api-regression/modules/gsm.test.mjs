// 2G GSM (Osmocom) — gsm-controller.ts, mounted at /api/gsm, 30 routes.
// This is REAL, physically-transmitting RF hardware (a real nanoBTS on
// this deployment) with a documented history of real, hard-to-predict
// failure modes (see CLAUDE.md's 2G GSM entries — a BTS lock/unblock bug
// that silently never worked for the module's entire history, TCH
// assignment failures that looked like hardware but were a codec-config
// bug, etc.). Scoped to read-only routes only, consistent with this
// suite's treatment of every other real-radio-hardware module (genieacs,
// secgw, sercomm-nr).
//
// NOT exercised: /install, /configure, all of /sip/* (osmo-sip-connector
// lifecycle + MNCC mode — affects live 2G voice call routing), /discover,
// POST/PUT/DELETE /bts (creates/edits/removes real BTS config and restarts
// osmo-bsc, dropping the real BTS's connection), /bts/:id/provision
// (pushes OML config to the real unit), /bts/:id/restart, /bts/:id/block,
// /unblock, /block-all (real RF/service impact — see CLAUDE.md's RAN Kill
// Switches entry on why 2G blocking is treated as a different risk tier
// than 4G/5G/3G), DELETE /bts/:id, /start, /stop, /restart, PUT
// /configs/content, /configs/restart, /uninstall.
import { assertOk, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'gsm';

export const CASES = [
  { name: 'All mutating routes (not exercised)', async run() { return skip('real, physically-transmitting RF hardware with a documented history of hard-to-predict real failure modes — see this file\'s header comment'); } },

  {
    name: 'GET /status',
    async run({ client }) {
      const res = await client.get('/api/gsm/status');
      assertOk(res, 'GET /api/gsm/status');
      if (typeof res.data?.installedOnDisk !== 'boolean') return fail('response missing boolean "installedOnDisk"', res.data);
      return pass(`installedOnDisk=${res.data.installedOnDisk} configured=${res.data.configured}`);
    },
  },
  {
    name: 'GET /subscribers, /signal/overview, /signal/history, /pdp-contexts (read-only)',
    async run({ client }) {
      const subsRes = await client.get('/api/gsm/subscribers');
      assertOk(subsRes, 'GET /api/gsm/subscribers');
      const sigRes = await client.get('/api/gsm/signal/overview');
      assertOk(sigRes, 'GET /api/gsm/signal/overview');

      const invalidHistRes = await client.get('/api/gsm/signal/history?imsi=not-numeric');
      if (invalidHistRes.status !== 400) return fail(`expected HTTP 400 for a non-numeric imsi, got ${invalidHistRes.status}`);
      const testImsi = subsRes.data?.subscribers?.[0]?.imsi;
      if (testImsi) {
        const histRes = await client.get(`/api/gsm/signal/history?imsi=${testImsi}`);
        assertOk(histRes, 'GET /api/gsm/signal/history');
      }
      const pdpRes = await client.get('/api/gsm/pdp-contexts');
      assertOk(pdpRes, 'GET /api/gsm/pdp-contexts');
      return pass(`${subsRes.data?.subscribers?.length ?? 0} subscriber(s), ${pdpRes.data?.contexts?.length ?? 0} PDP context(s)`);
    },
  },
  {
    name: 'GET /bts and /bts/:id/link-status (read-only)',
    async run({ client }) {
      const res = await client.get('/api/gsm/bts');
      assertOk(res, 'GET /api/gsm/bts');
      if (!Array.isArray(res.data?.btsEntries)) return fail('response missing "btsEntries" array', res.data);
      if (res.data.btsEntries.length === 0) return pass('0 BTS entries configured');
      const bts = res.data.btsEntries[0];
      const linkRes = await client.get(`/api/gsm/bts/${bts.id}/link-status`);
      assertOk(linkRes, 'GET /api/gsm/bts/:id/link-status');
      return pass(`${res.data.btsEntries.length} BTS entrie(s); link-status read for "${bts.name}"`);
    },
  },
  {
    name: 'GET /configs + GET /configs/content (read-only)',
    async run({ client }) {
      const manifestRes = await client.get('/api/gsm/configs');
      assertOk(manifestRes, 'GET /api/gsm/configs');
      if (!Array.isArray(manifestRes.data?.files)) return fail('response missing "files" array', manifestRes.data);
      let readCount = 0;
      for (const f of manifestRes.data.files) {
        if (!f.exists) continue;
        const res = await client.get(`/api/gsm/configs/content?path=${encodeURIComponent(f.path)}`);
        assertOk(res, `GET /api/gsm/configs/content (${f.label})`);
        readCount++;
      }
      return pass(`read ${readCount} file(s)`);
    },
  },
];
