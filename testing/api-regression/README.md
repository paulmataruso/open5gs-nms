# open5gs-nms API regression suite

A generic, self-healing API regression harness: logs in, exercises the
backend endpoint behind every GUI control it has test cases for, verifies
the change actually took effect via an independent read-back (not just "the
HTTP call returned 200"), and reverts everything it touched before exiting.

Zero npm dependencies — only needs `node` (18+, for built-in `fetch`) on
PATH. Designed to run against **any** open5gs-nms instance: pass `--base-url`
for anything other than a local instance on the default port.

## Run it

```
node testing/api-regression/run.mjs
```

Options:

- `--base-url <url>` — default `http://localhost:3001`
- `--username <name>` / `--password <pass>` — default `admin` / `admin`
- `--only <module1,module2>` — run only the named test modules (see each
  file's exported `MODULE` constant)
- `--include-disruptive` — also run test cases marked `disruptive: true`
  (anything that restarts a live, always-on core NF — e.g. the core-17
  config Apply cycle). **Off by default** — these are real, if brief,
  live-traffic-affecting restarts, not sandboxed writes. Don't pass this
  against a production instance without knowing what you're opting into.
- `--out <path>` — where to write the full JSON report (default:
  `reports/report-<timestamp>.json`)

Exit code is non-zero if any test case ended `fail` or `error` — safe to
wire into CI.

## What "safe to run anywhere" actually means here

- Every case that creates or edits something registers its own undo on a
  shared revert queue *before* it's even verified the change worked, so a
  change that "succeeded" but failed verification still gets cleaned up.
  The revert queue drains in a `finally` (reverse order), so a crash
  mid-suite still attempts to clean up everything queued so far.
- Mutating cases use clearly-marked throwaway test data (e.g. the test
  subscriber IMSI is in the unused 999-70 test-PLMN range) rather than
  touching real records, and refuse to proceed (`fail`, not silently
  overwrite) if that test data already exists.
- Disruptive cases (core-NF-restarting) are opt-in only — see
  `--include-disruptive` above.
- A module not installed/enabled on the target instance is reported
  `skipped`, not `fail` — this is what makes the suite portable across
  differently-configured deployments (per-instance `ENABLE_*_MODULE` flags).
- No test case ever throws past the harness: `lib/test-case.mjs`'s
  `runCase()` wraps every case in its own try/catch and records a thrown
  exception as an `error` result instead of aborting the run. One broken
  endpoint can't take down testing of everything else.

## Structure

```
run.mjs                      CLI entry point / orchestrator
lib/
  client.mjs                 zero-dependency HTTP client (login + cookie replay)
  revert-queue.mjs           LIFO undo stack
  report.mjs                 result collection, console + JSON output
  test-case.mjs               runCase() safety wrapper + assert helpers + skip()/pass()/fail()
modules/
  *.test.mjs                 one file per feature area — see below
critic/
  critic.mjs                  adversarial second pass over a report (see below)
reports/                     JSON output from each run (gitignored)
```

### Adding a new test module

Create `modules/<name>.test.mjs` exporting:

```js
export const MODULE = 'my-module';
export const CASES = [
  {
    name: 'does the thing',
    // disruptive: true,   // only if this restarts a live core NF
    async run({ client, revertQueue }) {
      // 1. read current state
      // 2. revertQueue.push('label', async () => { /* restore it */ })
      // 3. make the change
      // 4. independently read it back and assert it matches
      // 5. return pass(...) / fail(...) / skip(...) from lib/test-case.mjs
    },
  },
];
```

It's picked up automatically — `run.mjs` loads every `modules/*.test.mjs`
file on startup, no registration step needed.

## Current coverage

Covers the great majority of modules now — extending it to whatever's left
follows the same read → change → verify (real backend artifact, not just a
self-reported status flag) → revert pattern already established below.

- `module-status-sweep` — every module's `GET /status` responds (read-only,
  broad, shallow)
- `subscribers` — full create/edit/list/delete cycle for a throwaway test
  subscriber
- `core-config` — read all 17 core NF configs; validate; a disruptive
  edit+revert of one cosmetic field (`amf_name`) via a real Apply cycle
- `ims` — all 19 routes in ims-controller.ts: every read-only endpoint,
  config-file round-trip editing, the SMS-delivery-mode and voice-charging
  toggles (verified against the *real generated* scscf.cfg/scscf.xml
  content, not just `/status` — see the module's own header), sync-
  subscribers, and (gated behind `--include-disruptive`) restart/configure/
  enable-disable cycles. Three routes are deliberately not exercised even
  under that flag (`/live/deregister`, `/install`, `/remove`) — see the
  module header for why each has no safe, provable revert.
- `charging-plans` — full create → edit → assign → usage → delete lifecycle
  against a real SigScale OCS backend, the auto-provisioned "Unlimited"
  plan, input validation, and the delete-while-assigned guard.
- `subscriber-groups` — full create/edit/delete lifecycle, plus a real
  regression test for a documented 2026-09-30 permission bug (viewer role
  could mutate groups) — creates a throwaway viewer account and confirms
  it's refused (403) on all 3 mutating routes.
- `sas` — all 36 routes in sas-controller.ts, including the 6
  unauthenticated WINNF-TS-0016 protocol endpoints real CBSD radios speak
  (registration → spectrumInquiry → grant → heartbeat → relinquishment →
  deregistration), run against this project's own already-sanctioned test
  CBSD identity (the Category-B-exempt `#2345CBSDTEST01`/`AH193701274.NR`
  from sas-service.ts). The grant step genuinely verifies the real 75s
  GPS-lock delay when it's in effect (and degrades gracefully, not a
  failure, when a recent prior run already elapsed that identity's clock —
  the delay is tracked in-memory by identity, not reset by deregistration).
  `/admin/reset` and `/admin/pki/root` are deliberately excluded even under
  `--include-disruptive` — no safe revert exists for either (wipes every
  radio's data; breaks every radio's installed trust anchor).
- `sms` — all 14 routes in sms-controller.ts (the opt-in, experimental
  SMS-over-SGs path — not the default SMS-over-IMS path, which is covered by
  `ims`'s own `/sms-delivery-mode` case). Config manifest reads, a safe
  identical-content round-trip write, `/send-test` input validation plus a
  well-formed call confirmed to actually reach the live osmo-msc VTY,
  `/sync-subscribers`, and (gated behind `--include-disruptive`) an
  idempotent `/configure` re-apply and a `/stop`→`/start` cycle. **Not
  exercised even under `--include-disruptive` by this session**, though
  written and properly gated: osmo-stp/osmo-hlr/osmo-msc are shared live
  infrastructure with the 2G GSM module's real, physically-attached BTS (the
  same "don't assume exclusive ownership" shape CLAUDE.md documents for
  BIND9) — stopping them can drop a real, live 2G session, which this
  session deliberately treated as needing the user's own explicit go-ahead
  rather than running it proactively. `/install`/`/uninstall` are excluded
  entirely, same reasoning as every other module's `/install`/`/uninstall`.
- `syslog`, `esim`, `logs`, `rf-planning`, `rf-planning-projects`, `twamp`,
  `cdr`, `mms`, `pstn`, `vowifi`, `validation`, `genieacs`,
  `ran-kill-switches`, `radio-signal`, `ip-plan`, `secgw`, `sercomm-nr`,
  `ocs`, `gsm`, `hnbgw`, `traffic-history`, `sepp`, `bind`, `asterisk-2g`,
  `misc-services` (chrony/snmp/speedtest/swu-emulator/dns-migration),
  `users`, `backup`, `apn-profile`, `auto-config` — every remaining module
  in the product, added in one continuous pass. Each follows the same
  read → change → verify (real backend artifact) → revert discipline as
  the modules above; every module's own file header documents exactly what
  it does and doesn't exercise and why. The recurring exclusion pattern
  across all of them: real-radio-hardware commands (GenieACS reboot/RF/
  mme-pool/refresh, Sercomm NR configure/lock/unlock/reboot, 2G GSM's BTS
  CRUD/restart/block, SecGW's radio CRUD) are read-only-tested at most,
  never commanded; bulk/high-blast-radius live-apply paths (IP Plan's and
  Auto-Config's own `/apply`, which are the same underlying mechanism; the
  DNS/FQDN Migration Wizard's `/apply`/`/rollback`; every Backup/Restore
  `/restore*` route plus `/restore-defaults`) are never triggered; and a
  handful of narrower one-offs are called out in their own module's header
  (eSIM generation is a real billable external API call with no way to
  detect from outside whether a given instance has live credentials; Backup
  & Restore's `PUT /settings`/`POST /cleanup` delete real backup files as a
  side effect of what looks like a plain settings save).

### Real bugs found and fixed while building this suite

- **IMS voice-charging toggle**: the test's own first marker (`<Peer
  FQDN=`) false-positived against the *unrelated* HSS peer entry that's
  always present in scscf.xml — a bug in the test, not the product; fixed
  to match the OCS peer specifically (`FQDN="ocs.`).
- **Subscriber delete never cleaned up cross-references** (found via the
  charging-plans lifecycle test, confirmed to also affect subscriber
  groups): deleting a subscriber left (a) an orphaned IMSI in any
  `nms_subscriber_groups`/`nms_charging_plans` membership array, and (b) a
  real, permanent orphaned service+product+bucket in SigScale OCS's own
  Mnesia — which could later block a *new* subscriber reusing the same
  IMSI from ever being cleanly assigned to a plan (its stale, unused
  balance trips the real-balance conflict guard). Fixed in
  `subscriber-management.ts`'s `delete()` (Mongo-side `$pull` for both
  collections) and a new `removeSubscriberFromOcs()` in
  `charging-plans-controller.ts` (real OCS RPC cleanup, best-effort —
  never blocks a delete if OCS is unreachable). Verified end-to-end: a
  subscriber's OCS service record confirmed present before delete, gone
  immediately after, via a direct independent RPC check.
- **SAS leaf cert regeneration failed with a real OpenSSL error on every
  refresh after the first** (found via the `sas` module's PKI lifecycle
  test): `readCertInfo()` parsed `openssl x509 -ext subjectAltName`'s
  DISPLAY-format IP SAN entries (`IP Address:x.x.x.x`) and fed them
  straight back into a fresh `-extfile` on the next `regenerateSasLeaf()`
  call, which requires the different INPUT format (`IP:x.x.x.x`) for the
  same SAN type — a 100%-reproducible failure on every leaf regeneration
  once any cert on the host had a real IP in its SAN, i.e. every
  regeneration after the very first. Fixed in `sas-pki.ts`'s
  `readCertInfo()` to translate `IP Address:` → `IP:` while parsing.
  Verified live: `POST /admin/pki/leaf` now succeeds repeatedly in a row,
  confirmed via independent re-reads of the regenerated cert's own SAN.
- **Restarting kamailio-scscf twice back-to-back crashed it with a real
  core-dump, and briefly left production voice charging silently disabled**
  (found running the full `ims` module twice in a row): the `ims` module's
  own set → verify → set-back toggle tests issued their second
  `systemctl restart kamailio-scscf` with no settle delay after the first.
  `kamailio-scscf` is a `Type=simple` unit — systemd reports it "active" as
  soon as the main process forks, well before its 24+ cdp/worker child
  processes finish initializing — so the second restart tore it down
  mid-spawn and it died (`systemd: kamailio-scscf.service: Failed with
  result 'core-dump'`), taking the in-flight toggle request down with it
  (HTTP 500). Caught by this suite's own design, not luck: the in-test
  assertion failed loudly instead of silently reporting pass, which is
  exactly what surfaced it. The live system was left with `/status`
  self-reporting `voiceChargingEnabled: true` while the real `scscf.xml`
  had no OCS `<Peer>` element at all — confirmed independently via a direct
  `kamcmd cdp.list_peers` query into the running process (not just a file
  read) before and after a manual fix-forward restore. This was a genuine,
  if brief, live production charging gap, not just a test artifact. Fixed
  two ways: (1) manually restored voice charging on the live instance,
  re-verified via `cdp.list_peers` showing the OCS peer back in
  `State: I_Open`; (2) hardened `ims.test.mjs` with a `waitForScscfSettled()`
  helper (poll `/status` for `services.scscf === true`, then a fixed 4s
  settle margin) inserted after every one of the 4 restart-triggering calls
  in the two toggle tests, including both `revertQueue` callbacks — not
  just the inline set/revert calls — since a drain-time revert can race the
  very next module's own revert the same way. Re-ran the full suite twice
  in a row afterward with zero errors.
- **GenieACS Sercomm provisioning preview crashed with a generic 500 on any
  incomplete payload** (found via the `genieacs` module's preview test):
  unlike its Baicells sibling (`/preview/:deviceId`, which explicitly
  validates its full required-field list and returns a clean 400),
  `/preview-sercomm/:deviceId` had no caller-side validation at all —
  `buildSercommTasks()` unconditionally called `input.freqBand.split(...)`/
  `input.txPower.split(...)`, throwing an unhandled `TypeError` the moment
  either was missing. Fixed by adding the same required-fields check the
  Baicells route already has. Verified both paths: a complete payload
  succeeds, an incomplete one now gets a clean 400 instead of a 500.
- **Virtual HNB (OsmoHNodeB) redeploy silently never actually reconnected —
  two real, compounding bugs** (found via the `hnbgw` module's own
  remove→deploy lifecycle test, which this instance's real, previously-
  connected virtual HNB had not been through since its original one-time
  setup): (1) `/virtual-hnb/deploy` hardcoded the HNBGW's address as
  `127.0.0.1` instead of using `state.iuhLocalIp` (the real configured
  value) — this "worked" only by coincidence when `iuhLocalIp` was still
  its default wildcard `0.0.0.0` (which does accept connections addressed
  to `127.0.0.1`), and silently broke the moment an operator configured a
  specific non-wildcard loopback (confirmed live on this instance,
  `127.0.10.1`, following this project's own per-daemon-loopback
  convention). (2) Even with the IP fixed, `systemctl enable --now` on an
  *already-running* service is a no-op — it never reloads the config, so a
  redeploy after a real config change kept running against the stale one.
  Both fixed in `hnbgw-controller.ts` (derive the real target IP, always
  `restart` not just `enable --now`). The first test run exposed this
  live — the real virtual HNB actually dropped its connection (confirmed
  via the HNBGW's own `show hnb all` going from "1 HNB connected" to "No
  HNB connected") before both fixes were found and verified to bring it
  back. The test's own check was strengthened to match: service-active
  alone is not sufficient evidence of success, so it now also asserts on
  `hnbListRaw` showing a real, live-registered connection.
- **APN Profile delete never cleaned up the smf.yaml/upf.yaml sessions it
  created** (found via the `apn-profile` module's lifecycle test, which
  independently verifies the real `GET /api/config/smf`/`/upf` session
  arrays, not just the Mongo-backed profile list): `create()`/`update()`
  both patch a session into each file, but `delete()` only ever removed the
  Mongo record — any deleted profile's session stayed permanently orphaned
  in both core-17 NF config files, silently reappearing in the config
  editor and ready to get swept into a future Apply Config cycle with no
  record of why it was there. Fixed by adding a symmetric
  `removeYamlConfigs()` to `delete()` in `apn-profile-usecase.ts`. Verified
  end-to-end: a test profile's sessions confirmed present in both real
  YAML files right after creation, confirmed gone from both immediately
  after delete.

## Critic pass

`critic/critic.mjs` takes a report JSON file and re-examines it
adversarially: for every `pass`, does the recorded evidence actually
support "this worked," or was the verification weak/indirect? For every
`fail`/`error`, is this plausibly a real product bug, or a bug in the test
case itself (wrong payload shape, wrong field name)? See that file's own
header for how to run it and what it outputs — it doesn't re-run anything
against the live instance, it only reviews the report that's already there.
