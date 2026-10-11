// Asterisk-2G (2G Voice) — asterisk-2g-controller.ts, mounted at
// /api/asterisk-2g, 14 routes. This is a real-time voice path for the 2G
// GSM module's real, physically-attached BTS — /configure wires the SIP
// connector + MNCC mode (core 2G voice setup), and /start/stop/restart
// restart the real-time Asterisk instance a live 2G call could be using
// right now, so none of those are exercised. Extensions CRUD is safe (a
// lightweight dialplan reload only, confirmed by reading the source — same
// mechanism as pstn.test.mjs's own extensions lifecycle), as is the
// read-only config editor.
import { assertOk, assertEqual, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'asterisk-2g';

export const CASES = [
  { name: 'POST /install, /configure, /start, /stop, /restart, /configs/restart, /uninstall (not exercised)', async run() { return skip('real-time 2G voice path a live call could be using right now, or core SIP/MNCC setup — see this file\'s header comment'); } },

  {
    name: 'GET /status',
    async run({ client }) {
      const res = await client.get('/api/asterisk-2g/status');
      assertOk(res, 'GET /api/asterisk-2g/status');
      if (typeof res.data?.installed !== 'boolean') return fail('response missing boolean "installed"', res.data);
      return pass(`installed=${res.data.installed} serviceActive=${res.data.serviceActive}`);
    },
  },
  {
    name: 'full extension lifecycle: create -> list -> delete (lightweight dialplan reload, no restart)',
    async run({ client, revertQueue }) {
      const statusRes = await client.get('/api/asterisk-2g/status');
      if (!statusRes.data?.installed) return skip('Asterisk-2G not installed');
      const gsmSubsRes = await client.get('/api/gsm/subscribers');
      const testImsi = gsmSubsRes.data?.subscribers?.[0]?.imsi;
      if (!testImsi) return skip('no 2G/3G-Auth-enabled subscribers available on this instance');

      const TEST_EXT = '5959';
      const listBefore = await client.get('/api/asterisk-2g/extensions');
      if (listBefore.data.extensions.some(e => e.extension === TEST_EXT)) {
        return fail(`Extension "${TEST_EXT}" already exists — refusing to touch it.`);
      }

      const createRes = await client.post('/api/asterisk-2g/extensions', { extension: TEST_EXT, subscriberImsi: testImsi, label: 'api-regression-test' });
      assertOk(createRes, 'POST /api/asterisk-2g/extensions');
      revertQueue.push(`delete test asterisk-2g extension ${TEST_EXT}`, async () => {
        const current = await client.get('/api/asterisk-2g/extensions');
        if (current.data?.extensions?.some(e => e.extension === TEST_EXT)) {
          await client.delete(`/api/asterisk-2g/extensions/${TEST_EXT}`);
        }
      });

      const afterCreate = await client.get('/api/asterisk-2g/extensions');
      const created = afterCreate.data.extensions.find(e => e.extension === TEST_EXT);
      if (!created) return fail('created extension not found in subsequent list');
      assertEqual(created.subscriberImsi, testImsi, 'created extension subscriberImsi');

      const delRes = await client.delete(`/api/asterisk-2g/extensions/${TEST_EXT}`);
      assertOk(delRes, 'DELETE /api/asterisk-2g/extensions/:extension');
      const afterDelete = await client.get('/api/asterisk-2g/extensions');
      if (afterDelete.data.extensions.some(e => e.extension === TEST_EXT)) return fail('extension still present after delete');

      return pass('full create->list->delete cycle verified');
    },
  },
  {
    name: 'GET /configs + GET /configs/content, and a safe round-trip write',
    async run({ client }) {
      const statusRes = await client.get('/api/asterisk-2g/status');
      if (!statusRes.data?.installed) return skip('Asterisk-2G not installed');
      const manifestRes = await client.get('/api/asterisk-2g/configs');
      assertOk(manifestRes, 'GET /api/asterisk-2g/configs');
      if (!Array.isArray(manifestRes.data?.files)) return fail('response missing "files" array', manifestRes.data);
      let readCount = 0;
      for (const f of manifestRes.data.files) {
        if (!f.exists) continue;
        const res = await client.get(`/api/asterisk-2g/configs/content?path=${encodeURIComponent(f.path)}`);
        assertOk(res, `GET /api/asterisk-2g/configs/content (${f.label})`);
        readCount++;
      }

      const target = manifestRes.data.files.find(f => f.label === 'asterisk.conf' && f.exists);
      if (target) {
        const before = await client.get(`/api/asterisk-2g/configs/content?path=${encodeURIComponent(target.path)}`);
        const putRes = await client.put('/api/asterisk-2g/configs/content', { path: target.path, content: before.data.content });
        assertOk(putRes, 'PUT /api/asterisk-2g/configs/content');
        const after = await client.get(`/api/asterisk-2g/configs/content?path=${encodeURIComponent(target.path)}`);
        assertEqual(after.data.content, before.data.content, 'asterisk.conf content after round-trip write');
      }

      return pass(`read ${readCount} file(s)${target ? '; round-tripped asterisk.conf unchanged' : ''}`);
    },
  },
];
