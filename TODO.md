# TODO — open engineering items

**Canonical list of what is currently open.** If this file and any other
document disagree about whether something is still open, this file wins —
update the other one. (`PROJECT_STATE.md`'s own `## Todo` section was found
on 2026-10-07 to have been stale for weeks, with both of its items already
done; one was even labelled "the single highest-priority follow-up". This
file exists so that doesn't recur.)

This is an engineering worklist, not product documentation — "we should"
phrasing belongs here, unlike `README.md`/`docs/*.md`.

**Last updated:** 2026-10-07

Detail lives elsewhere, deliberately: `PROJECT_STATE.md` (Known Issues §N,
Handoff Summary) holds the full investigation history, `CLAUDE.md` holds the
architectural patterns and don't-reintroduce-this gotchas, and the
`memory/*.md` files hold per-topic arcs. This file holds only the "what's
left and what's the next action" view.

---

## Open

| # | Item | Severity | Status | Next step |
|---|---|---|---|---|
| 1 | **5G calling — RESOLVED 2026-10-08, confirmed on a real device call** | ~~High~~ | Root cause: a 5G leg's Rx AAR can never succeed (PCRF `No Gx Session found` / Experimental-Result-Code **5065** — 5G policy lives on N7/PCF, never Gx). `MT_aar_reply` correctly fell back to the N5 route, but that route threw `qm_free(): BUG: bad pointer (out of memory block!)` freeing SIP parser structures and aborted **before issuing the N5 request**, so PCF got nothing and the call died with 500, never ringing. All 40 such CRITICALs in the boot were in that one route. Cause: `msg_apply_changes()` running on the **async Diameter callback** path, where the message is a restored one whose buffer isn't the normal pkg receive buffer. That async path is the only path a 5G leg can take, so 5G calling was impossible while 4G-4G was fine. **A regression from `75dca52`**, which moved that reparse there to fix the Rx Framed-IP bug — matching the timeline exactly (4G→5G worked 10-03, before the move) | **Fixed and verified**: `$avp(n5_async_entry)` guard skips the reparse on the async path. Real 4G→5G call 17:45:58→17:46:15 (**13.3s**, 183/PRACK/180/200/ACK/BYE clean, `ratType: NR` so genuine standalone NR). Guard fired **2×**, `qm_free` BUG **0** (was 40), N5 `POST /app-sessions` 132→134 with PCF answering **`201 Created`** — which had never once happened on this path. 4G-4G re-verified unaffected. **The ~5s drop was never reproduced** — plausibly the same bug presenting differently, but unproven |
| 2 | **Capture a 4G↔5G call with a known wall-clock timestamp** | **High** | NEW — hard blocker on #1. On-disk logs cannot isolate which of many calls was the failing one after the fact | Place a call, note the time. Both directions worth capturing (5G→4G has its own history of a device-side "no mobile network" error with zero network-side signalling). Then correlate across AMF/SMF/PCF/P-CSCF: the `200 OK`, 5QI=1 QoS flow setup and whether the gNB accepted it, the N5 AppSession `POST`, any `PDUSessionResourceModify` result, the NGAP release cause, and the `BYE` — ideally with a packet capture to establish whether RTP stops before or after signalling teardown |
| 3 | **~5s call drop + duplicate PCC install — RESOLVED 2026-10-10, verified on real calls** | ~~High~~ | Root cause: this is a loopback deployment (both UEs on one P-CSCF) with `ims_dialog detect_spirals=0`, so a spiralled call has two dialog entries with identical Call-ID/tags and **one reply traverses P-CSCF twice**, running the N5 authorization route once per traversal. Both runs were on the same `183` (19ms apart; the 200 OK was 2.5s later). The second found the AppSession id the first had stored and **PATCHed over it**, replacing correct filters (`to 10.46.0.75 7010`) with relay-to-relay ones containing no UE address (`to 10.0.1.178 23926`). The GBR flow could then never match real downlink RTP, so the handset tore the call down with `BYE RELEASE_CAUSE;cause=3;text="Media bearer loss"` at a repeatable **6.1s** after answer — the long-standing "drops at ~5 seconds" symptom. Audio worked meanwhile because it rode the default flow | **Fixed**: `n5_auth_dedup` htable + a `(Call-ID, CSeq)`-keyed guard in both N5 routes — CSeq-keyed so genuine mid-call re-INVITE/UPDATE still PATCHes; htable not `$dlg_var` because `detect_spirals=0` makes dialog lookup non-deterministic and `$dlg_var` silently degrades to per-process storage; `$sht()` compared directly to avoid the null→0 coercion. **Verified on 5 real calls**: guard fired 5× (once each), `PATCH /app-sessions/<id>` stayed **0**, zero "Media bearer loss" BYEs (was 2 of 3), all calls ran past 20s, every PCC rule kept the UE address. **Part 1 of the original plan (stashing rtpengine ports) proved unnecessary** — the first invocation's filters were already correct including the relay port, so the refactor was dropped rather than done for no benefit |
| 4 | **P-CSCF keepalives to UE contacts fail after an airplane-mode toggle** | Medium | Confirmed live 2026-10-07: `ERROR: request sent to sip:10.46.0.73:56189: Fail Counter is 1/2` for 0004's own contact, while it was otherwise "READY". This is why 0007→0004 also failed and is the mechanism behind the user's "every time I airplane mode it takes so long before it makes a call" — the contact must survive enough OPTIONS pings to be usable again | Root-cause why the pings fail against a freshly re-registered contact. Also **extend the pre-flight check**: verifying S-CSCF's contact against live IPsec SAs was *not* sufficient — it passed while calls still failed. It must also confirm keepalives are actually succeeding |
| 5 | **N5 AppSession DELETE — RESOLVED 2026-10-09, verified on real calls** | ~~High~~ | Two stacked defects: 3GPP defines **no** http DELETE on `/app-sessions/{id}` (deletion is `POST .../{id}/delete`, which Open5GS PCF implements), and Kamailio's `$var()` cannot hold null — assigning `$null` stores integer `0`, so every `!= $null` test was permanently true and produced a literal id of `0`. Live evidence: 497 bogus `DELETE /app-sessions/0` and 98 bogus `PATCH /app-sessions/0`, zero correct-form requests ever. The teardown handler is the only path to N7 PCC-rule removal, so every call leaked its dedicated 5QI flow until the PDU session ended. The 2026-10-04 `{s.len} > 0` mitigation was a confirmed no-op ("0" has length 1) and was built on a misdiagnosed "cross-worker htable race" | **Fixed**: null sentinel removed entirely (integer `n5_have_id` flag + `!= "0"` guard — `"0"` is provably never valid since `ogs_pool_index()` is 1-based); `POST .../<id>/delete`; 204/404/**405-as-explicit-error** branches so a method regression can't be swallowed. Deliberately **not** `$vn()` — different variable in a separate list, and script vars are never reset between messages, so a partial rename would have built the URL from a previous call's live id. **Verified**: 8 correct-form teardowns across 5 calls, all **204**, bogus counters frozen, `QosFlow Overflow` flat at 16 |
| 6 | **Intermittent no-audio on an otherwise-good call** | Medium | Seen 2026-10-10: 1 of 5 real 4G→5G calls had no audio in either direction; the call itself was fine (no drop, ran past 20s) and the next calls worked. **Established it is NOT the N5/bearer path**: the failing call's PCC rule was structurally identical and correct (`from 10.0.1.178 23976 to 10.46.0.75 7010`) — same shape as the working calls, just a different relay port. So this is media-plane, most likely the orphaned-rtpengine-relay class the `sht_lock` offer/answer dedup in `rtp.cfg` (commit `75dca52`) was added for — that race produced exactly this signature (a relay with 500+ packets in and zero out). Either a residual variant or a second path | Needs a capture of a failing instance: compare the relay port advertised in the SDP sent to each UE against the port rtpengine actually allocated, and check for a second `rtpengine_manage()` on the same dialog. Note the capture rig wraps in ~11h, so it has to be pulled promptly |
| 7 | **SGW-U PFCP session leak** — upstream Open5GS bug. `sgwc_sess_remove()` frees SGW-C state without sending a PFCP Session Deletion Request, so SGW-U sessions orphan. Known Issues §10 attributes this to N4/SMF↔UPF; it is actually Sxa/SGW-C↔SGW-U | Medium (was High) | Leak and misattribution both confirmed, with corrected numbers: over the one continuous pre-reboot process life (09/29 17:50 → 10/06 16:50) **1256 adds / 1102 Sxa deletions / +163 orphans**, and both conservation identities close exactly. **88% (144/163) is the EBI-collision site; the remaining 19 come from a SECOND, actively-firing leak path** — `sgwc_ue_add_by_message()` (`src/sgwc/context.c:199-201`), where a TEID==0 Create Session Request for an existing IMSI wipes the whole `sgwc_ue` and every session under it with zero PFCP. **Severity downgraded**: SGW-U does **not** crash at pool exhaustion (graceful PFCP reject; upstream `fd08ce329` is in this tree) — but "no new 4G PDN session until restart" is correct. ~101 days at peak rate; **currently zero orphans and the trigger has been dormant since 10/03 20:05**. An `open5gs-sgwcd` restart alone purges SGW-U's whole table via `pfcp_restoration()`, so any Apply Config resets the leak. Evidence suggests a ~5-day episode from one misbehaving UE, not a steady-state condition (after ~58 days of the prior uptime SGW-U held only 26 sessions) | **Fix is essentially a one-liner after all — my earlier use-after-free warning was wrong.** The deletion transaction's callback data is a NULL-checked pool *id*, not a pointer; `ogs_pfcp_xact_t` holds no `sess` pointer; the commit is synchronous. Add `sgwc_pfcp_send_session_deletion_request()` before `sgwc_sess_remove()` at `s11-handler.c:253`, guarded on `sess->pfcp_node && sess->sgwu_sxa_seid` (precedent at `:799`). `context.c:199-201` needs a loop over `sess_list`, same guard. Needs a recompile + `open5gs-sgwcd` restart (drops/re-attaches every 4G UE for seconds) — bundle with the next planned restart; no urgency while dormant. No upstream issue exists; the site is unchanged since 2020 |
| 8 | **Hourly UE detach from a colliding Create Session Request** — the real user-visible problem behind #4 | **High** (when active) | **Causality settled by critic, and it is the reverse of how #4 was framed:** the Sxa leak and this detach are independent, parallel consequences of one trigger, not cause and effect. SGW-C orphans the session *before* the SMF even sees the message, so **fixing the leak would leave the detach 100% intact**. Traced end-to-end twice: a colliding CSR for IMSI `001010000000001` makes MME tear down **both** PDNs — including a live `ESM=ACTIVE` IMS bearer — release the UE context, and force a full re-attach ~9.2s later. Root trigger: the UE holds an `internet` PDN stuck at `ESM=INACTIVE` and re-requests it on a ~1h timer, colliding on `[IMSI, EBI]`. **Correction to the earlier "hourly, 24×/day" framing: zero occurrences since 10/03 20:05:28** (3.3 days); 144 total over ~5 days (~29/day, bursty, one IMSI). The UE is still live and placing real VoLTE calls | Root-cause why that PDN never reaches ESM-ACTIVE and gets re-requested hourly. This fixes the detach **and** removes the leak's only observed trigger, at zero code risk — the critic's recommended first move, ahead of #4. **Also the single biggest open question: why did it stop on 10/03 20:05?** Undetermined |
| 9 | **`gsm-sm.c` patch comment is factually false** | Low (doc) | Critic-confirmed. It claims to avoid "unrelated-sibling-session collateral damage"; `mme_s11_create_session_fail()` (`src/mme/mme-s11-handler.c:206-207`) tears down every session and releases the UE context **unconditionally**, and the pre-patch timeout path converges on the *same* function (`mme-gtp-path.c:198-203`). The patch avoids only the multi-second GTP-timeout stall. Two further corrections: the chosen cause 121 **never reaches the MME** (SGW-C rewrites it to 103 at `s5c-handler.c:171-176`, and the MME ignores the cause anyway), and the patch bypasses a real `mme_dns_retry_on_gtp_timeout()` fallback — moot on this single-gateway deployment, worse on a multi-gateway one | Correct the comment. **Do not** attempt "accept-and-replace" on the TEID≠0 path without a use-after-free audit: it would call `smf_sess_remove()` from inside that session's own FSM dispatch, and it would fix the detach but **not** the leak |
| 10 | **Guard the request-route reparse hazard** (spun out of the now-closed MO-asymmetry question) | Medium | Critic-confirmed: a **reply**-route `msg_apply_changes()` cannot poison the MO Framed-IP (immune unconditionally — so `mo.cfg:205`/`:369` are safe and need no fix, question closed). But a **request**-route one placed after `rtpengine_manage()` genuinely *would*: `sip_msg_update_buffer()` overwrites `msg->buf` in place, and `sip_msg_cloner()` then clones the poisoned buffer. Three dormant instances exist: `kamailio_pcscf.cfg:779-786` (`WITH_SBC`), `rtp.cfg:541` via `:124` (`REMOVE_BITALIGNED_AMR`), and the general ordering rule. Both flags are currently undefined and unemittable | Add a hazard comment at `rtp.cfg:232` and at the two dormant sites; consider a CLAUDE.md gotcha entry |
| 11 | **Four factually wrong config comments** | Low (doc) | Critic-confirmed: `t_lookup_request` → `w_t_check` → `t_check_msg()` is a pure lookup that creates nothing; the snapshot happens at `t_relay()`. The fix at `:844-855` is correct anyway, but for a different reason than stated — the comment misstates where the real deadline is | Correct all four: (a) `kamailio_pcscf.cfg:833` on what snapshots the transaction; (b) `mt.cfg:392-401`/`mo.cfg:452-461` blaming a "race across worker processes" for the AppSession-`0` bug — **there is no race**, `$sht()` correctly returns null and the `0` is manufactured locally by `$var` assignment, and the 10-04 `{s.len}` mitigation built on that wrong cause is a confirmed no-op (18 × `Terminating N5 AppSession 0`, 0 × `No call AppSession found`); (c) `mt.cfg:206`/`mo.cfg:298` "after BYE/CANCEL" — CANCEL is intercepted at `kamailio_pcscf.cfg:618` and never reaches that route, so it is BYE-only and the CANCEL teardown is dead code; (d) `kamailio_pcscf.cfg:102-109` claiming `UE_REGISTRATION_EXPIRES` is never defined — it **is** (`pcscf.cfg:32`, substdef 7200). Leave that value alone; a well-meaning "fix" there would stop Kamailio starting |
| 12 | **A second, unexplained TERM-side Framed-IP poisoning mode** | Medium | Critic found ~16 of the 130 corrupt TERM AARs (all of 09/29 and 10/03) **predate any `msg_apply_changes()` in `mo.cfg`/`mt.cfg`**, so our fix cannot explain them. Their signature is a "mixed twin" — two AARs ~20ms apart sharing one rtpengine offer port, one clean and one corrupt — which the reparse mechanism would not produce (both would be poisoned). Defensible attribution for our fix is ~114 of 188, not all 188 | Needs P-CSCF-side correlation or a capture; PCRF's log carries no Call-ID so it can't be settled retrospectively |
| 13 | **Rx dispatch dedup guard covers only one of two call sites** | Medium | `mt.cfg:133` is inside the `mt_aar_dispatched` guard added by `75dca52`; `mt.cfg:313` (`MT_indialog_aar_reply`) is **not**. If item #9's mixed-twin mode is initial+in-dialog rather than duplicate-worker, the guard won't suppress it | Decide after #9 |
| 14 | **Fix-design trap caught by critic — record so it is not reintroduced** | **High** (if #3 is implemented naively) | Two of the four first-draft fixes for #3 were actively dangerous. **(a)** Renaming `$var(n5_app_session_id)` to `$vn(...)` creates a *different variable*, and script vars are **never reset between messages** (`reset_vars()` is defined but called nowhere), so a partial rename would build the delete URL from a stale slot holding **a previous call's AppSession id** — and Open5GS ids are small recycled integers, so that is a plausible *live* id. Once the method fix lands, "hang up call A" would silently strip call B's dedicated bearer: strictly worse than the current bug. **(b)** Gating the in-dialog reply teardown on `is_method("INVITE")` still lets it fire on a 4xx to a **re-INVITE** (491 glare on hold/resume is routine). A failed re-INVITE does not end the dialog; today the DELETE 405s so it is harmless, but after the method fix it would delete a live call's AppSession mid-conversation — a new outage class created by the fix itself | Both corrected in #3's plan. Keep this row until #3 ships |
| 15 | **OCS `ocs_rating:charge2` crash** | Medium | `OcsReservationGuard` mitigation is live and wired; root cause unfixed, no exact-version source obtainable | File the SigScale GitHub issue (crash dump already captured) |
| 16 | **`MNCC_SETUP_COMPL_IND` timer** (osmo-sip-connector) | Medium | Explicit stopgap, widened 5s→15s→30s, never root-caused; fired at 15s on 3 calls in a 19-call session | Fresh capture with Asterisk `verbose = 3` before widening a third time |
| 17 | **PCF in-memory N5 session-state confusion** | Medium | Only ever resolved by restarting `open5gs-pcfd`; a fresh `POST` 404s for a UE with no live `pcf_sess` | Root-cause why the PDU-session lookup fails under rapid repeated calls |
| 18 | **SMS-over-SGs real two-UE delivery** (Known Issues §8/§9) | Medium | P-CSCF `ims_ipsec_pcscf` fails to relay a locally-generated reply back through the IPsec tunnel | Don't enable SGs delivery mode without reading `sms-over-ims-vs-sgs-delivery-mode` first |
| 19 | **VoWiFi §9 Part 2** — phone never sends a second, authenticated REGISTER | Medium | One candidate fix tried and rolled back after a real regression | — |
| 20 | **UPF/SMF idle-paging race** (the part of §10 *not* explained by #4) | Medium | One genuinely unexplained N4 `No Context` on a Session Modification Request remains; `lib/pfcp` logs no SEIDs at any level, so only a packet capture would reveal it | Low priority — single occurrence in 7.35 days |
| 21 | **Known Issues §1** — Android→iPhone and the Asterisk paths | Medium | Direct-IMS iPhone→Android is fixed (root cause was ICE); these are separate still-open issues | — |
| 22 | **1010's own uplink audio** | Medium | Open since 2026-09-26 after two rounds and 33 real test calls | — |
| 23 | **DNS boot gate not verified end-to-end** | Low | Gate, script, and systemd ordering each verified independently; the full boot path was not, since that needs a reboot or deliberately breaking DNS on a live network | Reboot test in a maintenance window |
| 24 | **`installMms()` git clone not resumable** against a stale checkout | Low | Worked around live, never fixed in code | — |
| 25 | **MMS SMPP registration races `osmo-msc`'s VTY** | Low | The one red step out of 20 on a fresh-host restore | — |
| 26 | **DNS boot-race gotcha not in `CLAUDE.md`** | Low (doc) | That's the "don't reintroduce this" file and it fits; the FRR mask fix got documented there, this didn't | Add an entry |
| 27 | **eSIM Profile Status Notification webhook** | — | **Deferred by explicit user decision**, not an oversight | None unless revisited |

---

## Readiness audit 2026-10-10 — open findings

Two independent audits (patch-wiring, host-drift) produced 33 findings. The
**Status 2026-10-11: the audit is CLOSED — R1 through R13 are all fixed and
committed**, as are the four modules neither audit originally reached (A1-A4).
Each row below keeps its original wording so the finding is still readable, with
the fixing commit appended.

R1 turned out not to need the maintenance window it was held for. The fix is an
ownership merge over the operator's real file, so applying it to an unchanged
deployment is provably a no-op — verified byte-for-byte against this host's own
210-line `osmo-bsc.cfg` — and therefore needs no BSC restart and drops no
camped UEs. The radio was never touched.

Everything claimed fixed here was verified against the running host, not just
compiled: the FRR reload path (topology clean, 12 prefixes at 1 successor), the
IMS template-staleness check (proved it flags real drift, then restored the
file byte-exactly), Prometheus (11/11 targets up after a real sync through the
new ownership-merge), and all 4 Kamailio services active. Full unit suite
40 suites / 342 tests.

One item is deliberately **not** applied live and needs operator approval —
see "Needs manual approval" below. Ranked:

| # | Finding | Sev | Fix location |
|---|---|---|---|
| ~~R1~~ ✅ | `osmo-bsc.cfg` wholesale-regenerated, destroying ~3KB of live SS7/AMR/GPRS tuning, then restarts the radio (drops camped 2G UEs). Fires on every GSM Configure, BTS add/edit/delete, and IP-Plan apply touching BSC/MGW | **Critical** | route through existing `upsertVtyDirectives()` — `gsm-controller.ts:1197` — **fixed, this batch** |
| ~~R2~~ ✅ | SMS-over-SGs **Uninstall destroys the 2G and 3G modules** — deletes shared `osmo-stp/hlr/msc` configs, `rm -f hlr.db*` (holds the `auc_3g` MILENAGE rows both depend on), then apt-purges. No `isGsmInstalled()`/`isHnbgwInstalled()` guard | **Critical** | `sms-controller.ts:1201-1216` — **fixed, c9b17e8 / a209c12** |
| ~~R3~~ ✅ | VoWiFi Uninstall whole-file-restores `smf.conf` from an Aug-2 `.bak`, **silently killing OCS Gy charging today** (the bak predates the `ocs.*` peer). Correct prefix-scoped strip already exists unused in the else branch | **Critical, live-armed** | `vowifi-controller.ts:1193`, `ocs-controller.ts:1141` — **fixed, a209c12** |
| ~~R4~~ ✅ | No apt hold/pin anywhere, and IMS Install itself `apt-get install`s `kamailio` unconditionally. A 5.8.9+ publish (or an IMS Install) downgrades over the 6.0.8 source build, reverting all 7 patches — and with `WITH_N5` active, 5.8.x has no `http_client_request_v2pk()`, so **P-CSCF won't start at all**. No live trigger today | **Critical** | `apt-mark hold` after a successful build; skip in `basePkgs` — **fixed, a209c12** |
| ~~R5~~ ✅ | `frr.conf` wholesale-regenerated by 10 call sites, 9 ending in `systemctl restart frr` — the exact trigger with **5 confirmed crash occurrences here**. Loses the 2G GPRS UE subnet + `passive-interface apn-gprs` | High | `frr-controller.ts`; use `vtysh -b` — **fixed, this batch** |
| ~~R6~~ ✅ | `cdp.so` process-slot patch **already lost** on this host (marker file from Aug 2 makes Install skip it forever; the Oct-3 6.0.8 rebuild doesn't carry it). Zero headroom on P-CSCF/I-CSCF today | High | content check, not marker; wire into both pipelines — **fixed, this batch** |
| ~~R7~~ ✅ | DNS Migration Phase A regenerates the shared `epc` zone, dropping the `aaa`/`ocs`/`secgw` records three other modules upsert. UI calls it "zero risk" | High | carry forward unplanned `IN A` lines — `dns-migration-usecase.ts:447` — **fixed, b4aa292** |
| ~~R8~~ ✅ | IMS staleness detection is a version-string compare, structurally blind to content drift — it read "up to date" while templates had diverged 184 lines. `verifyKamailioImsModulesPatch()` has **zero callers** | High | hash the template dir; call the verifier — **fixed, this batch** |
| ~~R9~~ ✅ | `max_connections = 300` is an unmanaged hand edit; IMS Remove purges mariadb and deletes it, re-arming the confirmed 2026-10-02 outage | High | upsert into a non-apt-owned `99-open5gs-nms.cnf` — **fixed, b4aa292** |
| ~~R10~~ ✅ | `sync-sd-usecase.ts:61` reads `smf.s_nssai`, which doesn't exist (slices live at `smf.info[0].s_nssai`) — the "Sync SD" tool silently returns 0 and reports success | Med | read the right path; extend to `amf.plmn_support`/`nssf.nsi` — **fixed, b4aa292** |
| ~~R11~~ ✅ | Charging-plans regression failure: plan assign persisted to Mongo (`assigned:1`, `imsis[]` updated) but the IMSI had no OCS bucket. `/usage` itself verified working on real subscribers. Either a synthetic-IMSI test artifact or the OCS-side link failing silently — the latter is a documented bug class in `assignSubscribersToPlan()` | Med | decide which, then fix test or function — **fixed, this batch** |
| ~~R12~~ ✅ | Doc corrections that would each cause a wrong "fix": CLAUDE.md #13 says `pcscfDiameterXml()` emits no PCRF `<Peer>` (it unconditionally does, labelled `EXPERIMENT 2026-08-01`); #4 names `readForwarders`/`writeForwarders` as exported (they're private); #18 and `features.md` name `upsertOcsHostsEntry()` (doesn't exist — it's `upsertOcsDnsRecord()`); PROJECT_STATE.md:47's "not a tracked patch constant" is stale | Med (doc) | correct all four — **fixed, b4aa292** |
| ~~R13~~ ✅ | ~20 further wholesale-write / hardcoded-default / accretion instances (nginx timeout regex misses 2 streaming installs; `OPEN5GS_SRC_DIR` defaults to a developer home dir; unpinned `master` clones for PyHSS/VectorCore; `restore-defaults.ts` reverts to MCC 999; `sync-prometheus-config.ts` drops operator scrape jobs; `suci-management.ts` bypasses rawYaml on a core-17 file) | Med/Low | see audit detail — **fixed, this batch** |

**~~Not covered by either audit~~ — audited 2026-10-10, 4 findings, all fixed**
(`hnbgw-controller.ts`, `twamp-controller.ts`, `bind-controller.ts`'s own
Configure generator, `module-fixall-usecase.ts`):

| # | Finding | Sev |
|---|---|---|
| A1 | **`named.conf.options` writers insert into the wrong scope.** `writeForwarders`/`writeListenOn`/`ensureRecursionAndAllowQuery` all inserted a missing directive with `raw.replace(/\}\s*;?\s*$/, …)` — the LAST brace in the file. Correct only while `options{}` is the final block. Add a `logging{}` block (BIND's commonest operator addition, and this project ships a Syslog module) and the directive lands inside *that* scope; BIND then refuses to load the file, and a BIND that won't start crash-loops every FQDN-migrated NF (pattern #6). Latent today — the live file is `options{}`-only. Fixed with a comment/string-aware brace-counting insert into the real `options{}` block; 8 tests, incl. one proving the old code scoped the directive to `logging{}` | High (latent) |
| A2 | **HNBGW uninstall orphans `cs7 instance 1` in another module's file.** It nulled only the `point-code` directive, leaving a bare `cs7 instance 1` header in `osmo-sgsn.cfg` — which the 2G module owns and never emits itself. Nothing owned or would ever clean up the leftover, and osmo-sgsn's next restart would come back with an SS7 instance declared and no point-code. **Live-armed**: confirmed HNBGW is installed here and that node exists with `point-code 0.23.4`, created solely by this module. Now removes the whole node via `parseVtyChunks`/`serializeVtyChunks` | Med (live-armed) |
| A3 | **TWAMP built against `go get github.com/ncode/twamp@latest`** while this project *patches* that library's vendored source by exact text match. Two installs weeks apart produce different binaries, and an upstream change eventually breaks install. Does fail loudly rather than shipping an unpatched binary (`patch-bind-ip.py` exits 1 on no-match, under `set -e`), so this is reproducibility, not silent corruption. Pinned to the pseudo-version this host vendored | Med |
| A4 | **Fix All was blind to template content drift.** `getImsStaleness()` returned only the two version-string flags, so a deployment whose live routing scripts had genuinely diverged reported nothing to fix — exactly the failure mode R8 exists to catch. Now carries `staleTemplates`/`missingTemplates` and Fix All treats drift as a reason to re-Configure (the only thing that runs `deployImsTemplate()`), naming the files. **Proven live**: drifted `mt.cfg`, `stale-status` returned IMS with that exact path while both version strings read an identical `2.0.0-beta_0.64`; restored byte-exactly and it went clean | Med |

Clean on inspection, no finding: hnbgw's `osmo-sgsn.cfg` IuPS merge (a proper
ownership-merge) and its exact-path allow-list config editor; bind's
`/files/content` path guard (`path.resolve` collapses `..`) and its append-only
`named.conf.local` zone repair; twamp's own-directory-scoped `rm -rf`, its
exit-code checking, and its target validation; module-fixall's per-module
delegation. module-fixall covers 7 of ~29 modules by design — extending it is a
feature decision, not a defect.

### ~~Open~~ — RESOLVED 2026-10-10

**FRR EIGRP topology corruption is live right now — 6th occurrence, and the
2026-10-07 transit-mask correction did not stop it.** Found incidentally while
functionally validating R5's reload path.

`show ip eigrp topology` reports **7 successors** for `10.0.2.0/24` (the CBRS
radio network), `10.1.59.0/30` and `172.1.1.0/24`, with garbage next-hops
`5.0.0.0`, `0.10.0.0` (twice), `105.22.158.154` alongside the real
`192.168.253.1` repeated three times. `5.0.0.0` is the same garbage value
recorded in the 2026-09-25 occurrence, so this is the known recurring bug.

**It is NOT currently causing an outage**, which is the difference from
2026-09-24: the kernel route is clean — `10.0.2.0/24 nhid 190 via 192.168.253.1
dev ens20`, a single real nexthop, and `ip route get` for all five radios
(10.0.2.100/.101/.102/.47/.48) resolves via the correct gateway. There is no
`via`-less ECMP member, so nothing is being blackholed. The corruption is
confined to eigrpd's own topology table.

**New information**: `journalctl -u frr` shows the frr#943 crash-guard has fired
**zero** times since Oct 6. Every previously documented occurrence came via that
skip path. So this instance arose by a different mechanism, and the crash-guard
is not involved — worth knowing before assuming the existing writeup explains it.

**This predates and was not caused by the reload.** FRR's
`ActiveEnterTimestamp` is still 2026-10-06 16:50:38, the reload logged
"Reloaded frr.service" (not started), and the neighbour's Seq Num was 217 before
and after. The count of single-successor prefixes was 12 before the reload and
12 after — had the reload corrupted clean prefixes, that count would have
dropped. Caveat stated honestly: I did not count multi-successor prefixes before
the reload, so that inference rests on the unchanged single-successor count and
the matching 2026-09-25 garbage value rather than a direct before/after measurement.

**Fixed on explicit user instruction, same day.** Pre-flight: crash-guard string
present in the running `/usr/lib/frr/eigrpd` (7 occurrences), 12 prefixes clean /
16 corrupt, one real neighbour, 54 established SCTP associations.
`systemctl restart frr` — clean start, no crash/abort/assert in the journal, and
the crash-guard binary came back unchanged. After: **all 29 prefixes at 1
successor** (every one of the 16 recovered), one real neighbour (Seq Num
217 → 226, the expected resync), `10.0.2.0/24` back to a single clean kernel
nexthop, the route table byte-identical apart from nexthop-object ids, SCTP back
to 54, and the RAN re-attached (6 remote eNB/gNB peers on S1AP/NGAP).

Still **no root cause for the recurring trigger** — and this occurrence rules
two things out, so don't re-derive them: the 10-07 transit-mask correction did
not prevent it, and the crash-guard fired zero times across the whole window in
which the corruption accumulated (Oct 6 → the restart), so this did not come via
the documented skip path.

**Measurement caveat for next time**: the restart itself then provoked 33
crash-guard firings in two tight bursts — 18 from the dying old eigrpd during
teardown, 15 from the new process during its initial adjacency sync — followed
by zero for 20+ minutes with the topology clean. A raw firing count that spans a
restart window is therefore meaningless; separate the bursts (the eigrpd PID
changes across them) before concluding the skip path is involved. Recorded in
memory `frr-eigrp-corruption-recurrence`.

### Needs manual approval

**Reapply the cdp process-slot patch to the live `cdp.so`.** R6 is fixed in
code — `CDP_MOD_C_PATCH` is now a tracked patch constant that the 6.0.8 pipeline
applies, and IMS Install's marker is content-hashed so a replaced binary is
detected instead of skipped forever. But the *currently deployed* `cdp.so` still
predates it. Verified directly: `/opt/kamailio-6-build/kamailio-src/src/modules/cdp/`
has the `common.c` and `acctstatemachine.c` markers but **not** `cdp_mod.c`'s,
and the deployed `.so` is byte-identical (sha256 `f43b42b4…`) to that tree's
build, so it carries the two Oct-1 cdp patches and not this one.

Applying it live needs a targeted `make modules modules=src/modules/cdp` plus a
rename-swap (never `cp` — see CLAUDE.md) and a restart of all 4 Kamailio
services. **That restart wipes every registered UE's IPsec SA**, which has no
server-side remedy: each device must re-register (airplane-mode toggle or
reboot). Not done unattended for that reason. Impact of leaving it: cdp's timer
process has zero slot headroom, which bites "under load" — the deployment has
run without it since 2026-10-03 with no observed Cx/Rx failure.

Also deliberately not changed, flagged for a decision rather than invented:
**`sgwu.pfcp.server` can only ever be the loopback.** The dead
`localSgwuOnly ? '127.0.0.6' : '127.0.0.6'` ternary is removed and documented,
but the real asymmetry stands — UPF has a `localUpfPfcpIP` input for binding its
PFCP server somewhere a remote SMF can reach, and SGW-U has no equivalent. Adding
one is a new input field plus an IP Plan Tool row, which is a feature, not an
audit fix.

## Pending verification

Surfaced by investigation agents, not yet independently confirmed, so not yet
tracked as work above.

- **The MT leg appears to open two Rx sessions per call** — two AARs with
  different Session-Ids and different identity derivations, reproducible both
  before and after the 10-05 fix. Unexplained.
- **SGW-U `Send Error Indication` burst** — 6705 occurrences confined to 09/30
  and 10/02. **Correction**: the peer is overwhelmingly `10.0.2.162` (6644),
  **not** the stale Nokia `.214` (only 61). Polarity is opposite to #4's leak
  (an orphan keeps its PDRs, so its TEID would be *found*) — this is a radio
  stuck transmitting on a released bearer, a steady 500-690/hour for 11 hours
  on 10/02. Its own issue.
- **What is `10.0.2.162`?** It generates the burst above, is the eNB in every
  traced detach, and appears in **neither** the ARP table nor CLAUDE.md's radio
  inventory. The reference list needs reconciling.
- **SMF `sm-contexts/1` retry loop** — 4147 of the 4697 `Not found
  [/nsmf-pdusession/v1/sm-contexts/N/modify]` warnings are one single stuck
  context, 4548 of them on 10/02. Pure 5G N11, zero Sxa involvement, signalling
  only.
- **`Cannot find Gx Session for IPv4:10.46.0.75` ×290 and `:10.46.0.73` ×57** —
  two larger, concurrent, unexplained failure populations running alongside the
  `10.0.1.178` corruption. The `.75` ones are a 5G UE's REGISTER AARs (expected
  — no Gx session for an NR leg); the 57 on `.73`, a real 4G UE with 229 AARs
  in the same window, are not explained.

---

## Recently closed (2026-10-07)

Kept briefly so they aren't re-raised.

- **FRR EIGRP transit mask corrected** — `network 192.168.253.0/24` → `/30` to
  match `ens20`'s real mask, the standing candidate open since 09-30. Applied
  add-before-remove so the interface was never uncovered; adjacency never
  resynced (`Seq Num` identical before/after), zero kernel route changes.
  Whether it stops the recurrence is not yet provable.
- **DNS boot-race gate** — a power loss had left 9 of 17 NFs permanently down.
  Now fixed in code (`installDnsBootGate()`), wired into fresh-host bootstrap,
  DNS migration Phase C, and the restore reapply path.
- **4G-4G call setup regression** — the `msg_apply_changes()` reparse added by
  `313c6da` was corrupting `Rx_AAR`'s Framed-IP-Address. Fixed. **Correction:
  this was initially reported as "confirmed on real traffic, zero `Cannot find
  Gx Session` since deployment" — that overstated the evidence and is
  withdrawn.** The critic found three such warnings post-fix (a 5G UE's REGISTER
  AARs, expected), a post-fix terminating-leg sample of only **n=5**, that the
  same commit also shipped the Rx dedup guard so the two changes cannot be
  separated by this data, ~44 P-CSCF restarts in the window, and a collapse in
  call volume (88 terminating AARs on 10/04 → 5 on 10/06). The *mechanism* is
  solidly evidenced — the corrupt-twin signature appears only inside the
  `313c6da` window — but "confirmed fixed in production" is not yet earned. See open items #9 and #10.
- **Stale regression guard** — the 10-04 guard asserted the pre-fix
  `msg_apply_changes()` placement, so "fixing" the red test would have
  reintroduced the outage. Now asserts the real per-file invariant.
- **Major Events log-detail extraction** and **IP Plan Tool** — both confirmed
  working by the user; the "built but never live-tested" caveats are removed
  from `CLAUDE.md` and `docs/features.md`.
- **CHANGELOG gap** — had no entries since 09-30; an `Unreleased` section now
  covers the post-0.64 work.
- **`PROJECT_STATE.md`'s `## Todo` section** — both items verified already
  done and marked superseded.
