// IMS module — every route in ims-controller.ts (19 total). Supersedes the
// earlier ims-toggles.test.mjs (folded in here as the two toggle cases
// below) now that this covers the whole controller, not just two toggles.
//
// Three endpoints are deliberately NOT exercised, even under
// --include-disruptive, with the reasoning kept inline at each skip() call
// rather than just silently omitted:
//   - POST /live/deregister — force-deregisters a REAL subscriber's real
//     SIP registration. There's no synthetic registration to create via
//     API (registrations only come from a real UE actually registering),
//     and there's no revert: the only way back is the real device noticing
//     and re-registering on its own, which could take anywhere from
//     seconds to never (backgrounded app). Testing this against a live
//     instance means knowingly kicking a real phone off a real call path.
//   - POST /remove — full uninstall. Even opted into disruptive testing,
//     "revert" would mean a full re-install, which does not provably
//     restore exact prior state (e.g. PyHSS subscriber data that
//     accumulated via sync-subscribers over time, or any manual edits an
//     operator made directly to a config file this suite can't know
//     about). This is the one operation in the whole controller this
//     suite treats as outside what "safe to run against any instance"
//     can mean, even opt-in.
//   - POST /install — same category as /remove: a full package-install
//     cycle on a module that may already be configured with real
//     subscriber/billing data behind it; even if idempotent at the apt
//     level, re-running it is a multi-minute, real-package-manager
//     operation with no clean "was this already installed exactly this
//     way" revert story. Covered instead by confirming /status correctly
//     reports installed=true, which is what install's own success
//     ultimately needs to be true for everything else in this module to
//     make sense.
import { assertOk, assertEqual, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'ims';

async function installed(client) {
  const res = await client.get('/api/ims/status');
  return res.data?.installed === true;
}

// kamailio-scscf spawns 24+ cdp/worker child processes on every restart —
// systemd reports the unit "active" as soon as the main process forks
// (Type=simple), well before those children finish initializing. Issuing a
// SECOND restart while the first is still mid-spawn crashed it with a real
// core-dump (confirmed live 2026-10-02: the set -> verify -> set-back
// sequence below, run back-to-back with no settle delay, killed
// kamailio-scscf mid-startup and briefly left voice charging silently
// disabled on a live instance despite /status still claiming it was on —
// see the README's "Real bugs found" entry). Poll /status until the
// service reports active again, then add a fixed settle margin before this
// module issues another restart-triggering call.
async function waitForScscfSettled(client) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const res = await client.get('/api/ims/status');
    if (res.data?.services?.scscf === true) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  await new Promise(r => setTimeout(r, 4000));
}

export const CASES = [
  // ── read-only ──────────────────────────────────────────────────────
  {
    name: 'GET /status',
    async run({ client }) {
      const res = await client.get('/api/ims/status');
      assertOk(res, 'GET /api/ims/status');
      if (typeof res.data?.installed !== 'boolean') {
        return fail('response missing boolean "installed" field', res.data);
      }
      return pass(`installed=${res.data.installed}`);
    },
  },
  {
    name: 'GET /call-stats',
    async run({ client }) {
      const res = await client.get('/api/ims/call-stats');
      if (res.status >= 500) return fail(`HTTP ${res.status}`, res.data);
      return pass(`HTTP ${res.status}`);
    },
  },
  {
    name: 'GET /live',
    async run({ client }) {
      if (!(await installed(client))) return skip('IMS not installed');
      const res = await client.get('/api/ims/live');
      assertOk(res, 'GET /api/ims/live');
      return pass('responded OK');
    },
  },
  {
    name: 'GET /dns-records',
    async run({ client }) {
      const res = await client.get('/api/ims/dns-records');
      assertOk(res, 'GET /api/ims/dns-records');
      if (!Array.isArray(res.data?.records)) return fail('response missing "records" array', res.data);
      return pass(`${res.data.records.length} record(s)`);
    },
  },
  {
    name: 'GET /configs (manifest)',
    async run({ client }) {
      if (!(await installed(client))) return skip('IMS not installed');
      const res = await client.get('/api/ims/configs');
      assertOk(res, 'GET /api/ims/configs');
      if (!Array.isArray(res.data?.files)) return fail('response missing "files" array', res.data);
      return pass(`${res.data.files.length} file(s) in manifest`);
    },
  },
  {
    name: 'GET /configs/content for every manifest entry',
    async run({ client }) {
      if (!(await installed(client))) return skip('IMS not installed');
      const manifestRes = await client.get('/api/ims/configs');
      assertOk(manifestRes, 'GET /api/ims/configs');
      const files = manifestRes.data.files ?? [];
      if (files.length === 0) return skip('manifest is empty on this instance');
      const failures = [];
      for (const f of files) {
        const res = await client.get(`/api/ims/configs/content?path=${encodeURIComponent(f.path)}`);
        if (!res.ok || typeof res.data?.content !== 'string') failures.push(f.path);
      }
      if (failures.length > 0) return fail(`could not read: ${failures.join(', ')}`);
      return pass(`read ${files.length} file(s) successfully`);
    },
  },
  {
    // Regression guard for 3 real bugs found live 2026-10-04 during a long
    // 2G<->4G/4G-4G cross-RAN debugging session (see
    // 2G_CALLING_DEBUG_LOG_2026-10-03.md for the full arc): (1) N5 QoS
    // flow authorization used a stale pre-rtpengine-rewrite SDP port
    // because msg_apply_changes() was missing after route(NATMANAGE) in
    // mo.cfg/mt.cfg's reply routes; (2) the N5 AppSession htable lookup
    // treated a non-empty-but-garbage value (the literal string "0") as a
    // real existing session ID; (3) P-CSCF's fr_timer was 3000ms while
    // I-CSCF/S-CSCF both use 10000ms, killing a call before a temporarily
    // slow real UE could send its first provisional response. All three
    // are embedded directly in static Kamailio config, invisible to
    // /status and easy to silently lose on a future template edit or a
    // careless revert — this is the only thing that would actually catch
    // that happening.
    name: 'Static config regression guard — N5 port-mismatch + fr_timer + Rx Framed-IP fixes (2026-10-04/05)',
    async run({ client }) {
      if (!(await installed(client))) return skip('IMS not installed');
      const read = async (p) => {
        const r = await client.get(`/api/ims/configs/content?path=${encodeURIComponent(p)}`);
        return r.ok ? (r.data?.content ?? '') : null;
      };
      const problems = [];

      const pcscfCfg = await read('/etc/kamailio_pcscf/kamailio_pcscf.cfg');
      if (pcscfCfg === null) problems.push('could not read kamailio_pcscf.cfg');
      else if (!/modparam\("tm",\s*"fr_timer",\s*10000\)/.test(pcscfCfg)) {
        problems.push('fr_timer is not 10000 in kamailio_pcscf.cfg (reverted to the too-aggressive 3000ms value?)');
      }

      for (const [label, p] of [['mo.cfg', '/etc/kamailio_pcscf/route/mo.cfg'], ['mt.cfg', '/etc/kamailio_pcscf/route/mt.cfg']]) {
        const content = await read(p);
        if (content === null) { problems.push(`could not read ${label}`); continue; }
        if (!/\{s\.len\}\)\s*>\s*0/.test(content)) {
          problems.push(`${label} is missing the N5 htable non-empty-string check ({s.len} > 0) — AppSession "0" bug may have regressed`);
        }
        // 2026-10-08: the N5 AppSession teardown fixes. Kamailio's $var()
        // cannot hold null (assigning $null stores integer 0), so the old
        // `$var(n5_*) != $null` tests were permanently true and produced 497
        // bogus `DELETE /app-sessions/0` plus 98 bogus `PATCH /app-sessions/0`
        // against PCF. And 3GPP TS 29.514 defines no http DELETE on
        // /app-sessions/{id} at all -- deletion is POST to .../{id}/delete --
        // so the teardown had never once worked and every call leaked a
        // dedicated 5QI flow.
        if (/\$var\(n5_[a-z_]*\)\s*[!=]=\s*\$null|\$var\(n5_[a-z_]*\)\s*=\s*\$null/.test(content)) {
          problems.push(`${label} compares or assigns a $var(n5_*) against $null — $var() cannot hold null, so that test is always true; use the n5_have_id flag and a != "0" guard instead`);
        }
        if (!/n5_have_id/.test(content)) {
          problems.push(`${label} is missing the n5_have_id flag that replaced the broken $null sentinel`);
        }
        if (!/app-sessions\/" \+ \$var\(n5_app_session_id\) \+ "\/delete"/.test(content)) {
          problems.push(`${label} does not build the AppSession teardown URL as .../app-sessions/<id>/delete — 3GPP defines no http DELETE on that resource and PCF answers 405, which silently leaks a dedicated bearer per call`);
        }
        if (/http_client_request_v2pk\("DELETE"/.test(content)) {
          problems.push(`${label} still issues an http DELETE for the AppSession teardown — it must be POST to .../<id>/delete`);
        }
        if (!/case 405:/.test(content)) {
          problems.push(`${label} is missing the explicit 405 branch in the teardown response switch — without it a regression back to the wrong method/URL is silently swallowed by the default branch`);
        }
        // 2026-10-10: the (Call-ID, CSeq) dedup guard. This is a loopback
        // deployment with ims_dialog detect_spirals=0, so one reply traverses
        // P-CSCF twice and the N5 authorization route ran once per traversal.
        // The second run PATCHed over the first's correct PCC rule with
        // relay-to-relay filters carrying no UE address, so the GBR flow never
        // matched real downlink RTP and the handset tore the call down with
        // BYE "Media bearer loss" at a repeatable ~6.1s. That was the
        // long-standing "drops at ~5 seconds" symptom.
        if (!/sht_lock\("n5_auth_dedup=>\$ci"\)/.test(content)) {
          problems.push(`${label} is missing the n5_auth_dedup (Call-ID, CSeq) guard — without it a spiralled call authorizes N5 twice and the second PATCH overwrites a correct PCC rule, which drops every call at ~6.1s`);
        }
        if (!/\$sht\(n5_auth_dedup=>\$ci\) != \$cs/.test(content)) {
          problems.push(`${label}'s n5_auth_dedup guard must compare $sht() against $cs directly (CSeq-keyed, so genuine mid-call re-INVITE/UPDATE still PATCHes, and no $var() null->0 coercion)`);
        }
        // The N5 port-mismatch fix still has to be present, but WHERE it lives
        // differs per file and that difference is itself load-bearing.
        //
        // Updated 2026-10-05: this guard originally required >=2
        // msg_apply_changes() right after route(NATMANAGE) in BOTH files. That
        // is now correct ONLY for mo.cfg. In mt.cfg the reparse was
        // deliberately MOVED into route[MT_N5_CALL_PCF_POLICY_AUTH], because
        // running it straight after NATMANAGE also re-parsed the SDP that
        // ims_qos's w_rx_aar() reads for the TERMINATING direction, making
        // every MT-leg Rx AA-Request carry rtpengine's relay address as
        // Framed-IP-Address instead of the real UE IP (PCRF: "Cannot find Gx
        // Session for IPv4:<pcscf addr>"). That broke 4G-4G calling outright
        // for several days after commit 313c6da. So mt.cfg is asserted the
        // OPPOSITE way on purpose: the reparse must exist in the N5 route and
        // must NOT be back after NATMANAGE. Do not "fix" a failure here by
        // restoring the old placement — that reintroduces a real outage.
        const applyCount = (content.match(/msg_apply_changes\(\);/g) ?? []).length;
        if (label === 'mo.cfg') {
          if (applyCount < 2) {
            problems.push(`mo.cfg has only ${applyCount} msg_apply_changes() call(s) (expected 2: initial + in-dialog reply) — N5 port-mismatch fix may have been lost`);
          }
        } else {
          if (applyCount < 1) {
            problems.push('mt.cfg has no msg_apply_changes() at all — the N5 port-mismatch fix has been lost entirely');
          }
          // Must sit inside the N5 route, after Rx_AAR has already done its own
          // parse. Anchor on the route DEFINITION at start-of-line and bound it
          // by the next one: this file legitimately mentions
          // "route[MT_N5_CALL_PCF_POLICY_AUTH]" inside several explanatory
          // comments that all appear BEFORE the real definition, so a naive
          // split() on the bare name lands between two comments and reads an
          // empty route body (which is exactly how an earlier version of this
          // guard produced a false failure).
          const defIdx = content.search(/^route\[MT_N5_CALL_PCF_POLICY_AUTH\]/m);
          let n5Route = '';
          if (defIdx >= 0) {
            const after = content.slice(defIdx + 1);
            const nextIdx = after.search(/^route\[/m);
            n5Route = nextIdx >= 0 ? after.slice(0, nextIdx) : after;
          }
          if (!/msg_apply_changes\(\);/.test(n5Route)) {
            problems.push('mt.cfg has no msg_apply_changes() inside route[MT_N5_CALL_PCF_POLICY_AUTH] — the 2026-10-05 Rx Framed-IP-Address fix relocated it there; N5 will read a stale SDP port without it');
          }
          // And must NOT have been moved back to directly after NATMANAGE.
          // 2026-10-08: the reparse must be skipped on the async Diameter
          // callback path. There the message is a restored/faked one whose
          // buffer is not the normal pkg receive buffer, so rebuilding it in
          // place corrupted the parser (`qm_free(): BUG: bad pointer`) and
          // aborted the route before it ever issued the N5 request — making
          // 5G calling impossible, since that async path is the only path a
          // 5G leg can take (Rx always fails for NR with 5065).
          if (!/\$avp\(n5_async_entry\)/.test(content)) {
            problems.push('mt.cfg is missing the $avp(n5_async_entry) guard — without it msg_apply_changes() runs on the async Diameter callback path, corrupts the SIP parser, and aborts N5 before the request is sent (5G calling fails outright)');
          }
          if (/route\(NATMANAGE\);\s*(?:#[^\n]*\n\s*)*msg_apply_changes\(\);/.test(content)) {
            problems.push('mt.cfg has msg_apply_changes() directly after route(NATMANAGE) again — this is the 2026-10-05 Rx Framed-IP-Address regression that broke 4G-4G calling; it belongs in route[MT_N5_CALL_PCF_POLICY_AUTH] instead');
          }
        }
      }

      if (problems.length > 0) return fail(problems.join('; '));
      return pass('fr_timer=10000; N5 port-mismatch + AppSession checks present; mt.cfg reparse correctly scoped to route[MT_N5_CALL_PCF_POLICY_AUTH]');
    },
  },
  {
    name: 'POST /validate',
    async run({ client }) {
      const res = await client.post('/api/ims/validate');
      assertOk(res, 'POST /api/ims/validate');
      if (!Array.isArray(res.data?.checks)) return fail('response missing "checks" array', res.data);
      return pass(`${res.data.checks.length} check(s), ${res.data.checks.filter(c => c.pass).length} passing`);
    },
  },

  // ── safe writes (no restart of a live core NF) ────────────────────
  {
    name: 'PUT /configs/content — round-trip edit on the lowest-risk manifest file',
    async run({ client, revertQueue }) {
      if (!(await installed(client))) return skip('IMS not installed');
      const manifestRes = await client.get('/api/ims/configs');
      assertOk(manifestRes, 'GET /api/ims/configs');
      const files = manifestRes.data.files ?? [];
      if (files.length === 0) return skip('manifest is empty on this instance');
      // Prefer a file with zero associated restartServices (editing it has
      // no live-reload side effect at all on this instance) — fall back to
      // the first manifest entry if none exist.
      const target = files.find(f => Array.isArray(f.restartServices) && f.restartServices.length === 0) ?? files[0];

      const readRes = await client.get(`/api/ims/configs/content?path=${encodeURIComponent(target.path)}`);
      assertOk(readRes, 'GET /api/ims/configs/content');
      const original = readRes.data.content;
      const marker = `\n# api-regression-test-marker ${Date.now()}\n`;
      const testContent = original + marker;

      revertQueue.push(`restore original content of ${target.path}`, async () => {
        const current = await client.get(`/api/ims/configs/content?path=${encodeURIComponent(target.path)}`);
        if (current.data?.content !== original) {
          await client.put('/api/ims/configs/content', { path: target.path, content: original });
        }
      });

      const writeRes = await client.put('/api/ims/configs/content', { path: target.path, content: testContent });
      assertOk(writeRes, 'PUT /api/ims/configs/content (test content)');

      const verifyRes = await client.get(`/api/ims/configs/content?path=${encodeURIComponent(target.path)}`);
      assertEqual(verifyRes.data?.content, testContent, `content of ${target.path} after write`);

      const revertRes = await client.put('/api/ims/configs/content', { path: target.path, content: original });
      assertOk(revertRes, 'PUT /api/ims/configs/content (revert)');
      const revertVerify = await client.get(`/api/ims/configs/content?path=${encodeURIComponent(target.path)}`);
      assertEqual(revertVerify.data?.content, original, `content of ${target.path} after revert`);

      return pass(`round-tripped ${target.path} (${target.restartServices.length === 0 ? 'no restart target' : 'has restart targets, not triggered'})`);
    },
  },
  {
    // Verifies the REAL generated file, not just the self-reported status
    // flag: setSmsDeliveryMode() writes scscf.cfg via scscfIncludeCfg(),
    // which emits the literal line "#!define ROUTE_SMS_TO_VECTORCORE" only
    // when mode==='vectorcore' (ims-controller.ts:459-460). This is exactly
    // the class of bug this suite exists to catch — a toggle whose /status
    // claims success while the actual generated config never changed (see
    // CLAUDE.md's own "static Kamailio template" / staleness gotchas).
    name: 'POST /sms-delivery-mode (ims <-> vectorcore) — verifies scscf.cfg content, not just /status',
    async run({ client, revertQueue }) {
      if (!(await installed(client))) return skip('IMS not installed');
      const statusRes = await client.get('/api/ims/status');
      const original = statusRes.data?.smsDeliveryMode;
      if (!['sgs', 'ims', 'vectorcore'].includes(original)) {
        return fail(`Unrecognized current smsDeliveryMode: ${JSON.stringify(original)}`);
      }
      // Never picks 'sgs' as the test target — CLAUDE.md documents a real,
      // open two-UE SGs delivery bug.
      const testValue = original === 'ims' ? 'vectorcore' : 'ims';
      const scscfCfgPath = '/etc/kamailio_scscf/scscf.cfg';
      const readScscfCfg = async () => {
        const r = await client.get(`/api/ims/configs/content?path=${encodeURIComponent(scscfCfgPath)}`);
        return r.data?.content ?? '';
      };
      const hasMarker = (content) => content.includes('#!define ROUTE_SMS_TO_VECTORCORE');

      revertQueue.push('revert sms delivery mode', async () => {
        const current = await client.get('/api/ims/status');
        if (current.data?.smsDeliveryMode !== original) {
          await client.post('/api/ims/sms-delivery-mode', { mode: original });
          await waitForScscfSettled(client);
        }
      });

      const setRes = await client.post('/api/ims/sms-delivery-mode', { mode: testValue });
      assertOk(setRes, 'POST /api/ims/sms-delivery-mode (test value)');
      await waitForScscfSettled(client);
      const readBack = await client.get('/api/ims/status');
      assertEqual(readBack.data?.smsDeliveryMode, testValue, 'smsDeliveryMode after set (status API)');
      const cfgAfterSet = await readScscfCfg();
      const expectMarkerAfterSet = testValue === 'vectorcore';
      if (hasMarker(cfgAfterSet) !== expectMarkerAfterSet) {
        return fail(
          `/status reported mode="${testValue}" but scscf.cfg's ROUTE_SMS_TO_VECTORCORE marker is ` +
          `${hasMarker(cfgAfterSet) ? 'present' : 'absent'} (expected ${expectMarkerAfterSet ? 'present' : 'absent'}) — ` +
          `the GUI toggle is not actually producing the expected backend config.`,
        );
      }

      const revertRes = await client.post('/api/ims/sms-delivery-mode', { mode: original });
      assertOk(revertRes, 'POST /api/ims/sms-delivery-mode (revert)');
      await waitForScscfSettled(client);
      const revertReadBack = await client.get('/api/ims/status');
      assertEqual(revertReadBack.data?.smsDeliveryMode, original, 'smsDeliveryMode after revert (status API)');
      const cfgAfterRevert = await readScscfCfg();
      const expectMarkerAfterRevert = original === 'vectorcore';
      if (hasMarker(cfgAfterRevert) !== expectMarkerAfterRevert) {
        return fail(`Reverted /status to "${original}" but scscf.cfg's marker did not revert to match.`);
      }

      return pass(`toggled ${original} -> ${testValue} -> ${original}, verified in scscf.cfg both times`);
    },
  },
  {
    // Verifies the REAL generated Diameter XML, not just /status:
    // setVoiceChargingEnabled() writes scscf.xml via scscfDiameterXml(),
    // which emits a literal <Peer FQDN="..."/> element only when OCS peer
    // info is present (ims-controller.ts:615) — i.e. only when charging is
    // genuinely wired up, not just flagged on in state.
    name: 'POST /voice-charging toggle — verifies scscf.xml <Peer> element, not just /status',
    async run({ client, revertQueue }) {
      if (!(await installed(client))) return skip('IMS not installed');
      const statusRes = await client.get('/api/ims/status');
      if (statusRes.data?.voiceChargingEnabled === undefined) {
        return skip('voiceChargingEnabled not present in /api/ims/status on this instance');
      }
      const original = statusRes.data.voiceChargingEnabled;
      const testValue = !original;
      const scscfXmlPath = '/etc/kamailio_scscf/scscf.xml';
      const readScscfXml = async () => {
        const r = await client.get(`/api/ims/configs/content?path=${encodeURIComponent(scscfXmlPath)}`);
        return r.data?.content ?? '';
      };
      // scscf.xml always carries an HSS <Peer> (Cx) regardless of voice
      // charging state — a bare '<Peer FQDN=' check would false-positive
      // on that one. Match the OCS peer specifically by its "ocs." FQDN
      // prefix convention (confirmed live: CLAUDE.md documents
      // ocs.epc.mnc<mnc>.mcc<mcc>.3gppnetwork.org as the derived default).
      const hasOcsPeer = (content) => /<Peer FQDN="ocs\./.test(content);

      revertQueue.push('revert voice charging toggle', async () => {
        const current = await client.get('/api/ims/status');
        if (current.data?.voiceChargingEnabled !== original) {
          await client.post('/api/ims/voice-charging', { enabled: original });
          await waitForScscfSettled(client);
        }
      });

      const setRes = await client.post('/api/ims/voice-charging', { enabled: testValue });
      if (testValue === true && !setRes.ok) {
        // Turning it ON hard-fails if OCS isn't configured (by design, per
        // this function's own header comment) — that's a legitimate,
        // environment-dependent skip, not a suite failure.
        return skip(`could not enable voice charging (likely SigScale OCS not configured on this instance): ${JSON.stringify(setRes.data)}`);
      }
      assertOk(setRes, 'POST /api/ims/voice-charging (test value)');
      await waitForScscfSettled(client);
      const readBack = await client.get('/api/ims/status');
      assertEqual(readBack.data?.voiceChargingEnabled, testValue, 'voiceChargingEnabled after set (status API)');
      const xmlAfterSet = await readScscfXml();
      if (hasOcsPeer(xmlAfterSet) !== testValue) {
        return fail(
          `/status reported voiceChargingEnabled=${testValue} but scscf.xml's <Peer> element is ` +
          `${hasOcsPeer(xmlAfterSet) ? 'present' : 'absent'} (expected ${testValue ? 'present' : 'absent'}).`,
        );
      }

      const revertRes = await client.post('/api/ims/voice-charging', { enabled: original });
      assertOk(revertRes, 'POST /api/ims/voice-charging (revert)');
      await waitForScscfSettled(client);
      const revertReadBack = await client.get('/api/ims/status');
      assertEqual(revertReadBack.data?.voiceChargingEnabled, original, 'voiceChargingEnabled after revert (status API)');
      const xmlAfterRevert = await readScscfXml();
      if (hasOcsPeer(xmlAfterRevert) !== original) {
        return fail(`Reverted /status to ${original} but scscf.xml's <Peer> element did not revert to match.`);
      }

      return pass(`toggled ${original} -> ${testValue} -> ${original}, verified in scscf.xml both times`);
    },
  },
  {
    // setSmsWorkerInterval() writes kamailio_smsc.cfg, which is NOT in the
    // /api/ims/configs manifest (no read API exists for it on this
    // instance) — so unlike the two toggles above, this can only verify
    // via the self-reported /status value, not the real generated file.
    // Flagged here rather than silently treated as equivalent coverage.
    name: 'POST /sms-worker-interval (status-API-only verification — kamailio_smsc.cfg has no read API)',
    async run({ client, revertQueue }) {
      if (!(await installed(client))) return skip('IMS not installed');
      const statusRes = await client.get('/api/ims/status');
      const original = statusRes.data?.smsWorkerIntervalSeconds;
      if (typeof original !== 'number') {
        return skip('smsWorkerIntervalSeconds not present in /api/ims/status on this instance');
      }
      const testValue = original === 30 ? 45 : 30;
      revertQueue.push('revert sms-worker-interval', async () => {
        const current = await client.get('/api/ims/status');
        if (current.data?.smsWorkerIntervalSeconds !== original) {
          await client.post('/api/ims/sms-worker-interval', { seconds: original });
        }
      });
      const setRes = await client.post('/api/ims/sms-worker-interval', { seconds: testValue });
      assertOk(setRes, 'POST /api/ims/sms-worker-interval (test value)');
      assertEqual(setRes.data?.seconds, testValue, 'response echoes test value');
      const revertRes = await client.post('/api/ims/sms-worker-interval', { seconds: original });
      assertOk(revertRes, 'POST /api/ims/sms-worker-interval (revert)');
      assertEqual(revertRes.data?.seconds, original, 'response echoes reverted value');
      return pass(`toggled ${original} -> ${testValue} -> ${original}`);
    },
  },
  {
    name: 'POST /sync-subscribers',
    async run({ client }) {
      if (!(await installed(client))) return skip('IMS not installed');
      const res = await client.post('/api/ims/sync-subscribers');
      assertOk(res, 'POST /api/ims/sync-subscribers');
      if (typeof res.data?.synced !== 'number') return fail('response missing numeric "synced"', res.data);
      return pass(`synced=${res.data.synced} failed=${res.data.failed?.length ?? 0} removed=${res.data.removed}`);
    },
  },

  // ── disruptive: restarts live, always-on services ─────────────────
  {
    name: 'POST /configs/restart (kamailio-pcscf)',
    disruptive: true,
    async run({ client }) {
      if (!(await installed(client))) return skip('IMS not installed');
      const res = await client.post('/api/ims/configs/restart', { services: ['kamailio-pcscf'] });
      assertOk(res, 'POST /api/ims/configs/restart');
      return pass('kamailio-pcscf restarted on request');
    },
  },
  {
    name: 'POST /restart (all IMS services)',
    disruptive: true,
    async run({ client }) {
      if (!(await installed(client))) return skip('IMS not installed');
      const res = await client.post('/api/ims/restart');
      assertOk(res, 'POST /api/ims/restart');
      return pass('IMS services restarted on request');
    },
  },
  {
    name: 'POST /disable then /enable (full IMS stop/start cycle)',
    disruptive: true,
    async run({ client, revertQueue }) {
      if (!(await installed(client))) return skip('IMS not installed');
      // /enable IS the revert for /disable — register it before disabling.
      revertQueue.push('re-enable IMS (undo /disable)', async () => {
        await client.post('/api/ims/enable');
      });
      const disableRes = await client.post('/api/ims/disable');
      assertOk(disableRes, 'POST /api/ims/disable');
      const enableRes = await client.post('/api/ims/enable');
      assertOk(enableRes, 'POST /api/ims/enable');
      return pass('disable -> enable cycle completed');
    },
  },
  {
    name: 'POST /configure (full reconfigure)',
    disruptive: true,
    async run({ client }) {
      if (!(await installed(client))) return skip('IMS not installed');
      const res = await client.post('/api/ims/configure');
      assertOk(res, 'POST /api/ims/configure');
      return pass('reconfigure completed');
    },
  },

  // ── deliberately not exercised — see file header for why ──────────
  {
    name: 'POST /live/deregister (not exercised)',
    async run() {
      return skip('force-deregisters a real subscriber with no safe revert — see this file\'s header comment');
    },
  },
  {
    name: 'POST /install (not exercised)',
    async run() {
      return skip('multi-minute real package install with no provable revert — see this file\'s header comment; covered indirectly by /status.installed');
    },
  },
  {
    name: 'POST /remove (not exercised)',
    async run() {
      return skip('full uninstall with no provable revert — see this file\'s header comment');
    },
  },
];
