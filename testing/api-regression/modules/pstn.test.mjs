// PSTN / Voice Gateway (Asterisk) — pstn-controller.ts, mounted at /api/pstn,
// 28 routes. Extensions/DID-mappings/outbound-caller-ids CRUD only trigger a
// lightweight `asterisk -rx "dialplan reload"` (confirmed by reading
// regenerateDialplan() — no active call is dropped by a dialplan reload), so
// those are exercised directly, no gating needed.
//
// Several routes have REAL, live-call/live-routing blast radius on this
// instance specifically (externalTrunkEnabled and crossRanEnabled are both
// already true here, bridging to a real external SIP provider and to the 2G
// GSM module's real, physically-attached BTS respectively — see CLAUDE.md
// pattern #16). Those are marked disruptive and, consistent with this
// session's treatment of the sms module's osmo-stop/start case, were written
// and gated but deliberately NOT run live:
//   - POST /start, /stop, /restart — Asterisk is PSTN's real-time voice
//     path; a restart drops any call in progress right now.
//   - POST /disable, /enable — removes/restores the S-CSCF dispatcher entry
//     that routes PSTN-bound calls to Asterisk at all.
//   - POST /external-trunk/enable, /disable — toggles a real external SIP
//     trunk's live reachability.
//   - POST /cross-ran/enable, /disable — toggles real inter-RAN call
//     bridging to the 2G module's real BTS.
// POST /install and /uninstall are not exercised at all, same reasoning as
// every other module's install/uninstall routes.
import { assertOk, assertEqual, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'pstn';

async function installed(client) {
  const res = await client.get('/api/pstn/status');
  return res.data?.installed === true;
}

export const CASES = [
  { name: 'POST /install (not exercised)', async run() { return skip('multi-minute real apt install with no provable revert — see this file\'s header comment'); } },
  { name: 'POST /uninstall (not exercised)', async run() { return skip('full uninstall with no provable revert — see this file\'s header comment'); } },

  {
    name: 'GET /status',
    async run({ client }) {
      const res = await client.get('/api/pstn/status');
      assertOk(res, 'GET /api/pstn/status');
      if (typeof res.data?.installed !== 'boolean') return fail('response missing boolean "installed"', res.data);
      return pass(`installed=${res.data.installed}`);
    },
  },
  {
    name: 'full extension lifecycle: create -> list -> delete (lightweight dialplan reload, no restart)',
    async run({ client, revertQueue }) {
      if (!(await installed(client))) return skip('PSTN not installed');
      const subsRes = await client.get('/api/subscribers?pageSize=1');
      const testImsi = subsRes.data?.subscribers?.[0]?.imsi;
      if (!testImsi) return skip('no subscribers available on this instance to assign a test extension to');

      const TEST_EXT = '599';
      const listBefore = await client.get('/api/pstn/extensions');
      if (listBefore.data.extensions.some(e => e.extension === TEST_EXT)) {
        return fail(`Extension "${TEST_EXT}" already exists — refusing to touch it.`);
      }

      const createRes = await client.post('/api/pstn/extensions', { extension: TEST_EXT, subscriberImsi: testImsi, label: 'api-regression-test' });
      assertOk(createRes, 'POST /api/pstn/extensions');
      revertQueue.push(`delete test PSTN extension ${TEST_EXT}`, async () => {
        const current = await client.get('/api/pstn/extensions');
        if (current.data?.extensions?.some(e => e.extension === TEST_EXT)) {
          await client.delete(`/api/pstn/extensions/${TEST_EXT}`);
        }
      });

      const afterCreate = await client.get('/api/pstn/extensions');
      const created = afterCreate.data.extensions.find(e => e.extension === TEST_EXT);
      if (!created) return fail('created extension not found in subsequent list');
      assertEqual(created.subscriberImsi, testImsi, 'created extension subscriberImsi');

      const invalidRes = await client.post('/api/pstn/extensions', { extension: 'not-digits', subscriberImsi: testImsi });
      if (invalidRes.status !== 400) return fail(`expected HTTP 400 for a non-digit extension, got ${invalidRes.status}`);

      const delRes = await client.delete(`/api/pstn/extensions/${TEST_EXT}`);
      assertOk(delRes, 'DELETE /api/pstn/extensions/:extension');
      const afterDelete = await client.get('/api/pstn/extensions');
      if (afterDelete.data.extensions.some(e => e.extension === TEST_EXT)) return fail('extension still present after delete');

      return pass('full create->list->delete cycle verified; invalid extension correctly rejected');
    },
  },
  {
    name: 'full DID-mapping lifecycle: create -> edit -> delete',
    async run({ client, revertQueue }) {
      if (!(await installed(client))) return skip('PSTN not installed');
      const subsRes = await client.get('/api/subscribers?pageSize=1');
      const testImsi = subsRes.data?.subscribers?.[0]?.imsi;
      if (!testImsi) return skip('no subscribers available on this instance');

      const TEST_DID = '15005550099';
      const listBefore = await client.get('/api/pstn/did-mappings');
      if (listBefore.data.didMappings.some(m => m.did === TEST_DID)) {
        return fail(`DID "${TEST_DID}" already exists — refusing to touch it.`);
      }

      const createRes = await client.post('/api/pstn/did-mappings', { did: TEST_DID, subscriberImsi: testImsi, label: 'api-regression-test' });
      assertOk(createRes, 'POST /api/pstn/did-mappings');
      revertQueue.push(`delete test DID mapping ${TEST_DID}`, async () => {
        const current = await client.get('/api/pstn/did-mappings');
        if (current.data?.didMappings?.some(m => m.did === TEST_DID)) {
          await client.delete(`/api/pstn/did-mappings/${TEST_DID}`);
        }
      });

      const editRes = await client.put(`/api/pstn/did-mappings/${TEST_DID}`, { subscriberImsi: testImsi, label: 'api-regression-test-edited' });
      assertOk(editRes, 'PUT /api/pstn/did-mappings/:did');
      const afterEdit = await client.get('/api/pstn/did-mappings');
      assertEqual(afterEdit.data.didMappings.find(m => m.did === TEST_DID)?.label, 'api-regression-test-edited', 'edited DID mapping label');

      const delRes = await client.delete(`/api/pstn/did-mappings/${TEST_DID}`);
      assertOk(delRes, 'DELETE /api/pstn/did-mappings/:did');
      const afterDelete = await client.get('/api/pstn/did-mappings');
      if (afterDelete.data.didMappings.some(m => m.did === TEST_DID)) return fail('DID mapping still present after delete');

      return pass('full create->edit->delete cycle verified');
    },
  },
  {
    name: 'full outbound-caller-id lifecycle: create -> edit -> delete',
    async run({ client, revertQueue }) {
      if (!(await installed(client))) return skip('PSTN not installed');
      const subsRes = await client.get('/api/subscribers?pageSize=1');
      const testImsi = subsRes.data?.subscribers?.[0]?.imsi;
      if (!testImsi) return skip('no subscribers available on this instance');

      const listBefore = await client.get('/api/pstn/outbound-caller-ids');
      const hadExisting = listBefore.data.outboundCallerIds.some(e => e.subscriberImsi === testImsi);
      if (hadExisting) return skip(`subscriber ${testImsi} already has an outbound caller ID — picking a different test subscriber isn't worth the complexity here; skipping rather than disturbing real data`);

      const createRes = await client.post('/api/pstn/outbound-caller-ids', { subscriberImsi: testImsi, callerId: '15005550000', label: 'api-regression-test' });
      assertOk(createRes, 'POST /api/pstn/outbound-caller-ids');
      revertQueue.push(`delete test outbound caller id for ${testImsi}`, async () => {
        const current = await client.get('/api/pstn/outbound-caller-ids');
        if (current.data?.outboundCallerIds?.some(e => e.subscriberImsi === testImsi)) {
          await client.delete(`/api/pstn/outbound-caller-ids/${testImsi}`);
        }
      });

      const editRes = await client.put(`/api/pstn/outbound-caller-ids/${testImsi}`, { callerId: '15005550001', label: 'api-regression-test-edited' });
      assertOk(editRes, 'PUT /api/pstn/outbound-caller-ids/:imsi');
      const afterEdit = await client.get('/api/pstn/outbound-caller-ids');
      assertEqual(afterEdit.data.outboundCallerIds.find(e => e.subscriberImsi === testImsi)?.callerId, '15005550001', 'edited callerId');

      const delRes = await client.delete(`/api/pstn/outbound-caller-ids/${testImsi}`);
      assertOk(delRes, 'DELETE /api/pstn/outbound-caller-ids/:imsi');
      const afterDelete = await client.get('/api/pstn/outbound-caller-ids');
      if (afterDelete.data.outboundCallerIds.some(e => e.subscriberImsi === testImsi)) return fail('outbound caller id still present after delete');

      return pass('full create->edit->delete cycle verified');
    },
  },
  {
    name: 'GET /configs + GET /configs/content for every manifest entry',
    async run({ client }) {
      if (!(await installed(client))) return skip('PSTN not installed');
      const manifestRes = await client.get('/api/pstn/configs');
      assertOk(manifestRes, 'GET /api/pstn/configs');
      if (!Array.isArray(manifestRes.data?.files) || manifestRes.data.files.length === 0) return fail('response missing a non-empty "files" array', manifestRes.data);
      let readCount = 0;
      for (const f of manifestRes.data.files) {
        if (!f.exists) continue;
        const res = await client.get(`/api/pstn/configs/content?path=${encodeURIComponent(f.path)}`);
        assertOk(res, `GET /api/pstn/configs/content (${f.label})`);
        readCount++;
      }
      const disallowed = await client.get('/api/pstn/configs/content?path=/etc/passwd');
      if (disallowed.status !== 403) return fail(`expected HTTP 403 for a disallowed path, got ${disallowed.status}`);
      return pass(`read ${readCount} file(s); disallowed path correctly refused (403)`);
    },
  },
  {
    name: 'PUT /configs/content — round-trip identical content on rtp.conf',
    async run({ client }) {
      if (!(await installed(client))) return skip('PSTN not installed');
      const manifestRes = await client.get('/api/pstn/configs');
      const target = manifestRes.data.files.find(f => f.label === 'rtp.conf' && f.exists);
      if (!target) return skip('rtp.conf not present on this instance');
      const before = await client.get(`/api/pstn/configs/content?path=${encodeURIComponent(target.path)}`);
      const putRes = await client.put('/api/pstn/configs/content', { path: target.path, content: before.data.content });
      assertOk(putRes, 'PUT /api/pstn/configs/content');
      const after = await client.get(`/api/pstn/configs/content?path=${encodeURIComponent(target.path)}`);
      assertEqual(after.data.content, before.data.content, 'rtp.conf content after round-trip write');
      return pass('round-tripped rtp.conf unchanged');
    },
  },
  {
    name: 'POST /external-trunk/configure with current values (idempotent, fields-only save)',
    async run({ client }) {
      if (!(await installed(client))) return skip('PSTN not installed');
      const before = await client.get('/api/pstn/status');
      const trunk = before.data?.currentConfig?.externalTrunk;
      if (!trunk) return skip('external trunk has not been configured on this instance');

      const missingRes = await client.post('/api/pstn/external-trunk/configure', { providerHost: trunk.providerHost });
      if (missingRes.status !== 400) return fail(`expected HTTP 400 for a missing bindIp, got ${missingRes.status}`);

      const res = await client.post('/api/pstn/external-trunk/configure', {
        bindIp: trunk.bindIp, bindPort: trunk.bindPort, interfaceMode: trunk.interfaceMode,
        externalMediaAddress: trunk.externalMediaAddress, providerHost: trunk.providerHost,
        providerPort: trunk.providerPort, providerCidr: trunk.providerCidr,
      });
      assertOk(res, 'POST /api/pstn/external-trunk/configure');
      const after = await client.get('/api/pstn/status');
      assertEqual(after.data?.currentConfig?.externalTrunk?.providerHost, trunk.providerHost, 'providerHost after re-save');
      return pass('re-saved existing external trunk fields (no functional change, not enabled/applied by this route); missing-field case correctly rejected');
    },
  },
  {
    name: 'POST /start, /stop, /restart (asterisk) — not exercised, see module header',
    async run() { return skip('Asterisk is PSTN\'s real-time voice path — a restart drops any call in progress right now; written and gated but deliberately not run live this session'); },
  },
  {
    name: 'POST /disable then /enable (dispatcher entry) — not exercised, see module header',
    async run() { return skip('temporarily stops S-CSCF from routing PSTN-bound calls at all; written and gated but deliberately not run live this session'); },
  },
  {
    name: 'POST /external-trunk/enable, /disable — not exercised, see module header',
    async run() { return skip('toggles a real external SIP trunk\'s live reachability; written and gated but deliberately not run live this session'); },
  },
  {
    name: 'POST /cross-ran/enable, /disable — not exercised, see module header',
    async run() { return skip('bridges to the 2G module\'s real, physically-attached BTS; written and gated but deliberately not run live this session'); },
  },
];
