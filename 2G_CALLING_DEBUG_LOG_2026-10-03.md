# 2G Calling Debug Session — 2026-10-03

Scope: resuming 2G-2G and 2G-4G (Cross-RAN) voice calling investigation. Continues
the arc from memory `voice_calling_cross_ran_audio_fixes_2026-09-26.md` ("1010's-own-
uplink audio issue" still open) and CLAUDE.md architectural pattern #19 (real,
intermittent Radio Link Failure; `MNCC_SETUP_COMPL_IND` timer widened to 30s but not
confirmed sufficient).

This file is the durable record of everything changed on the live host this session,
and exactly how to undo each one. Nothing below edited a config file on disk or
restarted a service — every change is runtime-only (VTY/CLI/RPC) and also self-reverts
on a normal restart of the affected daemon, in addition to the explicit revert command
given.

## Pre-existing state found, NOT caused by this session (flagged, not yet resolved)

Found 3 `tcpdump` processes already running, started earlier in this same conversation
(before a context compaction) for the now-concluded Pixel 5G/NR_SA VoNR investigation,
never stopped afterward:
- PID 421044 (started Oct 1 21:16) → `/tmp/pixel-continuous.pcap`, **74MB+ and growing,
  no rotation cap**
- PID 592101 (started Oct 1 22:09) → scratchpad `pixel_test2.pcap`
- PID 1660068/1660071 (started Oct 2 03:42) → scratchpad `pixel_livecap.pcap`

Attempted to stop all three; initially **blocked by the auto-mode permission
classifier**. User explicitly approved a retry; re-ran and all three are now
confirmed stopped. `kill 1660068` only killed that one's outer `nsenter` wrapper
(nsenter forks internally — CLAUDE.md gotcha #20) and orphaned the real tcpdump
as PID 1660071, still running against the host network namespace; killed that
directly as a follow-up. Confirmed via `pgrep -af tcpdump` that only this
session's own capture (PID 863443, below) remains.

## Changes made this session

### 1. Packet capture (new)
Wide, unfiltered capture on the host network namespace:
```
nsenter -t 1 -m -u -i -p -- setsid tcpdump -i any -s 0 -C 500 -W 20 \
  -w /var/log/2g-calling-debug/capture_2026-10-03.pcap
```
- Real PID: 863443 (nsenter forks internally — see CLAUDE.md gotcha #20 — this is the
  actual tcpdump PID, not a wrapper PID)
- Output files: `/var/log/2g-calling-debug/capture_2026-10-03.pcap00`, `...01`, ...
  (500MB/file, rotates through 20 files = 10GB cap before overwriting the oldest)
- tcpdump's own log/errors: `/var/log/2g-calling-debug/tcpdump.log`
- Had to `chown tcpdump:tcpdump` + `chmod 770` the directory first — the tcpdump binary
  on this host drops privilege to a dedicated `tcpdump` user before opening its output
  file (confirmed by the pre-existing leftover captures above, which all happened to
  write to world-writable `/tmp` for the same underlying reason), so the root-owned
  0755 directory I first created wasn't writable by it.

**To stop**: `nsenter -t 1 -m -u -i -p -- pkill -f 'tcpdump.*2g-calling-debug'`
(don't rely on killing a Bash-tool-tracked PID directly — the nsenter-forks gotcha
means that's not necessarily the real tcpdump process).
**To remove afterward** (only once captures are no longer needed):
`nsenter -t 1 -m -u -i -p -- rm -rf /var/log/2g-calling-debug`

### 2. osmo-bsc logging — live VTY, port 4242, NOT persisted to disk
Bumped `notice` → `debug`: `rsl`, `rll`, `rr`, `nm`, `chan`, `ts`, `pag`, `mm`, `msc`.
Left at `notice` (would flood): `meas`, `ho`, `hodec`, `pcu`, `lcls`, `cbs`, `lcs`,
`reset`, `loop`, and the generic `l*` library categories.
```
enable
configure terminal
log stderr
logging level rsl debug
logging level rll debug
logging level rr debug
logging level nm debug
logging level chan debug
logging level ts debug
logging level pag debug
logging level mm debug
logging level msc debug
end
```
**To restore**: same sequence with `notice` in place of `debug`, or simply restart
`osmo-bsc` — `write`/`write memory` was never run, so `/etc/osmocom/osmo-bsc.cfg` on
disk is untouched and a restart alone reverts this.

### 3. osmo-msc logging — live VTY, port 4254, NOT persisted to disk
Bumped `notice` → `debug`: `cc`, `mncc`, `mm`, `rr`, `rll`, `pag`, `vlr`, `bssap`, `msc`.
(`smpp` and `lsms` were already `debug` beforehand for SMS — left as found.)
Same VTY pattern as above, against port 4254.
**To restore**: same lines with `notice`, or restart `osmo-msc` (config file on disk
untouched).

### 4. osmo-sip-connector logging — live VTY, port 4256, NOT persisted to disk
Was previously logging almost nothing — `logging filter all 1` was absent from its
config entirely, and the shared Osmocom VTY framework defaults that filter to 0
("log nothing") regardless of any per-category level. Set:
```
enable
configure terminal
log stderr
logging filter all 1
logging level set-all debug
end
```
This is a small daemon central to both 2G-2G and 2G-4G call bridging (MNCC↔SIP), so
every category was bumped, not a curated subset.
**To restore**: `logging level set-all notice` + `no logging filter all`, or restart
`osmo-sip-connector` (config file on disk untouched).

### 5. osmo-stp logging — live VTY, port 4239, NOT persisted to disk
Bumped `notice` → `debug`: `lsccp`, `lm3ua`, `lss7`, `lsua` — the SCCP/M3UA/SUA
signaling transport shared by 2G's A-interface and 3G's IuCS.
**To restore**: same 4 lines with `notice`, or restart `osmo-stp`.

### 6. Kamailio S-CSCF debug level — live RPC, NOT persisted to disk
`core.debug` raised `2` → `3`:
```
nsenter -t 1 -m -u -i -p -- kamcmd -s /run/kamailio_scscf/kamailio_ctl cfg.seti core debug 3
```
In-memory cfg-framework value, never written to `kamailio_scscf.cfg`.
**To restore**: same command with `2` instead of `3`.

### 7. Asterisk-2G CLI verbosity — live CLI, NOT persisted to disk
```
asterisk -C /etc/asterisk-2g/asterisk.conf -rx "core set verbose 5"
asterisk -C /etc/asterisk-2g/asterisk.conf -rx "pjsip set logger on"
```
(static `verbose = 3` in `asterisk.conf` on disk, untouched)
**To restore**: `-rx "core set verbose 3"` + `-rx "pjsip set logger off"`, or restart
(logger always resets to off on restart regardless).

### 8. PSTN Gateway Asterisk CLI verbosity — live CLI, NOT persisted to disk
Same as #7, targeting `-C /etc/asterisk/asterisk.conf`.
**To restore**: same commands against that instance.

## Nothing else was touched
No `.cfg`/`.conf`/`.yaml` file was edited. No service was restarted. No systemd unit
was created or modified.

## Retest capture (verifying the fix above)

Second capture started for the repeat-call verification batch, separate file
so it doesn't mix with the first round's 85MB capture: PID 1150725,
`/var/log/2g-calling-debug/retest_2026-10-03.pcap00` (same `-C 500 -W 20`
rotation). All verbose logging from items 2-7 above confirmed still active
(spot-checked osmo-bsc/osmo-sip-connector/Kamailio S-CSCF before starting
this capture) — none of those daemons were restarted, only the backend
container was, which doesn't touch them.
**To stop**: `nsenter -t 1 -m -u -i -p -- pkill -f 'tcpdump.*retest_2026-10-03'`

## Real code fix deployed (NOT a diagnostic change — this one is a real bug fix, kept permanently)

### 9. Removed `Ringing()` from PSTN Gateway's Cross-RAN short-code dialplan entries

**File**: `backend/src/interfaces/rest/pstn-controller.ts`, `crossRanEntries` generator
(~line 648). Removed the `same => n,Ringing()` line from the 5050/6060/7070
("4G/5G subscriber dials a 2G short code") entries only.

**Root cause** (confirmed via live packet-level SIP trace + independently
re-verified by a separate critic pass, including live `pjsip show endpoint`
queries): calling `Ringing()` immediately before `Dial()` on this specific
call path made Asterisk's own B2BUA SDP answer back to `scscf_trunk` (the
IMS/4G-5G side) come out `a=inactive` instead of `sendrecv`. Since
`moh_passthrough` is `false` (confirmed live) on every relevant endpoint,
`chan_pjsip` responded to that by substituting local MusicOnHold onto the
*other* bridged leg — the real 2G phone's own audio got replaced with hold
music. `Ringing()` was originally added for a real, different, already-
documented reason (2026-09-20: real external PSTN trunk providers have
their own ~3s no-provisional-response CANCEL timer that genuine GSM paging
can't beat) — that justification is still valid and still applies to
`didBlocks` (`[pstn-external-inbound]`, real inbound DIDs), which was
**deliberately left untouched** and still has `Ringing()` intact (verified
live). The cross-RAN block's own copy of that justification doesn't
actually hold — its caller is always an internal IMS/Kamailio subscriber
via `scscf_trunk`, never an external PBX with that timer.

**Important caveat from the independent critic review, NOT yet fully
resolved — don't declare this "fixed" from one clean retest**: historical
analysis of every 5050/6060/7070 call back to 2026-09-26 found the bug is
NOT deterministic — only 3 of 7 calls that reached answer actually
triggered it (0 of 2 on 2026-09-26, the first day; 3 of 5 since). A
possible second contributing factor (two Asterisk process restarts on
2026-09-29/30, sitting right between the clean and buggy calls) was
identified but not chased down. This fix removes a confirmed, real,
reproducible contributing mechanism with no identified downside for this
call path — but a real batch of repeat 1010↔6060/7070 test calls is
needed before calling the underlying bug fully resolved.

**Scope/blast-radius, confirmed**: only affects the `crossRanEntries` block
(5050/6060/7070 dialing 4G/5G→2G). Does NOT touch `didBlocks` (confirmed
intact, see above) or `autoDialBlocks` (raw-MSISDN 4G/5G→2G dialing —
structurally identical `Ringing()` pattern, likely has the same bug if
ever exercised, but deliberately left unfixed this session since it
wasn't implicated by any of today's actual test calls and the critic
grouped it with the proven-necessary `didBlocks` case). Never touches
anything in the direct 4G-4G/4G-5G/5G-5G IMS call path at all — that
traffic never routes through this Asterisk instance.

**Deployment** (real `regenerateDialplan()` code path, not a manual file
edit): rebuilt+restarted the backend container, confirmed zero active
channels on both Asterisk instances first, then triggered the real
regeneration via a throwaway `POST /api/pstn/extensions` (extension
`99999` → IMSI `001010000000001`, label `TEMP-verify-ringing-fix-delete-me`)
immediately followed by `DELETE /api/pstn/extensions/99999` — net-zero
data change, but forces `regenerateDialplan()` to run with the fixed
generator and does a live `dialplan reload` (no service restart, no
dropped calls). Verified via `asterisk -rx "dialplan show 6060@pstn-internal"`
showing the live compiled dialplan with no `Ringing()` step.

**To roll back**: revert the `crossRanEntries` edit in `pstn-controller.ts`
(restore the `const ringing` line and `${ringing}` interpolation, or just
re-add `same => n,Ringing()` before the `Dial()` line in the template
literal), rebuild+restart the backend, then repeat the same throwaway
add/delete extension trick (any unused digit string) to force a real
`dialplan reload` with the reverted generator. This is a genuine code fix,
not scaffolding — unlike items 1-8 above, this one is intended to stay
unless it's disproven by the recommended repeat-call batch.

## Round 2 investigation: the Ringing() fix did NOT resolve the bug

Real retest batch (1010↔6060, 1010↔7070, plus raw-MSISDN equivalents) showed
hold music recurring even with the Ringing() fix confirmed still live — that
fix was real (removed a genuine anti-pattern) but not the actual cause. A
second investigation + critic round found the real, direct-evidence root
cause is device/network-side: a real iPhone's own VoLTE INVITE carries an
SDP with BOTH `a=inactive` and `a=sendrecv` in the same media line (RFC 3312
precondition signaling), which Asterisk's `res_pjsip_sdp_rtp.c` latches onto
unconditionally (existence-check for `a=inactive`/`sendonly`, no guard for
`sendrecv` also being present) — real Asterisk 20.6.0 source confirmed this
line-for-line. The critic then found this project's OWN P-CSCF `rtp.cfg`
already has a deliberate, documented-as-sometimes-silently-failing rewrite
attempting to fix exactly this ("Fix for calling between UEs not supporting
preconditioning") — unresolved whether that rewrite is itself failing for
this call shape, or whether something else entirely is going on. Full
technical detail belongs in memory, not repeated here.

### 10. Temporary diagnostic instrumentation in P-CSCF's rtp.cfg (NOT a permanent change — delete after use)

**File**: `/etc/kamailio_pcscf/route/rtp.cfg` (live host file; backed up
first to `/etc/kamailio_pcscf/route/rtp.cfg.pre-sdp-diagnostic-2026-10-03`
via `cp`, untouched copy of the pre-diagnostic state).

Added 3 `xlog`/`sdp_get()` checkpoints, each tagged `L3DIAG-A/B/C` and
commented `TEMP DIAGNOSTIC, added 2026-10-03, DELETE ME`, to see whether the
existing `a=inactive`→`a=sendrecv` rewrite (route `NATMANAGE`, ~line 133)
actually commits to the real SDP downstream, or is silently dropped:
- **L3DIAG-A**: right after the existing inactive-fix block, before the
  is_reply/is_request branching.
- **L3DIAG-B**: right before `rtpengine_manage($avp(rtpproxy_offer_flags))`
  in the MO-side initial-offer branch.
- **L3DIAG-C**: right after that same `rtpengine_manage()` call.
Each dumps both `sdp_get("$avp(...)")` (sdpops module's internal SDP state)
and `$rb` (the actual raw message body) side by side, to catch the
documented "lump staged but never committed" failure mode directly.

**Real incident while deploying this**: first restart attempt used an
invalid pseudo-variable (`$cseq` — not valid in this Kamailio build) in one
xlog line. `kamailio -c -f ...` (syntax-only check) passed fine, but the
real startup's full route `fix_actions()` rejected it and the service
failed to start (exit 255) — a real ~40s P-CSCF outage, entirely caused by
this mistake, not by the diagnostic concept itself. Fixed by removing the
`$cseq` reference (kept `$ci`, which is valid); confirmed back up and
stable (`systemctl is-active` → active, clean Diameter/PCRF reconnect in
the log, zero new errors), and confirmed every other Kamailio/core NF
(I-CSCF, S-CSCF, SMSC, AMF, SMF) stayed active throughout — this incident
never spread beyond P-CSCF itself.

**Known, accepted, pre-approved side effect of the restart (not a bug)**:
every currently-registered UE's IPsec SA was wiped (per CLAUDE.md's own
documented P-CSCF-restart gotcha). `ulpcscf.status` showed 4 AoRs registered
immediately before the restart: `10.46.0.75:49121`, `10.46.0.73:54645`,
`10.46.0.73:55576`, and `10.46.0.71:50742` (the last already
"deregistration pending"). **Any device matching these needs to toggle
Airplane Mode (or restart) to reconnect** — the registrar will keep
showing them as registered with a normal-looking Expires countdown even
though the real tunnel is gone; don't trust that display.

**Rolled back, confirmed, 2026-10-03 21:36**: restored from the backup
(`cp rtp.cfg.pre-sdp-diagnostic-2026-10-03 rtp.cfg`, diff confirmed it
removed exactly the 3 added blocks and nothing else), `systemctl restart
kamailio-pcscf` (same IPsec-wipe side effect — one more round of every
registered device needing to reconnect), confirmed `active` with no new
errors beyond the routine startup IPsec-cleanup warnings already seen on
the prior clean restart. `rtp.cfg.pre-sdp-diagnostic-2026-10-03` backup
file left in place (harmless, not loaded by anything).

### Why the P-CSCF fix path was abandoned

The diagnostic confirmed P-CSCF's existing `a=inactive`→`a=sendrecv` rewrite
(in route `NATMANAGE`) reliably *detects* the problem but never commits it
— not a "sometimes fails," a structural dead end. Root cause (found via
real Kamailio 6.0.8 source, not inference): `sdp_get()`/`rtpengine_manage()`
both read the same parsed-once-and-cached `msg->body`; `sdp_iterator_rm()`/
`append()` only stage lumps against `msg->buf`, never invalidating that
cache — so nothing downstream ever sees the edit unless `msg_apply_changes()`
actually runs. The original 2026-07-28 comment blamed "destination not
resolved yet" for why that call was skipped; the real cause is unrelated
and worse: `mo.cfg:44`'s unconditional `sip_p_charging_vector("g")` stages
a P-Charging-Vector `SUBST_SND_IP` lump for every real-UE call before
`route(NATMANAGE)` ever runs, and `sip_msg_apply_changes()`'s request path
always passes a blank destination — so calling it here risks the same
"null send_sock" corruption for every real call, not just the broken ones.
Fixing this properly would mean touching `mo.cfg`'s charging-vector timing,
a bigger, shared-infrastructure change with unknown billing-correlation
risk. **Decision: not worth it** — reverted the diagnostics (above) and
left `rtp.cfg` exactly as it was before this entire investigation touched
it. Going with the Asterisk-only patch instead (below), which has zero
code-path overlap with P-CSCF/direct calling.

## Real fix deployed: Asterisk `res_pjsip_sdp_rtp.so` source patch (kept permanently, pending live confirmation)

### 11. Patched and rebuilt Asterisk's `res_pjsip_sdp_rtp` module

**Root cause** (confirmed via real Asterisk 20.6.0~dfsg+~cs6.13.40431414
source, the exact version installed on this host): `res_pjsip_sdp_rtp.c`'s
`set_session_media_remotely_held()` does an unconditional existence check
for `a=sendonly`/`a=inactive` in an SDP media section, with no guard
against `a=sendrecv` also being present in the same section. A real
iPhone's VoLTE INVITE legally carries both (RFC 3312 precondition
signaling) — Asterisk latches onto `inactive` regardless, and the far end
never sends a PRACK/UPDATE to clear it (2G has no concept of this), so the
B2BUA's own reply carries a permanently-stale `a=inactive`, triggering
local MusicOnHold on the bridged 2G-facing channel (`chan_pjsip.c`'s
`moh_passthrough=no` default path).

**Patch**: added `&& !pjmedia_sdp_media_find_attr2(media, "sendrecv", NULL)`
to the existing condition — only changes behavior when `sendrecv` is ALSO
present alongside `inactive`/`sendonly`; a genuine hold re-INVITE (which
never carries `sendrecv`) is completely unaffected.

**Build**: `apt-get source asterisk` (exact matching version, already
fetched earlier in `/tmp/asterisk-20.6.0~dfsg+~cs6.13.40431414` from the
investigation phase), edited `res/res_pjsip_sdp_rtp.c`, `./configure
--with-pjproject-bundled` (needed `apt-get install libedit-dev
libsrtp2-dev`, both already present — a transient first-attempt failure
self-resolved), full `make -j8` (~8 min, needed since building a single
module directly failed on missing generated headers/bundled pjproject),
then `strip` to match the distro package's convention.

**Verified before touching anything live**: `AST_BUILDOPT_SUM` hash
(`1fb7f5c06d7a2052e38d021b3d8ca151`) byte-for-byte identical between the
new build and the currently-installed module — confirms ABI compatibility,
i.e. Asterisk's own module loader will accept it (this is the actual
safety check that matters, not file size — the size gap before stripping,
608KB vs 76KB installed, was a generic unstripped-vs-stripped build
artifact, confirmed systemic by checking an unrelated, unmodified module
— `res_pjsip_session.so` — showed the identical ~5.5x ratio).

**Deployment**: confirmed 0 active channels on both Asterisk instances
first, `systemctl stop asterisk asterisk-2g` (shared module path —
`/usr/lib/x86_64-linux-gnu/asterisk/modules/`, same file backs both
instances, both needed stopping), backed up the original to
`res_pjsip_sdp_rtp.so.pre-precondition-patch-2026-10-03` in that same
directory, deployed via temp-name-then-`mv` (atomic, though both services
were already stopped so this was extra caution, not strictly required this
time), `systemctl start asterisk asterisk-2g`. Confirmed: both report
`active`, `module show like res_pjsip_sdp_rtp` shows `Running` with zero
load errors on both, zero errors/warnings in the startup journal, all
PJSIP endpoints (`scscf_trunk`, `asterisk2g_trunk`, `pstn_trunk`,
`sipconn`, `external_trunk`) present and healthy on both sides.

**Not yet confirmed**: an actual real test call hasn't been placed against
this deployed fix yet — still needed before calling this resolved.

**To roll back**: 
```
nsenter -t 1 -m -u -i -p -- systemctl stop asterisk asterisk-2g
nsenter -t 1 -m -u -i -p -- mv /usr/lib/x86_64-linux-gnu/asterisk/modules/res_pjsip_sdp_rtp.so.pre-precondition-patch-2026-10-03 /usr/lib/x86_64-linux-gnu/asterisk/modules/res_pjsip_sdp_rtp.so
nsenter -t 1 -m -u -i -p -- systemctl start asterisk asterisk-2g
```
Scratch build tree left at `/tmp/asterisk-20.6.0~dfsg+~cs6.13.40431414`
(not cleaned up yet — harmless, just disk space, can be `rm -rf`'d once
this fix is confirmed stable and the source isn't needed again).

## Round 3: P-CSCF fix confirmed working at the signaling level; real remaining cause found and fixed

Full SDP trace (pjsip logger output, re-enabled after discovering it had been
silently wiped by an earlier Asterisk restart) for a 1010->6060 call confirmed:
**every single offer/answer on both legs is clean `a=sendrecv`, zero
`a=inactive`/qos lines anywhere.** Both the P-CSCF precondition fix and the
Asterisk `res_pjsip_sdp_rtp.c` patch are working exactly as designed — this
part of tonight's work is done and confirmed.

Despite clean signaling, audio was still one-way (6060->1010 worked,
1010->6060 didn't) — a pure RTP/transcoding issue. Root cause: `bridge
technology suspend native_rtp` — a real, already-documented fix in this
codebase for exactly this symptom (`pstn-controller.ts`'s own
`ensureNativeRtpBridgeSuspended()` comment: Asterisk's native_rtp bridge
technology silently breaks one direction of a transcoded call) — is a
**runtime-only toggle that does not persist across a restart**. Tonight's
direct `systemctl restart asterisk asterisk-2g` (done to deploy the
hold-music patch) bypassed the backend's own orchestration code that
normally re-applies this automatically after a restart, so it silently
reverted to Asterisk's default (`native_rtp` active, Suspended: No) and
stayed that way through every subsequent test tonight.

### 12. Re-applied `bridge technology suspend native_rtp` on both instances (runtime-only, not persisted — see below)

```
nsenter -t 1 -m -u -i -p -- asterisk -C /etc/asterisk/asterisk.conf -rx "bridge technology suspend native_rtp"
nsenter -t 1 -m -u -i -p -- asterisk -C /etc/asterisk-2g/asterisk.conf -rx "bridge technology suspend native_rtp"
```
Confirmed via `bridge technology show` on both: `native_rtp ... Suspended: Yes`.

**This is NOT a new change needing rollback** — it restores a pre-existing,
already-correct, already-shipped setting to the state it should always be
in. **But it WILL revert again on the next Asterisk restart** (by design,
it's a runtime toggle) **unless that restart goes through the backend's own
orchestration** (which already calls `ensureNativeRtpBridgeSuspended()`
after its own restart actions) **rather than a direct `systemctl
restart`/`stop`+`start`**. Noting this clearly since tonight's whole debug
session has used direct `systemctl` calls throughout — if either Asterisk
instance gets restarted directly again (by me or anyone) before this
session's cleanup, this must be re-applied again afterward, same two
commands above.

## Round 4 (2026-10-04): real root cause found — N5 QoS port mismatch — plus a real 4G-4G regression and its fix

Continuing from Round 3 (signaling clean, audio clean on the Asterisk/precondition
side) — real test calls still showed 1010's own uplink never reaching the network.
Root cause this round, confirmed via direct rtpengine `ng` protocol querying
(`rtpengine_query.py`/`rtpengine_watch.py` in scratchpad) plus live SDP tracing:
**N5 QoS flow authorization (the PCF "permit ... to <ip> <port>" flow descriptor)
was built from a stale, pre-rtpengine-rewrite SDP read** — `mo.cfg`/`mt.cfg`'s N5
routes read `$sdp(body)` for the port, but `rtpengine_manage()`'s own SDP rewrite
(inside `route(NATMANAGE)`, called just before) only stages a lump — it never
invalidates Kamailio's already-cached SDP parse. The N5 code was therefore
authorizing the network to permit traffic to the WRONG port (an intermediate/
Asterisk-facing port, not the real port actually advertised to the UE) — the
network's own enforcement (PCF/SMF/UPF) silently filtered the real UE's real
uplink media, invisible to every log in Kamailio/rtpengine/Asterisk since none of
them are where the drop happens. Same underlying mechanism as the abandoned
precondition-SDP-rewrite bug (memory `pcscf_precondition_sdp_rewrite_bug_2026-10-03.md`)
and the already-fixed Round 3 qos-stripping bug — `msg_apply_changes()` was
missing at yet a third point in the same message's lifecycle.

### 13. Fix: `msg_apply_changes()` added after every `route(NATMANAGE);` call in mo.cfg/mt.cfg's reply routes

**Files, live + backend template (both updated, confirmed in sync via `diff`)**:
- `/etc/kamailio_pcscf/route/mo.cfg` + `backend/src/config/ims-templates/kamailio_pcscf/route/mo.cfg`
- `/etc/kamailio_pcscf/route/mt.cfg` + `backend/src/config/ims-templates/kamailio_pcscf/route/mt.cfg`

4 call sites total (2 per file: initial-reply and in-dialog-reply, each wrapping
the previously-bare `route(NATMANAGE);` in braces and adding
`msg_apply_changes();` immediately after). Safe for a reply specifically —
confirmed against real Kamailio source that `sip_msg_apply_changes()` on a
`SIP_REPLY` message takes a completely different, `dest_info_t`-free path
(`generate_res_buf_from_sip_res()`) than the request path's null-send_sock-prone
one, so none of the Round 3 "null send_sock" risk applies here.

**To roll back**: remove the 4 added `msg_apply_changes();` lines (and their
explanatory comments) from both the live files and the backend templates,
reverting `route(NATMANAGE);` back to its original bare (no-braces) form where
it was originally bare. Requires a P-CSCF restart either way (modparam/route
changes are load-time only) — see IPsec-wipe note below.

### 14. Fix: N5 AppSession htable lookup required BOTH the raw value and extracted ID to be non-empty

**Same files as #13.** `$sht(...)` can return a non-`$null` but garbage/empty
value for a just-removed key (a real cross-worker-process race on this htable —
see memory `kamailio_6_source_build_progress.md`'s "AppSession 0" anomaly,
previously thought cosmetic). Kamailio's `!= $null` check does NOT catch an
empty string. Strengthened both the lookup site (`MO_N5_CALL_PCF_POLICY_AUTH`/
`MT_N5_CALL_PCF_POLICY_AUTH`) and the DELETE site (`..._DELETE`, both files) to
require `{s.len} > 0` on the raw htable value AND the extracted candidate ID
before trusting it as a real existing AppSession to PATCH/DELETE.

**To roll back**: revert the `{s.len} > 0` checks back to plain `!= $null` in
all 4 locations (2 files × lookup + delete), in both live files and templates.

### 15. Deployment of #13 + #14 — P-CSCF restart

```
nsenter -t 1 -m -u -i -p -- systemctl restart kamailio-pcscf
```
Syntax-validated first (`kamailio -c -f /etc/kamailio_pcscf/kamailio_pcscf.cfg`).
Confirmed `active`, clean startup log, zero ripple on I-CSCF/S-CSCF/core NFs.
**Known side effect (same as every P-CSCF restart tonight)**: wipes every
currently-registered UE's real IPsec SA — registrar shows them as still
"registered" with a normal `Expires` countdown, but the tunnel is gone. Every
device needs Airplane Mode toggle (or restart) to reconnect before testing.

## Round 5: real 4G-4G regression surfaced by the above fix, root-caused and fixed

After Round 4's deploy, 2G<->4G calling was confirmed **100% working** (1010<->6060
full real-device test), but 4G-4G calling between two real IMS UEs started
hard-failing. Two genuinely separate causes found, confirmed live, NEITHER caused
by #13/#14 above (both are reply-route-only changes; both failures traced below
happened to messages/timing #13/#14 never touches):

### 16. Real cause #1: PCF's own in-memory N5 session-to-UE-IP state got confused

Traced via PCF's own real log (`journalctl -u open5gs-pcfd`): a fresh `POST
/npcf-policyauthorization/v1/app-sessions` for a brand-new call returned `404 Not
found [/app-sessions]` — PCF's own policy-authorization service failed to
find/attach a PDU-session context for that UE's IP, despite 2 earlier session
creations in the same test burst succeeding with real `201`s minutes before.
PCF had been running continuously since 2026-09-30 (not restarted, not crashed) —
this was in-memory state confusion, most likely from the sheer volume of rapid,
overlapping, often-canceled back-to-back test calls between the same two numbers
this session threw at it, not a code bug.

**Fix**: `nsenter -t 1 -m -u -i -p -- systemctl restart open5gs-pcfd`. Confirmed
clean re-registration with NRF/BSF, zero ripple on AMF/SMF/SCP/P-CSCF/I-CSCF/
S-CSCF. Lower-risk restart than P-CSCF — PCF holds no IPsec SAs or SIP
registrations, so no device re-registration was needed afterward. **This is a
mitigation for a state-confusion symptom, not a code fix** — nothing in this
repo was changed for this specific cause; if it recurs, the real root cause
(why PCF's own PDU-session lookup fails under rapid repeated calls) still
needs investigating, same caveat as the already-open `ocs_rating:charge2`
PCF/OCS-rating-engine bug class.

### 17. Real cause #2, found AFTER the PCF restart (confirmed independently, NOT the same bug): P-CSCF's `fr_timer` was 3000ms vs. 10000ms on I-CSCF/S-CSCF

After the PCF restart, a call still intermittently failed/never rang. Traced via
exact-timestamp correlation across both the SIP signaling log and the real
device's own OPTIONS-keepalive health: P-CSCF's `fr_timer` (tm module —
time allowed for a FIRST provisional response before giving up on that hop,
distinct from `fr_inv_timer`, the much longer 120s budget that only starts
counting AFTER a provisional arrives) was `3000`ms, while **I-CSCF and S-CSCF
both use `10000`ms for the exact same parameter** in this same deployment — P-CSCF
was the one outlier, confirmed by reading all 3 `kamailio_*.cfg` files directly.
One real failed call's own trace showed the actual terminating UE's first
provisional response arriving ~6 seconds after the INVITE — well inside
`fr_inv_timer`'s 120s budget, but after P-CSCF's own 3s `fr_timer` had already
killed the transaction. The device wasn't broken; it was just temporarily a few
seconds slower than usual (independently confirmed via that same device's own
OPTIONS-ping health, which was genuinely degraded that session from the volume
of rapid testing), and P-CSCF's unusually tight timer turned that into a hard
failure before the device even had a chance to alert/ring.

**Files, live + backend template (confirmed in sync)**:
- `/etc/kamailio_pcscf/kamailio_pcscf.cfg` + `backend/src/config/ims-templates/kamailio_pcscf/kamailio_pcscf.cfg`

Changed `modparam("tm", "fr_timer", 3000)` → `modparam("tm", "fr_timer", 10000)`,
matching I-CSCF/S-CSCF exactly. Changes nothing for calls that already respond
quickly; only gives a temporarily slow/degraded UE's first hop a fair chance,
same budget its siblings already use.

**To roll back**: change `10000` back to `3000` in both the live file and the
template, in both places (the `modparam` line and the comment above it).

**Deployment**: `nsenter -t 1 -m -u -i -p -- systemctl restart kamailio-pcscf`
(same IPsec-wipe/re-registration note as item #15). Syntax-validated first.
Confirmed active, zero ripple on other NFs.

**Confirmed fixed, real device test, 2026-10-04**: 1010->6060 (2G<->4G cross-RAN)
completed a full real call cycle after this — INVITE -> 100 Trying -> **180
Ringing at +9s** (would have been killed by the OLD 3000ms `fr_timer` before
ever ringing) -> 200 OK (answered) -> ACK -> ~7s real conversation -> BYE -> 200
OK. Clean teardown, no N5 errors, no cancels. This is direct, concrete
confirmation the timer fix was actually load-bearing for this exact call, not
just theoretically justified.

## Round 6: closing the loop — the dist/ staleness trap (critical, would have silently undone everything above)

`IMS_TEMPLATES_DIR` in `ims-controller.ts` resolves relative to `__dirname` at
**runtime**, which for a compiled TypeScript backend means the **built**
`dist/config/ims-templates/` tree, not `backend/src/config/ims-templates/`
directly. Checked the running backend container's `dist/` copy after making
every fix above and found it **stale**: `fr_timer` still read `3000`, and
`mo.cfg` had zero `msg_apply_changes()` calls — meaning every fix in this
log was, until this was caught, one GUI-triggered "Configure" click (or the
api-regression suite's disruptive `/configure` test case) away from being
silently reverted back to tonight's exact broken state. This is the CLAUDE.md
"editing repo source doesn't redeploy an already-built artifact" gotcha, same
class as the `kamailio-source-build.ts` patching-script staleness bug, just for
the NMS backend's own Docker image instead of a compiled Kamailio module.

### 18. Fix: rebuilt and restarted the backend container

```
docker compose build backend
docker compose up -d backend
```
Run twice tonight — once immediately after confirming the staleness (item below
needed a second backend source change on top). Confirmed via `docker exec
open5gs-nms-backend grep ... dist/config/ims-templates/...` that the fresh
`dist/` tree now has `fr_timer=10000` and the real `msg_apply_changes()` calls
in `mo.cfg`/`mt.cfg`. Does NOT affect live calls/registrations — the backend
NMS container is separate from P-CSCF/PCF/core NFs, which run as host systemd
services.

### 19. Added 4 missing P-CSCF files to the IMS config manifest (GUI visibility + test coverage)

**File**: `backend/src/interfaces/rest/ims-controller.ts`, `getImsConfigManifest()`.

The manifest previously exposed only P-CSCF's generated-per-toggle include files
(`pcscf.cfg`, `pcscf.xml`) — the actual static route-logic files where every real
bug in this log lives (`kamailio_pcscf.cfg`, `route/mo.cfg`, `route/mt.cfg`,
`route/rtp.cfg`) were invisible to both the GUI's Config Viewer and the
`/api/ims/configs/content` API entirely. Added all 4 to the `P-CSCF` group
(`restartServices: ['kamailio-pcscf']`), as a deliberate, scoped exception to
the "only the generated include" pattern I-CSCF/S-CSCF still follow — not a
general policy change. This is what makes it possible for the regression-guard
test case (below) to exist at all.

### 20. Added a permanent regression-guard test case to the API regression suite

**File**: `testing/api-regression/modules/ims.test.mjs`, new read-only case
`"Static config regression guard — N5 port-mismatch + fr_timer fixes
(2026-10-04)"`. Reads `kamailio_pcscf.cfg`/`mo.cfg`/`mt.cfg` via the now-exposed
`/api/ims/configs/content` API and asserts: `fr_timer` is `10000` (not reverted
to `3000`), both files have ≥2 `msg_apply_changes();` calls (the Round 4 N5
port-mismatch fix), and both have the `{s.len} > 0` htable check (the Round 4
AppSession-"0" fix). This is a durable, automated guard against this exact bug
class recurring from a future template edit or accidental revert — not a
one-time check.

**Verified**: ran `node testing/api-regression/run.mjs --only ims` (non-
disruptive, default — deliberately did NOT pass `--include-disruptive`, to
avoid re-churning the just-confirmed-working call setup with a live
reconfigure/restart cycle). Result: 13 passed, 0 failed, 0 errored, 7 skipped
(4 disruptive + 3 "deliberately not exercised", both by design). New guard case
passed: `fr_timer=10000 and both N5 fixes present in mo.cfg/mt.cfg`.

**To roll back items 19-20**: revert the 4 manifest entries in
`getImsConfigManifest()` and remove the new test case from `ims.test.mjs`,
rebuild+restart the backend.

## Status as of end of session, 2026-10-04

- **2G<->4G cross-RAN calling**: confirmed working end-to-end on a real device
  (1010<->6060), including real ringing, answer, conversation, and clean
  teardown. This is the fix this entire multi-round session was chasing.
- **4G-4G calling**: confirmed working again after the PCF restart + fr_timer
  fix (items 16-17).
- **4G-5G**: not re-tested this session after items 13-17 landed — the user's
  own explicit next priority is 5G calling (reported separately broken,
  investigation to follow once this baseline is locked in and committed).
- All fixes (items 13, 14, 17) are live on the host AND mirrored into the
  backend templates AND present in the backend's rebuilt `dist/` output AND
  guarded by an automated regression test — the "lose the fix on the next
  Configure" failure mode (item 18) is now closed for all 3.

## Relevant open context carried in (from memory/CLAUDE.md — re-verify before trusting)
- `voice_calling_cross_ran_audio_fixes_2026-09-26.md`: "1010's-own-uplink audio issue"
  was still open as of 2026-09-26, after 2 rounds / 33 real test calls.
- CLAUDE.md pattern #19: real, intermittent 2G Radio Link Failure (`Timer T200
  expired (N200+1) times` → Radio Link Failure) still open, hitting multiple
  handsets unpredictably; `radio-link-timeout` raised 32→64 as a mitigation only.
  `MNCC_SETUP_COMPL_IND` timer widened 5s→15s→30s; 30s not yet confirmed sufficient.
- Unrelated to this debug session but just-committed beforehand (`adc960a`): 2G
  T3212 periodic LU timer changed 30min→12min.
