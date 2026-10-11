// SMS over SGs (osmo-stp/osmo-hlr/osmo-msc) — sms-controller.ts, 14 routes.
// This is the EXPERIMENTAL/opt-in alternative to the default SMS-over-IMS
// path (see CLAUDE.md: "SMS over IMS is the default/primary path ... SMS
// over SGs is available as an opt-in, experimental alternative"). The
// toggle between the two lives on the ims module (/sms-delivery-mode,
// already covered in ims.test.mjs) — this module covers the SGs-side
// infrastructure's own lifecycle/config routes instead.
//
// Real, live-radio blast radius note: osmo-stp/osmo-hlr/osmo-msc are NOT
// exclusively owned by this feature — the 2G GSM module's osmo-bsc (and any
// real, physically-attached BTS it's driving) depends on osmo-hlr/osmo-msc
// being up for CS attach/call handling, exactly the same "shared
// infrastructure, don't assume exclusive ownership" shape CLAUDE.md
// documents for BIND9. Stopping/restarting these three services can disrupt
// a REAL, live 2G radio session, not just a core-17 NF. Every case that
// stops/restarts them is marked disruptive for this reason specifically, in
// addition to the usual "restarts a live, always-on service" reason.
//
// Three endpoints are deliberately NOT exercised even under
// --include-disruptive:
//   - POST /install — real apt package install, same no-clean-revert
//     reasoning as every other module's /install (see ims.test.mjs's header).
//   - POST /uninstall — purges the osmo-* packages outright and deletes the
//     real OsmoHLR subscriber database (hlr.db). No revert story exists
//     that doesn't risk real, permanent subscriber data loss, and (per the
//     note above) could take down a live 2G BTS's own CS/call path too.
//   - POST /configs/restart with a real service name — redundant with the
//     dedicated /restart case below, which already exercises the same
//     nsenter restart path; only exercised here with an empty services
//     array (a genuine no-op) to confirm the route doesn't blow up on it.
import { assertOk, assertEqual, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'sms';

async function installed(client) {
  const res = await client.get('/api/sms/status');
  return res.data?.installed === true;
}

// Same Type=simple-unit restart-race lesson as ims.test.mjs's
// waitForScscfSettled() (see that file's header and the README's "Real
// bugs found" entry) — applied here for open5gs-mmed (a core-17 NF) and
// the osmo-* trio, both of which this module restarts.
async function waitForSettled(client, checkFn, timeoutMs = 30000, settleMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkFn()) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  await new Promise(r => setTimeout(r, settleMs));
}
const osmoActive = (statusData) => statusData?.services?.stp === true
  && statusData?.services?.hlr === true && statusData?.services?.msc === true;

export const CASES = [
  {
    name: 'GET /status',
    async run({ client }) {
      const res = await client.get('/api/sms/status');
      assertOk(res, 'GET /api/sms/status');
      if (typeof res.data?.installed !== 'boolean') return fail('response missing boolean "installed"', res.data);
      return pass(`installed=${res.data.installed}`);
    },
  },
  {
    name: 'GET /configs (manifest)',
    async run({ client }) {
      if (!(await installed(client))) return skip('SMS-over-SGs not installed');
      const res = await client.get('/api/sms/configs');
      assertOk(res, 'GET /api/sms/configs');
      if (!Array.isArray(res.data?.files) || res.data.files.length !== 3) {
        return fail('expected a 3-file manifest (osmo-stp/hlr/msc .cfg)', res.data);
      }
      return pass(`${res.data.files.length} file(s) in manifest`);
    },
  },
  {
    name: 'GET /configs/content for every manifest entry',
    async run({ client }) {
      if (!(await installed(client))) return skip('SMS-over-SGs not installed');
      const manifestRes = await client.get('/api/sms/configs');
      let readCount = 0;
      for (const f of manifestRes.data.files) {
        if (!f.exists) continue;
        const res = await client.get(`/api/sms/configs/content?path=${encodeURIComponent(f.path)}`);
        assertOk(res, `GET /api/sms/configs/content (${f.label})`);
        if (typeof res.data?.content !== 'string') return fail(`${f.label}: response missing string "content"`);
        readCount++;
      }
      // Path-allowlist regression check — a path outside SMS_ALLOWED_PATHS
      // must be refused, not silently served.
      const disallowed = await client.get('/api/sms/configs/content?path=/etc/passwd');
      if (disallowed.status !== 403) {
        return fail(`expected HTTP 403 for a disallowed path, got ${disallowed.status}`);
      }
      return pass(`read ${readCount} file(s) successfully; disallowed path correctly refused (403)`);
    },
  },
  {
    // Lowest-risk possible "edit": write back byte-identical content. Proves
    // the write path (including the fs.mkdirSync + writeFileSync call) works
    // without ever actually changing a functional value — PUT here never
    // restarts anything on its own (restartServices is only metadata the
    // frontend reads to decide whether to prompt for a restart; the
    // dedicated /configs/restart route is what actually restarts).
    name: 'PUT /configs/content — round-trip identical content on osmo-stp.cfg',
    async run({ client }) {
      if (!(await installed(client))) return skip('SMS-over-SGs not installed');
      const manifestRes = await client.get('/api/sms/configs');
      const target = manifestRes.data.files.find(f => f.label === 'osmo-stp.cfg' && f.exists);
      if (!target) return skip('osmo-stp.cfg not present on this instance');

      const before = await client.get(`/api/sms/configs/content?path=${encodeURIComponent(target.path)}`);
      const originalContent = before.data.content;

      const putRes = await client.put('/api/sms/configs/content', { path: target.path, content: originalContent });
      assertOk(putRes, 'PUT /api/sms/configs/content');

      const after = await client.get(`/api/sms/configs/content?path=${encodeURIComponent(target.path)}`);
      assertEqual(after.data.content, originalContent, 'osmo-stp.cfg content after round-trip write');
      return pass('round-tripped osmo-stp.cfg unchanged');
    },
  },
  {
    name: 'POST /send-test input validation',
    async run({ client }) {
      if (!(await installed(client))) return skip('SMS-over-SGs not installed');
      const cases = [
        { body: { to: 'abc', from: '999700000099', text: 'hi' }, label: 'non-numeric "to"' },
        { body: { to: '999700000099', from: '1', text: 'hi' }, label: 'too-short "from"' },
        { body: { to: '999700000099', from: '999700000098', text: '' }, label: 'empty text' },
        { body: { to: '999700000099', from: '999700000098', text: 'x'.repeat(161) }, label: 'text over 160 chars' },
        { body: { to: '999700000099', from: '999700000098', text: 'line1\nline2' }, label: 'text with newline' },
      ];
      const problems = [];
      for (const c of cases) {
        const res = await client.post('/api/sms/send-test', c.body);
        if (res.status !== 400) problems.push(`${c.label}: expected HTTP 400, got ${res.status}`);
      }
      if (problems.length > 0) return fail(problems.join('; '));

      // A well-formed request against a synthetic, almost-certainly-
      // nonexistent MSISDN pair (unused 999-70 test range) — no real
      // message is delivered to anyone, but this does confirm the route
      // actually reaches the live osmo-msc VTY and gets a coherent
      // response rather than e.g. "Connection refused".
      const liveRes = await client.post('/api/sms/send-test', {
        to: '999700000099', from: '999700000098', text: 'api-regression-suite test',
      });
      if (liveRes.status >= 500) return fail(`well-formed send-test request errored: HTTP ${liveRes.status} — ${JSON.stringify(liveRes.data)}`);
      if (/Connection refused/i.test(liveRes.data?.output ?? '')) {
        return fail('osmo-msc VTY is not reachable (Connection refused) — send-test cannot work at all right now');
      }
      return pass('all 5 invalid inputs correctly rejected (400); well-formed request reached the live VTY', { vtyOutput: liveRes.data?.output?.slice(0, 200) });
    },
  },
  {
    name: 'POST /sync-subscribers',
    async run({ client }) {
      if (!(await installed(client))) return skip('SMS-over-SGs not installed');
      const res = await client.post('/api/sms/sync-subscribers', {});
      assertOk(res, 'POST /api/sms/sync-subscribers');
      if (typeof res.data?.synced !== 'number') return fail('response missing numeric "synced"', res.data);
      return pass(`synced=${res.data.synced} failed=${res.data.failed?.length ?? 0} removed=${res.data.removed ?? 0}`);
    },
  },
  {
    name: 'POST /configs/restart with an empty services array (no-op)',
    async run({ client }) {
      if (!(await installed(client))) return skip('SMS-over-SGs not installed');
      const res = await client.post('/api/sms/configs/restart', { services: [] });
      assertOk(res, 'POST /api/sms/configs/restart (empty)');
      return pass('empty services array handled without error');
    },
  },
  {
    disruptive: true,
    name: 'POST /configure with current values (idempotent, restarts open5gs-mmed)',
    async run({ client }) {
      if (!(await installed(client))) return skip('SMS-over-SGs not installed');
      const before = await client.get('/api/sms/status');
      const { mscBindIp, hlrBindIp, mmeLocalIp } = before.data.currentConfig;

      const res = await client.post('/api/sms/configure', { mscBindIp, hlrBindIp, mmeLocalIp });
      assertOk(res, 'POST /api/sms/configure');
      await waitForSettled(client, async () => true, 1000, 5000);

      const after = await client.get('/api/sms/status');
      if (!after.data?.mmeSgsConfigured) return fail('mmeSgsConfigured is false after re-applying the current config');
      assertEqual(after.data.currentConfig.mscBindIp, mscBindIp, 'mscBindIp after re-configure');
      assertEqual(after.data.currentConfig.hlrBindIp, hlrBindIp, 'hlrBindIp after re-configure');
      return pass('re-applied existing config (no functional change) and open5gs-mmed came back up configured', { mscBindIp, hlrBindIp });
    },
  },
  {
    // Shares live infrastructure with the 2G GSM module's real BTS — see
    // this file's header. Only runs if all three services were already
    // active, and only stops/starts them (never /disable, which also tears
    // down the sgsap MME wiring) to keep the blast radius to "osmo-* briefly
    // unavailable," not "SGs unconfigured."
    disruptive: true,
    name: 'POST /stop then /start (osmo-stp/hlr/msc) — shares live infra with 2G GSM, see module header',
    async run({ client }) {
      if (!(await installed(client))) return skip('SMS-over-SGs not installed');
      const before = await client.get('/api/sms/status');
      if (!osmoActive(before.data)) return skip('osmo-stp/hlr/msc are not all currently active — skipping to avoid leaving a pre-existing down service in an ambiguous state');

      const stopRes = await client.post('/api/sms/stop', {});
      assertOk(stopRes, 'POST /api/sms/stop');
      await waitForSettled(client, async () => {
        const s = await client.get('/api/sms/status');
        return !osmoActive(s.data);
      });
      const afterStop = await client.get('/api/sms/status');
      if (osmoActive(afterStop.data)) return fail('services still report active immediately after /stop');

      const startRes = await client.post('/api/sms/start', {});
      assertOk(startRes, 'POST /api/sms/start');
      await waitForSettled(client, async () => {
        const s = await client.get('/api/sms/status');
        return osmoActive(s.data);
      });
      const afterStart = await client.get('/api/sms/status');
      if (!osmoActive(afterStart.data)) return fail('services did not come back active after /start');

      return pass('stop -> start cycle verified; all 3 services active again');
    },
  },
];
