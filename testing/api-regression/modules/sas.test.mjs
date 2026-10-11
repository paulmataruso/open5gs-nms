// CBRS SAS server — all 36 routes in sas-controller.ts: the 6 unauthenticated
// WINNF-TS-0016 protocol endpoints real radios speak (registration,
// spectrumInquiry, grant, heartbeat, relinquishment, deregistration) plus
// every admin/GUI-facing endpoint.
//
// The protocol-flow test reuses this project's own already-established,
// explicitly-sanctioned test CBSD identity (CLAUDE.md / sas-service.ts's own
// CATEGORY_B_TEST_EXEMPT_FCC_ID/SERIAL, "#2345CBSDTEST01" /
// "AH193701274.NR") rather than inventing a new synthetic identity — it's
// the one fccId/serial this codebase already documents as a real test
// harness, exempted from the Category B installationParam checks for
// exactly this reason.
//
// Two routes are deliberately NOT exercised even under --include-disruptive:
//   - POST /admin/reset — wipes ALL CBSD/grant data for EVERY radio on this
//     instance, real or test. No revert exists: real radios would need to
//     physically re-register from scratch. Same exclusion class as IMS's
//     /remove or SMF's uninstall.
//   - POST /admin/pki/root — regenerates the root CA real radios already
//     installed as their trust anchor; breaks every one of them until
//     manually reinstalled. A genuinely one-way, deliberate operator action
//     by design (confirm:true is required even to call it directly) — not
//     something an automated suite should ever do to a real deployment.
import { assertOk, assertEqual, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'sas';

const TEST_FCC_ID = '#2345CBSDTEST01';
const TEST_SERIAL = 'AH193701274.NR';
const TEST_USER_ID = 'api-regression-test-user';

export const CASES = [
  // ── read-only ──────────────────────────────────────────────────────
  {
    name: 'read-only admin endpoints respond',
    async run({ client }) {
      const endpoints = [
        '/api/sas/admin/last-requests', '/api/sas/admin/verbose', '/api/sas/admin/cbsds',
        '/api/sas/admin/stats', '/api/sas/admin/config', '/api/sas/admin/status',
        '/api/sas/admin/rf-status', '/api/sas/admin/slots', '/api/sas/admin/cert',
        '/api/sas/admin/pki', '/api/sas/admin/manual-groups', '/api/sas/admin/policies/groups',
        '/api/sas/admin/policies/cbsds',
      ];
      const failures = [];
      for (const ep of endpoints) {
        const res = await client.get(ep);
        if (res.status >= 500) failures.push(`${ep}: HTTP ${res.status}`);
      }
      if (failures.length > 0) return fail(failures.join('; '));
      return pass(`${endpoints.length} endpoints OK`);
    },
  },
  {
    name: 'GET /admin/logs',
    async run({ client }) {
      const res = await client.get('/api/sas/admin/logs?lines=50');
      assertOk(res, 'GET /api/sas/admin/logs');
      if (typeof res.data?.logs !== 'string') return fail('response missing "logs" string', res.data);
      return pass('responded OK');
    },
  },
  {
    name: 'cert downloads (existence-gated)',
    async run({ client }) {
      const certRes = await client.get('/api/sas/admin/cert');
      if (!certRes.data?.exists) return skip('no SAS cert on this instance yet');
      const dlRes = await client.get('/api/sas/admin/cert/download');
      if (dlRes.status >= 500) return fail(`cert download: HTTP ${dlRes.status}`);
      const crtRes = await client.get('/api/sas/admin/pki/download/crt');
      const pemRes = await client.get('/api/sas/admin/pki/download/pem');
      if (crtRes.status >= 500 || pemRes.status >= 500) {
        return fail(`pki download: crt=${crtRes.status} pem=${pemRes.status}`);
      }
      const badFormatRes = await client.get('/api/sas/admin/pki/download/exe');
      if (badFormatRes.status !== 400) return fail(`expected 400 for an invalid format, got ${badFormatRes.status}`);
      return pass('cert + root CA (crt/pem) downloads OK, invalid format correctly rejected');
    },
  },

  // ── safe CRUD (toggle-style, no real-radio impact) ────────────────
  {
    name: 'POST /admin/verbose toggle',
    async run({ client, revertQueue }) {
      const before = await client.get('/api/sas/admin/verbose');
      const original = before.data?.verbose;
      revertQueue.push('revert sas verbose flag', async () => {
        await client.post('/api/sas/admin/verbose', { verbose: original });
      });
      const setRes = await client.post('/api/sas/admin/verbose', { verbose: !original });
      assertOk(setRes, 'POST /api/sas/admin/verbose');
      assertEqual(setRes.data?.verbose, !original, 'verbose after set');
      const revertRes = await client.post('/api/sas/admin/verbose', { verbose: original });
      assertEqual(revertRes.data?.verbose, original, 'verbose after revert');
      return pass(`toggled ${original} -> ${!original} -> ${original}`);
    },
  },
  {
    name: 'manual-groups: create -> read -> delete',
    async run({ client, revertQueue }) {
      const groupId = 'api-regression-test-group';
      const existing = await client.get('/api/sas/admin/manual-groups');
      if (existing.data?.groups?.some(g => g._id === groupId)) {
        return fail(`manual group "${groupId}" already exists — refusing to touch it.`);
      }
      revertQueue.push(`delete manual group ${groupId}`, async () => {
        await client.delete(`/api/sas/admin/manual-groups/${groupId}`);
      });
      const putRes = await client.put(`/api/sas/admin/manual-groups/${groupId}`, { cbsdIds: [] });
      assertOk(putRes, 'PUT /api/sas/admin/manual-groups/:groupId');
      const afterPut = await client.get('/api/sas/admin/manual-groups');
      if (!afterPut.data?.groups?.some(g => g._id === groupId)) return fail('group not found after create');
      const delRes = await client.delete(`/api/sas/admin/manual-groups/${groupId}`);
      assertOk(delRes, 'DELETE /api/sas/admin/manual-groups/:groupId');
      const afterDel = await client.get('/api/sas/admin/manual-groups');
      if (afterDel.data?.groups?.some(g => g._id === groupId)) return fail('group still present after delete');
      return pass('manual group create->read->delete verified');
    },
  },
  {
    name: 'group band policy: create -> read -> delete',
    async run({ client, revertQueue }) {
      const configRes = await client.get('/api/sas/admin/config');
      const bandId = configRes.data?.config?.frequencyBands?.[0]?.id;
      if (!bandId) return skip('no frequency bands configured on this instance');
      const groupId = 'api-regression-test-policy-group';
      const existing = await client.get('/api/sas/admin/policies/groups');
      if (existing.data?.policies?.some(p => p._id === groupId)) {
        return fail(`group policy "${groupId}" already exists — refusing to touch it.`);
      }
      revertQueue.push(`delete group policy ${groupId}`, async () => {
        await client.delete(`/api/sas/admin/policies/groups/${groupId}`);
      });
      const putRes = await client.put(`/api/sas/admin/policies/groups/${groupId}`, { bandId, notes: 'api-regression-test' });
      assertOk(putRes, 'PUT /api/sas/admin/policies/groups/:groupId');
      const afterPut = await client.get('/api/sas/admin/policies/groups');
      const found = afterPut.data?.policies?.find(p => p._id === groupId);
      if (!found || found.bandId !== bandId) return fail('policy not found or bandId mismatch after create');
      const delRes = await client.delete(`/api/sas/admin/policies/groups/${groupId}`);
      assertOk(delRes, 'DELETE /api/sas/admin/policies/groups/:groupId');
      const afterDel = await client.get('/api/sas/admin/policies/groups');
      if (afterDel.data?.policies?.some(p => p._id === groupId)) return fail('policy still present after delete');
      return pass('group band policy create->read->delete verified');
    },
  },

  // ── full WINNF-TS-0016 protocol lifecycle, using the project's own
  // sanctioned test CBSD identity ──────────────────────────────────────
  {
    name: 'CBSD protocol lifecycle: register -> policy -> spectrumInquiry -> grant(GPS-delayed) -> deregister',
    async run({ client, revertQueue }) {
      // Pre-check: refuse if this identity is already registered from a
      // previous run that didn't clean up (shouldn't happen — just safety).
      const preCbsds = await client.get('/api/sas/admin/cbsds');
      const preExisting = preCbsds.data?.cbsds?.find(c => c.fccId === TEST_FCC_ID && c.cbsdSerialNumber === TEST_SERIAL);
      if (preExisting) {
        return fail(`Test CBSD ${TEST_FCC_ID}/${TEST_SERIAL} is already registered (cbsdId=${preExisting.cbsdId}) — a previous run may not have cleaned up. Delete it manually first.`);
      }

      // Pin this CBSD to a known band via the per-CBSD policy override (also
      // exercises PUT /admin/policies/cbsds/:fccId/:serial) — avoids relying
      // on global band-matching heuristics for a synthetic test identity.
      const configRes = await client.get('/api/sas/admin/config');
      const band = configRes.data?.config?.frequencyBands?.[0];
      if (!band) return skip('no frequency bands configured on this instance');
      revertQueue.push('delete test CBSD policy override', async () => {
        await client.delete(`/api/sas/admin/policies/cbsds/${encodeURIComponent(TEST_FCC_ID)}/${encodeURIComponent(TEST_SERIAL)}`);
      });
      const policyRes = await client.put(
        `/api/sas/admin/policies/cbsds/${encodeURIComponent(TEST_FCC_ID)}/${encodeURIComponent(TEST_SERIAL)}`,
        { bandId: band.id, notes: 'api-regression-test' },
      );
      assertOk(policyRes, 'PUT /api/sas/admin/policies/cbsds/:fccId/:serial');

      // ── registration (Category B, exempt identity — no lat/long/height needed) ──
      const regRes = await client.post('/sas/registration', {
        registrationRequest: [{
          userId: TEST_USER_ID, fccId: TEST_FCC_ID, cbsdSerialNumber: TEST_SERIAL,
          cbsdCategory: 'B',
          airInterface: { radioTechnology: 'E_UTRA' },
        }],
      });
      assertOk(regRes, 'POST /api/sas/registration');
      const cbsdId = regRes.data?.registrationResponse?.[0]?.cbsdId;
      const regCode = regRes.data?.registrationResponse?.[0]?.response?.responseCode;
      if (regCode !== 0 || !cbsdId) {
        return fail(`registration did not succeed: responseCode=${regCode}, cbsdId=${cbsdId}`, regRes.data);
      }
      revertQueue.push(`deregister + delete test CBSD ${cbsdId}`, async () => {
        await client.post('/sas/deregistration', { deregistrationRequest: [{ cbsdId }] }).catch(() => {});
        await client.delete(`/api/sas/admin/cbsds/${cbsdId}`).catch(() => {});
      });

      const afterReg = await client.get('/api/sas/admin/cbsds');
      if (!afterReg.data?.cbsds?.some(c => c.cbsdId === cbsdId)) {
        return fail('registered CBSD not found in GET /admin/cbsds');
      }

      // ── spectrumInquiry ──
      const siRes = await client.post('/sas/spectrumInquiry', {
        spectrumInquiryRequest: [{
          cbsdId,
          inquiredSpectrum: [{ lowFrequency: band.lowFrequency, highFrequency: band.lowFrequency + 10_000_000 }],
        }],
      });
      assertOk(siRes, 'POST /api/sas/spectrumInquiry');
      const siCode = siRes.data?.spectrumInquiryResponse?.[0]?.response?.responseCode;
      if (siCode !== 0) return fail(`spectrumInquiry did not succeed: responseCode=${siCode}`, siRes.data);

      // ── grant attempt #1: expected to be held by the real GPS-lock delay
      // (sas-service.ts's GPS_LOCK_DELAY_MS, 75s for non-Sercomm identities)
      // — this is genuine, intentional product behavior (Baicells firmware
      // re-grants after GPS lock), not a bug, and worth directly verifying
      // rather than just waiting past it blind. ──
      const lowFrequency = band.lowFrequency + 10_000_000;
      const highFrequency = lowFrequency + 10_000_000;
      const grantParams = {
        cbsdId,
        operationParam: {
          maxEirp: 20,
          operationFrequencyRange: { lowFrequency, highFrequency },
        },
      };
      const earlyGrantRes = await client.post('/sas/grant', { grantRequest: [grantParams] });
      assertOk(earlyGrantRes, 'POST /api/sas/grant (within GPS-lock delay)');
      const earlyCode = earlyGrantRes.data?.grantResponse?.[0]?.response?.responseCode;
      let grantId, grantCode, delayVerified;
      if (earlyCode === 300 /* UNSUPPORTED_SPECTRUM */) {
        // Delay genuinely in effect — verify it, wait it out, retry.
        delayVerified = true;
        await new Promise(r => setTimeout(r, 76_000));
        const grantRes = await client.post('/sas/grant', { grantRequest: [grantParams] });
        assertOk(grantRes, 'POST /api/sas/grant (after GPS-lock delay)');
        grantId = grantRes.data?.grantResponse?.[0]?.grantId;
        grantCode = grantRes.data?.grantResponse?.[0]?.response?.responseCode;
      } else if (earlyCode === 0 /* SUCCESS */) {
        // The delay is tracked in-memory by fccId:serial (firstSeenTime map
        // in sas-service.ts) and is NOT reset by deregistration — if this
        // exact test identity was registered recently enough (e.g. a prior
        // run of this same suite within the last ~75s), its clock has
        // already elapsed and grant succeeds immediately. That's correct,
        // intentional behavior (a real radio re-registering shortly after
        // a previous session shouldn't need to wait through GPS lock
        // again) — not something to fail on, just not what this specific
        // run happens to be able to verify.
        delayVerified = false;
        grantId = earlyGrantRes.data?.grantResponse?.[0]?.grantId;
        grantCode = earlyCode;
      } else {
        return fail(`unexpected grant responseCode=${earlyCode} (expected 300=delayed or 0=success)`, earlyGrantRes.data);
      }
      if (grantCode !== 0 || !grantId) {
        return fail(`grant did not ultimately succeed: responseCode=${grantCode}`, earlyGrantRes.data);
      }

      // ── heartbeat ──
      const hbRes = await client.post('/sas/heartbeat', {
        heartbeatRequest: [{ cbsdId, grantId, operationState: 'GRANTED' }],
      });
      assertOk(hbRes, 'POST /api/sas/heartbeat');
      const hbCode = hbRes.data?.heartbeatResponse?.[0]?.response?.responseCode;
      if (hbCode !== 0) return fail(`heartbeat did not succeed: responseCode=${hbCode}`, hbRes.data);

      // ── relinquishment ──
      const relRes = await client.post('/sas/relinquishment', {
        relinquishmentRequest: [{ cbsdId, grantId }],
      });
      assertOk(relRes, 'POST /api/sas/relinquishment');
      const relCode = relRes.data?.relinquishmentResponse?.[0]?.response?.responseCode;
      if (relCode !== 0) return fail(`relinquishment did not succeed: responseCode=${relCode}`, relRes.data);

      // ── deregistration ──
      const deregRes = await client.post('/sas/deregistration', { deregistrationRequest: [{ cbsdId }] });
      assertOk(deregRes, 'POST /api/sas/deregistration');
      const deregCode = deregRes.data?.deregistrationResponse?.[0]?.response?.responseCode;
      if (deregCode !== 0) return fail(`deregistration did not succeed: responseCode=${deregCode}`, deregRes.data);

      // ── admin cleanup: delete the test CBSD record itself ──
      const delCbsdRes = await client.delete(`/api/sas/admin/cbsds/${cbsdId}`);
      assertOk(delCbsdRes, 'DELETE /api/sas/admin/cbsds/:cbsdId');
      const afterCleanup = await client.get('/api/sas/admin/cbsds');
      if (afterCleanup.data?.cbsds?.some(c => c.cbsdId === cbsdId)) {
        return fail('test CBSD still present after DELETE /admin/cbsds/:cbsdId');
      }

      return pass(
        `full register->policy->spectrumInquiry->grant(GPS-delay ${delayVerified ? 'verified' : 'already elapsed from a recent prior run'})->heartbeat->relinquish->deregister->cleanup cycle verified`,
        { cbsdId, grantId, delayVerified },
      );
    },
  },
  {
    name: 'DELETE /admin/grants/:grantId and /admin/cbsds/:cbsdId return 404 for nonexistent ids',
    async run({ client }) {
      const grantRes = await client.delete('/api/sas/admin/grants/nonexistent-grant-id');
      const cbsdRes = await client.delete('/api/sas/admin/cbsds/nonexistent-cbsd-id');
      if (grantRes.status !== 404) return fail(`expected 404 for a nonexistent grantId, got ${grantRes.status}`);
      if (cbsdRes.status !== 404) return fail(`expected 404 for a nonexistent cbsdId, got ${cbsdRes.status}`);
      return pass('both correctly return 404 for nonexistent ids');
    },
  },

  // ── disruptive: real, if brief, impact on live radio transmission authorization ──
  {
    // Pausing SAS makes every endpoint respond DEREGISTER/TERMINATED_GRANT —
    // real CBRS radios are required by FCC Part 96 to cease transmission
    // without a timely heartbeat response. Brief and paired (resume runs
    // immediately after in the same test), but this is real RF impact on
    // real hardware, not a sandboxed config change — opt-in only.
    name: 'POST /admin/pause then /admin/resume',
    disruptive: true,
    async run({ client, revertQueue }) {
      revertQueue.push('ensure sas resumed', async () => {
        const status = await client.get('/api/sas/admin/status');
        if (status.data?.paused) await client.post('/api/sas/admin/resume');
      });
      const pauseRes = await client.post('/api/sas/admin/pause');
      assertOk(pauseRes, 'POST /api/sas/admin/pause');
      assertEqual(pauseRes.data?.paused, true, 'paused after pause');
      const statusRes = await client.get('/api/sas/admin/status');
      assertEqual(statusRes.data?.paused, true, '/admin/status after pause');
      const resumeRes = await client.post('/api/sas/admin/resume');
      assertOk(resumeRes, 'POST /api/sas/admin/resume');
      assertEqual(resumeRes.data?.paused, false, 'paused after resume');
      return pass('pause -> resume cycle verified');
    },
  },
  {
    // Regenerates the LEAF (server) TLS cert only — per the route's own
    // comment, "safe, doesn't affect any radio's already-installed trust
    // anchor" since radios trust the ROOT, not the specific leaf. Still
    // gated as disruptive: it's a real cert rotation on the live,
    // radio-facing TLS endpoint, not a sandboxed write.
    name: 'POST /admin/pki/leaf (regenerate server cert)',
    disruptive: true,
    async run({ client }) {
      const res = await client.post('/api/sas/admin/pki/leaf', {});
      assertOk(res, 'POST /api/sas/admin/pki/leaf');
      return pass('leaf cert regenerated');
    },
  },

  // ── deliberately not exercised — see file header for why ──────────
  {
    name: 'POST /admin/reset (not exercised)',
    async run() {
      return skip('wipes ALL CBSD/grant data for every radio, real or test, with no revert — see this file\'s header comment');
    },
  },
  {
    name: 'POST /admin/pki/root (not exercised)',
    async run() {
      return skip('breaks every real radio\'s already-installed trust anchor with no revert — see this file\'s header comment');
    },
  },
];
