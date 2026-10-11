#!/usr/bin/env node
// Adversarial second pass over a report.json already produced by run.mjs.
// This does NOT re-run the original test cases — it independently
// re-queries the live instance, fresh, to check the one thing a test case
// claiming "pass, and I reverted it" can get wrong without anyone noticing:
// a revert that *looked* successful (no error thrown) but didn't actually
// stick, or a leftover artifact the original case didn't think to check
// for. That's a genuinely different failure mode from "the test assertion
// itself was wrong," which is why this is a separate pass, not more
// assertions bolted onto the original test case.
//
// What this can't do: judge whether a test case's own assertions were
// checking the *right* thing in the first place (e.g. "is amf_name really
// the lowest-risk field to touch here?") or whether a recorded `fail`
// reflects a real product bug vs. a bug in the test case's own payload
// shape. That's genuine judgment, not re-queryable fact — read the report's
// `evidence` field (every module.test.mjs is written to populate it with
// enough detail for exactly this) and reason about it directly, the same
// way you'd review any other test suite's output.
//
// Usage: node critic/critic.mjs <report.json> [--base-url http://localhost:3001]
//                                              [--username admin] [--password admin]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiClient } from '../lib/client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  if (argv.length === 0 || argv[0].startsWith('--')) {
    console.error('Usage: node critic/critic.mjs <report.json> [--base-url ...] [--username ...] [--password ...]');
    process.exit(2);
  }
  const args = { reportPath: argv[0], baseUrl: 'http://localhost:3001', username: 'admin', password: 'admin' };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--base-url') args.baseUrl = argv[++i];
    else if (argv[i] === '--username') args.username = argv[++i];
    else if (argv[i] === '--password') args.password = argv[++i];
  }
  return args;
}

// Per-module re-check functions. Each receives the module's own recorded
// results (in case it needs an IMSI or similar from a specific case's
// evidence) and the live client, and returns a list of findings — empty
// means "nothing suspicious found," not "everything in this module was
// checked" (only modules listed here get any critic re-check at all; see
// the final summary for which ones that covers).
const RECHECKS = {
  async subscribers(client, results) {
    const findings = [];
    const TEST_IMSI = '999700000000001';
    const res = await client.get(`/api/subscribers/${TEST_IMSI}`);
    const deleteCase = results.find(r => r.name === 'delete test subscriber');
    if (deleteCase?.status === 'pass' && res.status !== 404) {
      findings.push(`"delete test subscriber" reported pass, but the test subscriber ${TEST_IMSI} is still readable now (HTTP ${res.status}) — leftover test data.`);
    }
    return findings;
  },
  async ims(client, results) {
    const findings = [];
    const statusRes = await client.get('/api/ims/status');
    if (!statusRes.data?.installed) return findings; // consistent with the original skip
    const smsCase = results.find(r => r.name.includes('/sms-delivery-mode'));
    if (smsCase?.status === 'pass') {
      const m = /toggled (\w+) -> (\w+) -> (\w+)/.exec(smsCase.detail ?? '');
      if (m && statusRes.data?.smsDeliveryMode !== m[3]) {
        findings.push(`sms delivery mode case reported pass+revert to "${m[3]}", but current live value is "${statusRes.data?.smsDeliveryMode}".`);
      }
      // Independently re-verify the REAL file too, not just /status — this
      // is the whole point of this module (see ims.test.mjs's own header).
      if (m) {
        const cfgRes = await client.get(`/api/ims/configs/content?path=${encodeURIComponent('/etc/kamailio_scscf/scscf.cfg')}`);
        const hasMarker = (cfgRes.data?.content ?? '').includes('#!define ROUTE_SMS_TO_VECTORCORE');
        const expected = m[3] === 'vectorcore';
        if (hasMarker !== expected) {
          findings.push(`sms delivery mode reverted /status to "${m[3]}" but scscf.cfg's ROUTE_SMS_TO_VECTORCORE marker (${hasMarker ? 'present' : 'absent'}) doesn't match.`);
        }
      }
    }
    const vcCase = results.find(r => r.name.includes('/voice-charging'));
    if (vcCase?.status === 'pass' && statusRes.data?.voiceChargingEnabled !== undefined) {
      const m = /toggled (\w+) -> (\w+) -> (\w+)/.exec(vcCase.detail ?? '');
      if (m) {
        const expectedOriginal = m[3] === 'true';
        if (statusRes.data.voiceChargingEnabled !== expectedOriginal) {
          findings.push(`voice charging toggle reported pass+revert to ${expectedOriginal}, but current live value is ${statusRes.data.voiceChargingEnabled}.`);
        }
        const xmlRes = await client.get(`/api/ims/configs/content?path=${encodeURIComponent('/etc/kamailio_scscf/scscf.xml')}`);
        const hasOcsPeer = /<Peer FQDN="ocs\./.test(xmlRes.data?.content ?? '');
        if (hasOcsPeer !== expectedOriginal) {
          findings.push(`voice charging reverted /status to ${expectedOriginal} but scscf.xml's OCS <Peer> (${hasOcsPeer ? 'present' : 'absent'}) doesn't match.`);
        }
      }
    }
    return findings;
  },
  async ['core-config'](client, results) {
    const findings = [];
    const editCase = results.find(r => r.name.includes('amf_name'));
    if (editCase?.status === 'pass' && editCase.evidence?.originalAmfName) {
      const current = await client.get('/api/config/amf');
      const currentName = current.data?.data?.amf?.amf_name;
      if (currentName !== editCase.evidence.originalAmfName) {
        findings.push(`amf_name edit+revert reported pass (original="${editCase.evidence.originalAmfName}"), but current live amf_name is "${currentName}".`);
      }
    }
    return findings;
  },
  async ['charging-plans'](client, results) {
    const findings = [];
    const lifecycleCase = results.find(r => r.name.startsWith('full lifecycle'));
    if (lifecycleCase?.status === 'pass' && lifecycleCase.evidence?.planId) {
      const planId = lifecycleCase.evidence.planId;
      const plansRes = await client.get('/api/charging-plans/');
      if (plansRes.data?.data?.some(p => p._id === planId)) {
        findings.push(`lifecycle test reported pass (deleted plan ${planId}), but it still exists in the live plan list.`);
      }
      // The real bug this suite found and fixed (2026-10-02): deleting a
      // subscriber used to leave an orphaned OCS service+product behind
      // forever. Independently re-verify via a direct OCS RPC that the
      // test subscriber's identity genuinely has no lingering service —
      // not just that the plan list looks clean.
      try {
        const { runOcsEval, getOcsNodeName } = await import('../../../backend/dist/interfaces/rest/ocs-controller.js');
        const node = await getOcsNodeName();
        const script = [
          `Node = '${node}',`,
          `Ocs = fun(F, A) -> rpc:call(Node, ocs, F, A) end,`,
          `case Ocs(find_service, [<<"999700000000002">>]) of`,
          `  {ok, _} -> io:format("STILL_EXISTS~n");`,
          `  _ -> io:format("CLEAN~n")`,
          `end,`,
          `init:stop().`,
        ].join('\n');
        const stdout = await runOcsEval(script, 15000);
        if (stdout.includes('STILL_EXISTS')) {
          findings.push('test subscriber 999700000000002 still has a live OCS service record after the lifecycle test\'s delete step — the OCS-side cleanup (removeSubscriberFromOcs) did not take effect.');
        }
      } catch (err) {
        findings.push(`could not independently verify OCS-side cleanup (critic pass itself errored): ${String(err)}`);
      }
    }
    return findings;
  },
  async ['subscriber-groups'](client, results) {
    const findings = [];
    const lifecycleCase = results.find(r => r.name.startsWith('full lifecycle'));
    if (lifecycleCase?.status === 'pass' && lifecycleCase.evidence?.groupId) {
      const res = await client.get('/api/subscriber-groups/');
      if (res.data?.data?.some(g => g._id === lifecycleCase.evidence.groupId)) {
        findings.push(`lifecycle test reported pass (deleted group ${lifecycleCase.evidence.groupId}), but it still exists in the live list.`);
      }
    }
    const permCase = results.find(r => r.name.includes('viewer role is refused'));
    if (permCase?.status === 'pass') {
      const usersRes = await client.get('/api/users/');
      const stillExists = (usersRes.data?.data?.users ?? []).some(u => u.username === 'api-regression-test-viewer');
      if (stillExists) {
        findings.push('permission test reported pass, but the throwaway test viewer account still exists — cleanup did not take effect.');
      }
    }
    return findings;
  },
  async sas(client, results) {
    const findings = [];
    const lifecycleCase = results.find(r => r.name.startsWith('CBSD protocol lifecycle'));
    if (lifecycleCase?.status === 'pass' && lifecycleCase.evidence?.cbsdId) {
      const res = await client.get('/api/sas/admin/cbsds');
      if (res.data?.cbsds?.some(c => c.cbsdId === lifecycleCase.evidence.cbsdId)) {
        findings.push(`SAS lifecycle test reported pass (deleted CBSD ${lifecycleCase.evidence.cbsdId}), but it still exists in the live list.`);
      }
      const policyRes = await client.get('/api/sas/admin/policies/cbsds');
      if (policyRes.data?.policies?.some(p => p._id === '#2345CBSDTEST01:AH193701274.NR')) {
        findings.push('SAS lifecycle test reported pass, but the test CBSD\'s band policy override is still present.');
      }
    }
    const pauseCase = results.find(r => r.name.includes('/admin/pause'));
    if (pauseCase?.status === 'pass') {
      const statusRes = await client.get('/api/sas/admin/status');
      if (statusRes.data?.paused !== false) {
        findings.push(`pause/resume test reported pass, but SAS is currently paused=${statusRes.data?.paused} — real radios may be unable to maintain their grants right now.`);
      }
    }
    return findings;
  },
  async ['apn-profile'](client, results) {
    const findings = [];
    const lifecycleCase = results.find(r => r.name.startsWith('full profile lifecycle'));
    if (lifecycleCase?.status === 'pass' && lifecycleCase.evidence?.profileId) {
      const res = await client.get('/api/apn-profiles/');
      if (res.data?.profiles?.some(p => p.id === lifecycleCase.evidence.profileId)) {
        findings.push(`apn-profile lifecycle test reported pass (deleted profile ${lifecycleCase.evidence.profileId}), but it still exists in the live list.`);
      }
      const smfRes = await client.get('/api/config/smf');
      if ((smfRes.data?.data?.smf?.session ?? []).some(s => s.dnn === 'apiregressiontest')) {
        findings.push('apn-profile lifecycle test reported pass, but smf.yaml still has an orphaned session for the deleted test dnn.');
      }
      const upfRes = await client.get('/api/config/upf');
      if ((upfRes.data?.data?.upf?.session ?? []).some(s => s.dev === 'ogstun98')) {
        findings.push('apn-profile lifecycle test reported pass, but upf.yaml still has an orphaned session for the deleted test dev.');
      }
    }
    return findings;
  },
  async users(client, results) {
    const findings = [];
    const lifecycleCase = results.find(r => r.name.startsWith('full lifecycle'));
    if (lifecycleCase?.status === 'pass') {
      const res = await client.get('/api/users/');
      const users = res.data?.data?.users ?? res.data?.users ?? [];
      if (users.some(u => u.username === 'api-regression-test-user')) {
        findings.push('users lifecycle test reported pass, but the throwaway test user still exists in the live list.');
      }
    }
    return findings;
  },
  async hnbgw(client, results) {
    const findings = [];
    const lifecycleCase = results.find(r => r.name.startsWith('full virtual HNB lifecycle'));
    if (lifecycleCase?.status === 'pass') {
      const res = await client.get('/api/hnbgw/status');
      if (!res.data?.hnbListRaw?.includes('1 HNB connected')) {
        findings.push(`virtual HNB lifecycle test reported pass, but the HNBGW's own live "show hnb all" no longer shows it connected (hnbListRaw: ${JSON.stringify(res.data?.hnbListRaw)}).`);
      }
    }
    return findings;
  },
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reportRaw = JSON.parse(fs.readFileSync(path.resolve(args.reportPath), 'utf-8'));

  console.log(`Critic pass over: ${args.reportPath}`);
  console.log(`Re-querying live instance at: ${args.baseUrl}\n`);

  const client = new ApiClient(args.baseUrl);
  await client.login(args.username, args.password);

  const byModule = {};
  for (const r of reportRaw.results) (byModule[r.module] ??= []).push(r);

  const allFindings = [];
  const checkedModules = [];
  for (const [mod, recheck] of Object.entries(RECHECKS)) {
    if (!byModule[mod]) continue;
    checkedModules.push(mod);
    const findings = await recheck(client, byModule[mod]);
    for (const f of findings) allFindings.push({ module: mod, finding: f });
  }

  console.log(`Independently re-checked: ${checkedModules.join(', ') || '(none — no recheck defined for any module in this report)'}`);

  // Read-only checks (no revertQueue.push in the originating test case —
  // GET-only, nothing was ever changed) have nothing for a revert-recheck
  // to verify; only flag genuinely *mutating* passes that lack a recheck,
  // so this list means "a module that changes state but has no automated
  // double-check yet," not "everything not in this list was under-reviewed."
  const mutatingModules = new Set(reportRaw.results.filter(r => r.evidence || /revert|toggle|edit|create|delete/i.test(r.name)).map(r => r.module));
  const uncheckedPasses = reportRaw.results.filter(
    r => r.status === 'pass' && !checkedModules.includes(r.module) && mutatingModules.has(r.module),
  );
  const readOnlyPassCount = reportRaw.results.filter(
    r => r.status === 'pass' && !checkedModules.includes(r.module) && !mutatingModules.has(r.module),
  ).length;
  if (readOnlyPassCount > 0) {
    console.log(`${readOnlyPassCount} "pass" result(s) are read-only checks (no state was changed) — nothing for a revert-recheck to verify.`);
  }
  if (uncheckedPasses.length > 0) {
    console.log(
      `\n${uncheckedPasses.length} "pass" result(s) look like they may mutate state but have no automated recheck defined yet ` +
      `(add one to RECHECKS in this file as new test modules are added):`,
    );
    for (const r of uncheckedPasses) console.log(`  - ${r.module}/${r.name}`);
  }

  if (allFindings.length === 0) {
    console.log('\n✅ No discrepancies found — every independently-rechecked "pass" still holds against live state.');
  } else {
    console.log(`\n❌ ${allFindings.length} discrepancy(ies) found:`);
    for (const f of allFindings) console.log(`  - [${f.module}] ${f.finding}`);
  }

  console.log(
    `\nReminder: this pass only re-verifies revert-claims against live state. It does NOT judge ` +
    `whether "fail"/"error" results in the report are real product bugs vs. test-case bugs, or ` +
    `whether a case's own assertions were checking the right thing — read each result's own ` +
    `"evidence" field in the report for that.`,
  );

  process.exit(allFindings.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL: critic pass itself errored:', err);
  process.exit(1);
});
