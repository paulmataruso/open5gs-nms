// DNS/BIND9 — bind-controller.ts, mounted at /api/bind, 15 routes. BIND is
// shared infrastructure across IMS/VoWiFi/DNS Migration (CLAUDE.md pattern
// #4) — forwarders/listen-on/repair/fix-resolver are all designed to be
// safely callable anytime (repair's own doc comment: "Safe to call anytime
// — a no-op if nothing needs fixing"; this instance's current status
// already shows a healthy, non-bypassing resolver, so fix-resolver is
// exercised as the same kind of safe idempotent reassertion). forwarders/
// listen-on PUTs restart bind9 — a brief DNS blip, not a core-NF restart,
// same risk tier this suite already applies to twamp-server/mms/vowifi's
// own non-core-NF service restarts.
//
// NOT exercised: POST /install, DELETE /files (deletes a real zone file
// with no revert), POST /start (only relevant if bind9 isn't running,
// which it currently is).
import { assertOk, assertEqual, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'bind';

async function waitForSettled(client, timeoutMs = 20000, settleMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await client.get('/api/bind/status');
    if (s.data?.running === true) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  await new Promise(r => setTimeout(r, settleMs));
}

export const CASES = [
  { name: 'POST /install, DELETE /files (not exercised)', async run() { return skip('install is a real apt install with no provable revert; DELETE /files removes a real zone file with no revert'); } },

  {
    name: 'GET /status',
    async run({ client }) {
      const res = await client.get('/api/bind/status');
      assertOk(res, 'GET /api/bind/status');
      if (typeof res.data?.installed !== 'boolean') return fail('response missing boolean "installed"', res.data);
      return pass(`installed=${res.data.installed} running=${res.data.running} fileCount=${res.data.fileCount}`);
    },
  },
  {
    name: 'full forwarders cycle: read -> edit -> validate -> revert',
    async run({ client, revertQueue }) {
      const statusRes = await client.get('/api/bind/status');
      if (!statusRes.data?.installed) return skip('BIND not installed');
      const before = await client.get('/api/bind/forwarders');
      const original = before.data.forwarders;

      revertQueue.push('revert bind forwarders', async () => {
        await client.put('/api/bind/forwarders', { forwarders: original });
        await waitForSettled(client);
      });

      const invalidRes = await client.put('/api/bind/forwarders', { forwarders: ['not-an-ip'] });
      if (invalidRes.status !== 400) return fail(`expected HTTP 400 for an invalid forwarder, got ${invalidRes.status}`);

      const testValue = ['1.1.1.1', '9.9.9.9'];
      const putRes = await client.put('/api/bind/forwarders', { forwarders: testValue });
      assertOk(putRes, 'PUT /api/bind/forwarders');
      await waitForSettled(client);
      const afterSet = await client.get('/api/bind/forwarders');
      assertEqual(JSON.stringify(afterSet.data.forwarders), JSON.stringify(testValue), 'forwarders after set');

      const revertRes = await client.put('/api/bind/forwarders', { forwarders: original });
      assertOk(revertRes, 'PUT /api/bind/forwarders (revert)');
      await waitForSettled(client);
      const afterRevert = await client.get('/api/bind/forwarders');
      assertEqual(JSON.stringify(afterRevert.data.forwarders), JSON.stringify(original), 'forwarders after revert');

      return pass(`toggled [${original}] -> [${testValue}] -> [${original}]; invalid forwarder correctly rejected`);
    },
  },
  {
    name: 'full listen-on cycle: read -> edit (add a test IP) -> revert',
    async run({ client, revertQueue }) {
      const statusRes = await client.get('/api/bind/status');
      if (!statusRes.data?.installed) return skip('BIND not installed');
      const before = await client.get('/api/bind/listen-on');
      const original = before.data.listenOn;

      revertQueue.push('revert bind listen-on', async () => {
        await client.put('/api/bind/listen-on', { listenOn: original });
        await waitForSettled(client);
      });

      // RFC 5737 TEST-NET address — a real, syntactically valid IPv4 BIND
      // will happily accept adding to its listen-on set, but one that
      // doesn't correspond to any real interface on this host, so adding
      // it has no functional effect (BIND just won't actually bind there).
      const testValue = [...original, '192.0.2.53'];
      const putRes = await client.put('/api/bind/listen-on', { listenOn: testValue });
      assertOk(putRes, 'PUT /api/bind/listen-on');
      await waitForSettled(client);
      const afterSet = await client.get('/api/bind/listen-on');
      if (!afterSet.data.listenOn.includes('192.0.2.53')) return fail('test IP not present after set');

      const revertRes = await client.put('/api/bind/listen-on', { listenOn: original });
      assertOk(revertRes, 'PUT /api/bind/listen-on (revert)');
      await waitForSettled(client);
      const afterRevert = await client.get('/api/bind/listen-on');
      assertEqual(JSON.stringify(afterRevert.data.listenOn), JSON.stringify(original), 'listen-on after revert');

      return pass(`added and reverted a test-only IP; final state matches original [${original}]`);
    },
  },
  {
    name: 'POST /repair (designed to be safe anytime, no-op if healthy)',
    async run({ client }) {
      const statusRes = await client.get('/api/bind/status');
      if (!statusRes.data?.installed) return skip('BIND not installed');
      const res = await client.post('/api/bind/repair', {});
      assertOk(res, 'POST /api/bind/repair');
      if (!Array.isArray(res.data?.zonesRepaired)) return fail('response missing "zonesRepaired" array', res.data);
      return pass(`repaired ${res.data.zonesRepaired.length} zone(s)`);
    },
  },
  {
    name: 'POST /fix-resolver (resolv.conf already correctly points at BIND on this instance — exercised as the same idempotent reassertion /repair is)',
    async run({ client }) {
      const statusRes = await client.get('/api/bind/status');
      if (!statusRes.data?.installed) return skip('BIND not installed');
      if (statusRes.data?.resolvConfBypassesBind) {
        return skip('resolv.conf is currently bypassing BIND — not flipping host-wide DNS resolution behavior in an automated test; this is the one state where /fix-resolver is NOT idempotent to call blind');
      }
      const res = await client.post('/api/bind/fix-resolver', {});
      assertOk(res, 'POST /api/bind/fix-resolver');
      const after = await client.get('/api/bind/status');
      if (after.data?.resolvConfBypassesBind) return fail('resolvConfBypassesBind became true after calling fix-resolver');
      return pass('resolver reasserted; still correctly pointing at BIND afterward');
    },
  },
  {
    name: 'GET /files + GET /files/content (read-only)',
    async run({ client }) {
      const statusRes = await client.get('/api/bind/status');
      if (!statusRes.data?.installed) return skip('BIND not installed');
      const manifestRes = await client.get('/api/bind/files');
      assertOk(manifestRes, 'GET /api/bind/files');
      if (!Array.isArray(manifestRes.data?.files)) return fail('response missing "files" array', manifestRes.data);
      let readCount = 0;
      for (const f of manifestRes.data.files.slice(0, 5)) {
        const res = await client.get(`/api/bind/files/content?path=${encodeURIComponent(f.path)}`);
        assertOk(res, `GET /api/bind/files/content (${f.label})`);
        readCount++;
      }
      return pass(`read ${readCount} of ${manifestRes.data.files.length} file(s)`);
    },
  },
];
