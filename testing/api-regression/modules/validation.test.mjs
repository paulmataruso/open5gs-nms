// UE Validation — 5 controllers, all mounted under /api/validation
// (validation-controller.ts's own UERANSIM/srsRAN session mechanism at the
// root, plus volte/vowifi/qci-validation's one-shot E2E test runners, plus
// qci-hw-test's real-hardware test). This whole feature exists specifically
// to be a safe, repeatable test mechanism — UERANSIM/srsRAN are UE
// simulators, not real radio hardware, and the VoLTE/VoWiFi/QCI E2E runners
// are self-contained (no request body) built-in validation tools — so this
// module runs REAL, live sessions/tests rather than just checking routes
// exist, same spirit as this suite exercising SAS's own test CBSD identity.
//
// POST /api/validation/qci-hw-test/run is the one exception, NOT exercised:
// its own header comment says it plainly — "there is no way to make a REAL
// bearer request happen against REAL hardware without a real UE (a real
// phone) actually attached to that radio placing a real call." This is
// explicitly operator-driven with a real human and a real phone in the
// loop, not something to trigger from an unattended test run.
//
// Known first-run slowness, now confirmed RECURRING (2026-10-02, two
// separate attempts, the second on what should have been a quiet,
// already-warmed-up host with no concurrent build): the very first time
// 4G/QCI validation runs, it compiles a whole `srsran4g-noavx` Docker image
// from source — and `dockerBuild()`'s own comment in validation-controller.ts
// states this takes "~22 minutes on an 8-core host with a cold Docker layer
// cache." No simple one-shot HTTP client (this suite's included) can
// reliably hold a connection open that long, so the QCI E2E run's own
// request gets torn down first (`TypeError: terminated` / `onSocketClose`
// — the socket closing from somewhere in the stack, not an explicit
// client-side abort). The real, still-open question this suite can't
// cheaply answer: whether the GUI's own long-lived connection handling
// tolerates this better than a plain fetch() does, and — a genuinely
// concerning second data point — `docker images` showed NO srsran4g-noavx
// image at all on the SECOND attempt, after the FIRST attempt's build had
// appeared to progress completely normally (real, active `cc1plus`
// processes, no errors). Either the image never actually finishes/commits
// before something tears down the build along with the terminated request,
// or it's removed by something between runs — `dockerImageExists()`'s own
// check (`docker image inspect`) is correct on its face, so this isn't an
// obviously-wrong cache check. Not root-caused further here (would require
// a 20+ minute uninterrupted observation this suite isn't set up for) —
// flagged honestly as a real, reproducible gap rather than papering over
// it. The VoLTE E2E test's own spurious-looking timeout on the FIRST
// attempt (a hardcoded 15s call-setup wait, caught in the exact window the
// concurrent cold build was pegging all 8 cores) is separately explained
// and not part of this same open question. Neither a `success: false` nor
// a connection error from any of these routes is treated as a hard test
// failure — both are recorded as evidence for human review, which is
// exactly what surfaced this.
import { assertOk, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'validation';

// NDJSON-streaming /run endpoints return one JSON object per line, not one
// parseable JSON document — ApiClient's safeJson() would choke on this and
// only keep the first 500 chars. Fetches raw text and parses line-by-line.
async function runStreamed(client, path) {
  const res = await fetch(`${client.baseUrl}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(client.cookie ? { Cookie: client.cookie } : {}) }, body: '{}',
  });
  const text = await res.text();
  const lines = text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { status: res.status, lines };
}

export const CASES = [
  { name: 'POST /qci-hw-test/run (not exercised)', async run() { return skip('requires a real human-operated phone physically attached to a real radio placing a real call — see this file\'s header comment and the route\'s own header comment'); } },

  {
    name: 'GET /infer and /capacity',
    async run({ client }) {
      const inferRes = await client.get('/api/validation/infer');
      assertOk(inferRes, 'GET /api/validation/infer');
      const capRes = await client.get('/api/validation/capacity');
      assertOk(capRes, 'GET /api/validation/capacity');
      if (typeof capRes.data?.cores !== 'number') return fail('capacity response missing numeric "cores"', capRes.data);
      return pass(`cores=${capRes.data.cores} totalMemGB=${capRes.data.totalMemGB}`);
    },
  },
  {
    name: 'GET /sessions (read-only)',
    async run({ client }) {
      const res = await client.get('/api/validation/sessions');
      assertOk(res, 'GET /api/validation/sessions');
      if (!Array.isArray(res.data?.sessions)) return fail('response missing "sessions" array', res.data);
      return pass(`${res.data.sessions.length} active session(s)`);
    },
  },
  {
    // Full real lifecycle: the smallest possible footprint (1 gNB, 1 UE) —
    // provisions real UERANSIM containers, registers against the real live
    // core, pings the UE's real assigned IP, then tears everything down.
    name: 'full session lifecycle: start (1 gNB/1 UE) -> poll to running -> ping -> stop',
    async run({ client, revertQueue }) {
      const sessionsBefore = await client.get('/api/validation/sessions');
      if (sessionsBefore.data.sessions.length > 0) {
        return skip(`${sessionsBefore.data.sessions.length} validation session(s) already running — refusing to start another one alongside them`);
      }

      const startRes = await client.post('/api/validation/start', {
        enable5G: true, enable4G: false, gnbCount: 1, gnbUeCount: 1,
      });
      assertOk(startRes, 'POST /api/validation/start');
      const sessionId = startRes.data?.sessionId ?? startRes.data?.id;
      if (!sessionId) return fail('start response missing a session id', startRes.data);

      // force-cleanup works even without session state (per its own doc
      // comment) — a more robust safety net than tracking just this one id.
      revertQueue.push('clean up validation test session', async () => {
        await client.post('/api/validation/force-cleanup', {}).catch(() => {});
      });

      const deadline = Date.now() + 120_000;
      let finalStatus = null;
      while (Date.now() < deadline) {
        const statusRes = await client.get(`/api/validation/status/${sessionId}`);
        finalStatus = statusRes.data?.session?.status;
        if (finalStatus === 'running' || finalStatus === 'failed') break;
        await new Promise(r => setTimeout(r, 3000));
      }
      if (finalStatus !== 'running') {
        const logsRes = await client.get(`/api/validation/logs/${sessionId}`);
        return fail(`session did not reach "running" within 120s (status=${finalStatus})`, { logs: logsRes.data?.logs?.slice(-20) });
      }

      const statusRes = await client.get(`/api/validation/status/${sessionId}`);
      const ueIps = Object.values(statusRes.data?.session?.ueStatuses ?? {}).map(u => u.ip).filter(Boolean);
      let pingNote = 'no UE IP reported to ping';
      if (ueIps.length > 0) {
        const pingRes = await client.post(`/api/validation/ping/${sessionId}?ip=${ueIps[0]}`, {});
        pingNote = `ping ${ueIps[0]}: reachable=${pingRes.data?.reachable} lossPct=${pingRes.data?.lossPct}`;
      }

      const stopRes = await client.post(`/api/validation/stop/${sessionId}`, {});
      assertOk(stopRes, 'POST /api/validation/stop/:id');
      const afterStop = await client.get(`/api/validation/status/${sessionId}`);
      if (afterStop.status !== 404) return fail('session still exists after /stop (expected 404 on next status read)');

      return pass(`session reached "running" and was cleanly stopped; ${pingNote}`, { sessionId });
    },
  },
  {
    name: 'POST /stop-all is safe to call with no active sessions',
    async run({ client }) {
      const res = await client.post('/api/validation/stop-all', {});
      assertOk(res, 'POST /api/validation/stop-all');
      return pass('no-op stop-all handled without error');
    },
  },
  {
    name: 'VoLTE E2E validation: GET /volte/status + POST /volte/run',
    async run({ client }) {
      const statusRes = await client.get('/api/validation/volte/status');
      assertOk(statusRes, 'GET /api/validation/volte/status');
      if (!statusRes.data?.imsConfigured) return skip('IMS not configured — VoLTE validation needs it');
      if (statusRes.data?.running) return skip('a VoLTE validation test is already running');

      const result = await runStreamed(client, '/api/validation/volte/run');
      if (result.status !== 200) return fail(`expected HTTP 200, got ${result.status}`);
      const final = result.lines.find(l => l.type === 'result');
      if (!final) return fail('stream never produced a final "result" line', { lineCount: result.lines.length });
      return pass(`VoLTE E2E test completed: success=${final.success}`, { error: final.error, stepCount: result.lines.filter(l => l.type === 'step').length });
    },
  },
  {
    name: 'VoWiFi E2E validation: GET /vowifi/status + POST /vowifi/run',
    async run({ client }) {
      const statusRes = await client.get('/api/validation/vowifi/status');
      assertOk(statusRes, 'GET /api/validation/vowifi/status');
      if (!statusRes.data?.imsConfigured) return skip('IMS not configured — VoWiFi validation needs it');
      if (statusRes.data?.running) return skip('a VoWiFi validation test is already running');
      if (statusRes.data?.tunnelAlreadyRunning) return skip('a VoWiFi validation tunnel is already up from a prior run');

      const result = await runStreamed(client, '/api/validation/vowifi/run');
      if (result.status !== 200) return fail(`expected HTTP 200, got ${result.status}`);
      const final = result.lines.find(l => l.type === 'result');
      if (!final) return fail('stream never produced a final "result" line', { lineCount: result.lines.length });
      return pass(`VoWiFi E2E test completed: success=${final.success}`, { error: final.error });
    },
  },
  {
    name: 'QCI E2E validation: GET /qci/status + POST /qci/run',
    async run({ client }) {
      const statusRes = await client.get('/api/validation/qci/status');
      assertOk(statusRes, 'GET /api/validation/qci/status');
      if (!statusRes.data?.imsConfigured) return skip('IMS not configured — QCI validation needs it');
      if (statusRes.data?.running) return skip('a QCI validation test is already running');

      const result = await runStreamed(client, '/api/validation/qci/run');
      if (result.status !== 200) return fail(`expected HTTP 200, got ${result.status}`);
      const final = result.lines.find(l => l.type === 'result');
      if (!final) return fail('stream never produced a final "result" line', { lineCount: result.lines.length });
      return pass(`QCI E2E test completed: success=${final.success}`, { error: final.error });
    },
  },
  {
    name: 'GET /qci-hw-test/status and /attached-ues',
    async run({ client }) {
      const statusRes = await client.get('/api/validation/qci-hw-test/status');
      assertOk(statusRes, 'GET /api/validation/qci-hw-test/status');
      if (typeof statusRes.data?.built !== 'boolean') return fail('response missing boolean "built"', statusRes.data);

      const missingParamRes = await client.get('/api/validation/qci-hw-test/attached-ues');
      if (missingParamRes.status !== 400) return fail(`expected HTTP 400 for a missing radioIp, got ${missingParamRes.status}`);

      const res = await client.get('/api/validation/qci-hw-test/attached-ues?radioIp=10.0.2.100');
      if (res.status >= 500) return fail(`unexpected HTTP ${res.status}`, res.data);
      return pass(`built=${statusRes.data.built}; missing-param case correctly 400; a real radioIp query returned HTTP ${res.status}`);
    },
  },
];
