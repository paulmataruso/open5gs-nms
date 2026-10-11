// RAN Kill Switches — 4 near-identical controllers (radio-block [4G],
// gnb-block [5G], hnb-block [3G], ue-block [per-subscriber]), each a thin
// nftables-rule-management wrapper: GET list, POST /:key block, DELETE
// /:key unblock. Tested against deliberately fake targets, never a real
// connected radio/subscriber:
//   - radio-block/gnb-block/hnb-block: 192.0.2.99, from the RFC 5737
//     TEST-NET-1 block reserved for documentation/testing — guaranteed to
//     never be a real routable radio on any real network. Blocking it adds
//     a real nftables rule that matches nothing (zero real-world impact);
//     unblocking removes it. This exercises the real block/unblock
//     mechanism end-to-end without ever touching a real device.
//   - ue-block: a throwaway IMSI in the unused 999-70 test-PLMN range
//     (never a real attached subscriber) — the block route's own detach
//     attempt fails gracefully ("not currently attached"), same as it
//     would in production for an IMSI that isn't live right now, and the
//     persistent nftables block is equally inert for a nonexistent IMSI.
//
// POST /radio-block/all and /gnb-block/all are NOT exercised — they
// unconditionally block EVERY currently-connected real radio of that
// generation (read from the live S1-MME/NGAP connection list), with no way
// to scope them to a fake target the way the single-IP routes allow.
// POST /ue-block/install is NOT exercised, same reasoning as every other
// module's /install route.
import { assertOk, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'ran-kill-switches';

const TEST_IP = '192.0.2.99';
const TEST_IMSI = '999700000099998';

function blockCycleCase(label, basePath, keyField) {
  return {
    name: `${label}: block -> list -> unblock (test target, never a real radio)`,
    async run({ client, revertQueue }) {
      const key = keyField === 'ip' ? TEST_IP : TEST_IMSI;
      const listBefore = await client.get(`${basePath}/`);
      assertOk(listBefore, `GET ${basePath}/`);
      const alreadyThere = Array.isArray(listBefore.data) ? listBefore.data.some(e => (e.ip ?? e.imsi) === key)
        : listBefore.data?.blocked?.some?.(e => (e.ip ?? e.imsi) === key);
      if (alreadyThere) return fail(`test target ${key} is already blocked on ${label} — refusing to touch it`);

      const blockRes = await client.post(`${basePath}/${encodeURIComponent(key)}`, {});
      assertOk(blockRes, `POST ${basePath}/:key`);
      revertQueue.push(`unblock ${label} test target ${key}`, async () => {
        await client.delete(`${basePath}/${encodeURIComponent(key)}`).catch(() => {});
      });

      const listAfterBlock = await client.get(`${basePath}/`);
      const nowBlocked = Array.isArray(listAfterBlock.data) ? listAfterBlock.data.some(e => (e.ip ?? e.imsi) === key)
        : listAfterBlock.data?.blocked?.some?.(e => (e.ip ?? e.imsi) === key);
      if (!nowBlocked) return fail(`${key} not found in the blocked list immediately after block`);

      const unblockRes = await client.delete(`${basePath}/${encodeURIComponent(key)}`);
      assertOk(unblockRes, `DELETE ${basePath}/:key`);
      const listAfterUnblock = await client.get(`${basePath}/`);
      const stillBlocked = Array.isArray(listAfterUnblock.data) ? listAfterUnblock.data.some(e => (e.ip ?? e.imsi) === key)
        : listAfterUnblock.data?.blocked?.some?.(e => (e.ip ?? e.imsi) === key);
      if (stillBlocked) return fail(`${key} still present in the blocked list after unblock`);

      return pass(`block -> list -> unblock cycle verified for ${label} against test target ${key}`);
    },
  };
}

export const CASES = [
  { name: 'POST /radio-block/all, /gnb-block/all (not exercised)', async run() { return skip('unconditionally blocks EVERY currently-connected real radio of that generation — see this file\'s header comment'); } },
  { name: 'POST /ue-block/install (not exercised)', async run() { return skip('real build with no provable revert — see this file\'s header comment'); } },

  { name: 'GET /radio-block, /gnb-block, /hnb-block, /ue-block (read-only)', async run({ client }) {
    const paths = ['/api/radio-block/', '/api/gnb-block/', '/api/hnb-block/', '/api/ue-block/'];
    const counts = [];
    for (const p of paths) {
      const res = await client.get(p);
      assertOk(res, `GET ${p}`);
      const list = Array.isArray(res.data) ? res.data : res.data?.blocked ?? [];
      counts.push(`${p}:${list.length}`);
    }
    return pass(counts.join(' '));
  } },

  blockCycleCase('radio-block (4G)', '/api/radio-block', 'ip'),
  blockCycleCase('gnb-block (5G)', '/api/gnb-block', 'ip'),
  blockCycleCase('hnb-block (3G)', '/api/hnb-block', 'ip'),
  blockCycleCase('ue-block (per-subscriber)', '/api/ue-block', 'imsi'),

  { name: 'GET /ue-block/status', async run({ client }) {
    const res = await client.get('/api/ue-block/status');
    assertOk(res, 'GET /api/ue-block/status');
    if (typeof res.data?.built !== 'boolean') return fail('response missing boolean "built"', res.data);
    return pass(`built=${res.data.built}`);
  } },

  { name: 'invalid IPv4 / IMSI is rejected (400), not silently accepted', async run({ client }) {
    const badIp = await client.post('/api/radio-block/not-an-ip', {});
    if (badIp.status !== 400) return fail(`expected HTTP 400 for an invalid IPv4, got ${badIp.status}`);
    const badImsi = await client.post('/api/ue-block/abc', {});
    if (badImsi.status !== 400) return fail(`expected HTTP 400 for an invalid IMSI, got ${badImsi.status}`);
    return pass('both invalid inputs correctly rejected (400)');
  } },
];
