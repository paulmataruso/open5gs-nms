# open5gs-nms — Project Briefing for Claude

This file is for a fresh Claude Code session with zero prior context on this project.
It's a living reference, not a changelog — update it when something here goes stale
rather than leaving it wrong. `CHANGELOG.md` and `git log` are the source of truth for
history; this file is the source of truth for "how things work right now."

## What this is

A full-stack Network Management System for a real, running Open5GS LTE/5G core —
dockerized, but the core network functions (NFs) themselves run as **host systemd
services**, not containers. This is not a toy/demo app: it manages real CBRS radios
(Baicells, Sercomm), real subscribers, and a real multi-vendor RAN.

- **Backend**: Node.js + Express + TypeScript, port 3001. Domain/application/
  infrastructure/interfaces layered architecture (`backend/src/{domain,application,
  infrastructure,interfaces}`).
- **Frontend**: React + TypeScript + Vite + Tailwind, served via a separate container,
  proxied through nginx.
- **MongoDB**: subscriber data, SAS grant data (`open5gs` database only — no
  second metrics database; see Traffic History below).
- **Prometheus + Grafana**: already-deployed monitoring stack
  (`open5gs-prometheus`/`open5gs-grafana`, `network_mode: host`, 30-day
  retention). Scrapes each Open5GS NF's own `:9090/metrics` (config synced by
  `sync-prometheus-config.ts`) plus the NMS backend's own `:3001/metrics` —
  Traffic History (below) is a consumer of this existing TSDB, not a new one.
- **GenieACS**: TR-069 CWMP server for radio provisioning (port 7547 CWMP, 7557 NBI).
- **nginx**: reverses everything, terminates TLS for a couple of radio-facing vhosts,
  `network_mode: host`.
- **Open5GS NFs**: NOT containerized. Real systemd units (`open5gs-nrfd`,
  `open5gs-amfd`, etc.) running directly on the host, managed by the backend via
  `nsenter -t 1 -m -u -i -p -- systemctl ...` (entering PID 1's host namespaces from
  inside the backend container). This is the single most important architectural fact
  about this project — almost everything backend-side that "does something real"
  (installs a package, writes a host config file, restarts a service) goes through this
  `nsenter` pattern (`IHostExecutor` interface, `LocalHostExecutor` implementation).

## Critical architectural patterns (read this before touching backend code)

1. **Host execution via nsenter, not Docker exec.** The backend container itself has
   almost nothing installed — it shells out to the real host via
   `nsenter -t 1 -m -u -i -p -- <cmd>` for anything that needs to run in the host's
   context (`systemctl`, `apt-get`, reading/writing `/etc/open5gs/*.yaml`, etc.). Host
   files are typically accessed at `/proc/1/root/<real path>` from inside the container.
   Every `*-controller.ts` file that manages an optional module (IMS, SMS, VoWiFi, BIND,
   chrony, syslog) follows this same shape: install (streamed apt-get via
   `nsenter`), configure (write host config files), start/stop/restart (`systemctl`).

2. **rawYaml preservation for the 17 core NFs.** Never mutate a parsed config object and
   expect it to round-trip cleanly — always work through `rawYaml` so comments/structure
   in the real YAML files survive edits. `yaml-config-repository.ts` handles this.
   The 17 core NFs (as of 2026-07-17): nrf, scp, amf, smf, upf, ausf, udm, udr, pcf,
   nssf, bsf, mme, hss, pcrf, sgwc, sgwu, **sepp1** (SEPP was added as the 17th — some
   older lists in the codebase may still say 16, that's stale, fix it when you see it).

3. **Optional add-on modules** (IMS, SMS, VoWiFi, eSIM, UE Validation, Subscriber
   Groups, Syslog Forwarding, Sercomm NR, FRR source build) are NOT part of the core-17
   bulk "Apply Config" flow — each has its own install/configure/start/stop lifecycle,
   its own controller, its own frontend page. They can be hidden entirely at build time
   via `.env` flags (`ENABLE_SMS_MODULE`, `ENABLE_IMS_MODULE`, `ENABLE_VALIDATION_MODULE`,
   `ENABLE_VOWIFI_MODULE`, `ENABLE_DNS_MIGRATION_MODULE`) — requires a frontend rebuild.

4. **BIND9 is shared infrastructure — never let one module own it exclusively.** IMS,
   VoWiFi, and the DNS/FQDN Migration Wizard all use the same single BIND9 instance for
   different zones. As of 2026-07-17: `bind-controller.ts` (the DNS/BIND9 page) is the
   sole owner of `named.conf.options` (forwarders, listen-on) — it exposes safe,
   targeted-upsert functions (`readListenOn`/`writeListenOn` are exported; **correction 2026-10-10**: `readForwarders`/`writeForwarders` are module-PRIVATE, not exported as an earlier version of this entry claimed) that other modules import and merge
   into, rather than writing their own copy of the whole file. **If you're adding a new
   module that needs BIND to listen on a specific IP, import `writeListenOn` from
   `bind-controller.ts` and merge your IP in — do not write `named.conf.options`
   yourself.** Same rule for install/uninstall: never `apt-get purge bind9` or
   `systemctl stop/disable bind9` from a module's uninstall flow — `apt purge` wipes
   `/etc/bind` entirely including every other module's zones. Each module's uninstall
   should only remove its own `<module>.*` zone files and zone blocks.

5. **Streaming install endpoints need an nginx timeout override.** Every module's
   `/install` (and some `/uninstall`/`/remove`) endpoint uses chunked transfer encoding
   to stream `apt-get install` output live to the browser (`res.setHeader('Transfer-
   Encoding', 'chunked')`, `X-Accel-Buffering: no`). `nginx/nginx.conf`'s generic
   `/api/` location only has a 120s `proxy_read_timeout` — too short for a real
   multi-package apt install on a fresh/slow host. There's a dedicated regex location
   (`^/api/(ims|sms|vowifi|bind|chrony|syslog|swu-emulator)/(install|uninstall|remove)`)
   with a 1800s timeout, matching what FRR source-build and femto already had. **If you
   add a new streaming install endpoint, add its path to that regex or its own location
   block** — otherwise a slow install silently gets killed mid-stream and the browser
   sees a generic "network error" with no useful message.

6. **Every 5GC NF does synchronous DNS resolution of its own advertise FQDN at
   startup and fatally aborts if it can't resolve.** This is real Open5GS behavior
   (`getaddrinfo()` in `ogs_sbi_context_parse_server_config`), not a bug in this
   project — but it means: after running the DNS/FQDN Migration Wizard's Phase C, if
   the `5gc.mnc<mnc>.mcc<mcc>.3gppnetwork.org` zone isn't actually resolving on the
   host, **every** migrated NF (not just SEPP, despite what earlier project notes say)
   crash-loops simultaneously. See `docs/troubleshooting.md`'s "DNS / BIND9 Issues"
   section for the full diagnostic playbook.

7. **FRR `eigrpd` has a real, not-fully-resolved crash history.** A long-standing
   upstream FRR bug (FRRouting/frr#943) can crash `eigrpd` and take down every
   EIGRP-learned route — a full RAN outage on setups where EIGRP carries RAN-facing
   routes. This project ships a hand-built crash-guard patch
   (`docs/frr-eigrpd-crash-guard-patch.md`, applied via the FRR source-build feature)
   that's stopped every recurrence tested so far, but treat it as a mitigation, not a
   guarantee — this is why the DNS Migration Wizard deliberately never auto-edits
   `frr.conf` for anything (a subscriber's framed route, an NF's FQDN advertisement,
   etc.) — any EIGRP `network` statement addition is left as a manual, deliberate
   operator step, shown as a copy-paste hint in the UI instead of automated.
   **Confirmed live (2026-08-26), not just theoretical**: applying a new EIGRP
   `network` statement via the naive path (write `frr.conf`, `systemctl restart
   frr`) triggered this exact bug twice in a row — the crash happens while
   `eigrpd` reprocesses the *whole* topology during a fresh neighbor resync,
   not because of anything about the new statement itself (reverting the
   change and restarting again crashed identically). **The safe method,
   proven live**: apply via `vtysh -c "configure terminal" -c "router eigrp 1"
   -c "network X.X.X.X/32" -c ... -c "end"` then `vtysh -c "write memory"` to
   persist — this advertises the new network incrementally to the
   *already-established* neighbor and never tears down/resyncs the adjacency,
   so it doesn't hit the trigger. If you ever do touch `frr.conf`
   programmatically for a network statement, use the live `vtysh` method,
   never a full `systemctl restart frr`.
   **Confirmed live (2026-09-24), a genuinely different failure mode from the
   crash above — the crash-guard patch has a real gap, not just "stops every
   recurrence":** the patch correctly prevents the frr#943 assertion crash
   (`eigrp_fsm_event_nq_fcn()`, logged as `Non-Query event for prefix ...
   with no feasible successor — skipping active transition instead of
   asserting (frr#943 crash-guard)`), but doesn't clean up the successor
   entry it skipped past — eigrpd kept running with a corrupted topology
   entry for two real prefixes (`10.0.2.0/24`, the CBRS radio network, and
   `172.16.1.0/24`), silently substituting a garbage next-hop IP that
   **changed on every recompute** (`32.75.128.75` → `128.42.216.139` →
   `0.0.0.0` across three separate checks) instead of a static leftover
   value — not cosmetic, not just log noise. Root trigger: the `router
   eigrp 1` config had `network 192.168.253.0/30` when the real interface
   subnet is a `/24` — a declared-mask-narrower-than-real-mask mismatch that
   happened to still cover this host's, the real neighbor's, and (that day)
   a second/unexpected peer's addresses (all four coincidentally fell inside
   `.0`–`.3`), and something about that mismatch combined with the second
   peer sending unrecognized data (`Unknown TLV type: 0x0103`, repeated) is
   what pushed eigrpd into the crash-guard's skip path in the first place.
   **Real, confirmed impact — not hypothetical**: the corrupted successor
   got installed into the *kernel* as a genuine ECMP multipath
   nexthop group (`ip route show <prefix>` showed `nhid <N>` with two
   members, one `nexthop via <real-neighbor> dev ens20 weight 1`, the other
   just `nexthop dev ens20 weight 1` — no `via` address at all, meaning the
   kernel treated it as on-link). Per-flow ECMP hashing meant *some*
   destinations in the affected prefix resolved correctly and others
   silently blackholed (confirmed live: a real attached radio's IP resolved
   via `ip route get` as on-link with no gateway, and sat `INCOMPLETE` in
   the ARP table since the kernel kept trying to ARP for it directly on a
   segment it was never actually on) — a live, partial RAN outage, not a
   theoretical one. **Detection signature**: `show ip eigrp topology`
   listing 2+ successors for a prefix where one next-hop is an
   undocumented/unrecognized IP (or `0.0.0.0`) that changes value across
   repeated checks, corroborated by `ip route show <prefix>` showing a
   multipath nexthop group with a `via`-less member. **What did NOT fix
   it**: the documented-safe incremental `vtysh` method above (`no network
   .../30` + `network .../24`, no adjacency reset) — applying it while the
   topology was already corrupted didn't clear the bad entry and actively
   spread the corruption to the previously-good one (the real neighbor's
   own successor entry became `0.0.0.0` too right after). **What fixed it,
   confirmed live**: a full `systemctl restart frr` — it came back with a
   completely clean, single-successor topology for both prefixes, and did
   **not** crash (same crash-guard-patched binary, unchanged by the
   restart). This is a real, deliberate exception to "never restart" above,
   not a contradiction of it: that guidance is about avoiding a resync-
   triggered crash on an otherwise-healthy neighbor while making a routine
   config change; this was recovering from a topology *already* corrupted
   beyond what an incremental change could repair, where restarting is the
   only known-working remedy and the crash-guard patch makes it safe to try.
   **Takeaways for next time**: (1) always verify a `network` statement's
   declared mask actually matches the interface's real configured mask —
   don't assume a narrower mask that still happens to cover the known
   peers is harmless; (2) if you see the detection signature above, don't
   waste time on incremental `vtysh` fixes — go straight to `systemctl
   restart frr` and verify the crash-guard patch is still the binary that
   comes back up (`strings /usr/lib/frr/eigrpd | grep -F "frr#943
   crash-guard"`, the same check `backup-restart-usecase.ts`'s
   `checkFrrCrashGuard()` already automates).
   **Recurred again, confirmed live 2026-09-25, wider blast radius than
   either prior occurrence**: this time 15+ prefixes showed the 3-successor
   corruption simultaneously (not just 1-2), with garbage next-hops
   `5.0.0.0`/`33.0.0.0` (yet another pair of values, confirming the exact
   garbage IP is not diagnostic — only the detection *signature* is:
   `show ip eigrp topology` showing 2+ successors where one next-hop is
   undocumented/changing, corroborated by `ip route show <prefix>` showing
   a `via`-less kernel nexthop group member). **Directly, operationally
   relevant to the TWAMP module**: `10.0.2.0/24` — the exact prefix holding
   this deployment's real TWAMP-monitored radio targets — was one of the
   corrupted prefixes, meaning per-flow ECMP hashing was actively
   blackholing some fraction of TWAMP's own probe traffic to those
   radios, a real, concrete example of this bug degrading a *different*
   feature's own data quality, not just a generic "some routes are wrong"
   abstraction. Fixed the same way, `systemctl restart frr` — pre-checked
   the crash-guard patch was still present, confirmed the restart itself
   was a clean signal-triggered stop/start (verified via `journalctl -u
   frr`, not just "it came back up") with a single normal neighbor-adjacency
   resync, not a crash, and confirmed the kernel route for `10.0.2.0/24`
   went back to a single unambiguous nexthop afterward. Root trigger for
   *this* occurrence not separately root-caused (the fix is the same
   either way) — if this keeps recurring, the recurring trigger itself
   (not just the mitigation) may be worth properly root-causing.
   **Recurred a 4th time, confirmed live 2026-09-30**: user reported real,
   live LTE/5G outage; confirmed core NFs/Kamailio all still `active`
   (ruling out an NF crash) before acting, and per the user's own explicit,
   repeated, urgent instruction (they had already diagnosed it as FRR)
   restarted it immediately. Same detection signature and same fix as
   every prior recurrence: `journalctl -u frr` showed the same `Unknown
   TLV type: 0x0103` pattern followed by a single clean
   `Neighbor(192.168.253.1) adjacency became full` (no crash — confirmed
   the crash-guard patch string was still present in the binary that came
   back up), `show ip eigrp neighbors` showed exactly the one real
   neighbor, `show ip eigrp topology` showed every prefix back to "1
   successors" including `10.0.2.0/24`/`172.16.0.0/24`, and `ip route
   show 10.0.2.0/24` confirmed a single clean kernel nexthop. User
   confirmed LTE/5G restored immediately after. **This is now a real,
   recurring pattern (4 confirmed occurrences) with a consistent, reliable
   fix but no confirmed root cause of the recurring TRIGGER itself** — if
   this keeps happening, the underlying cause (not just this mitigation)
   genuinely warrants dedicated investigation rather than continuing to
   treat each occurrence as independent.
   **Recurred a 5th time minutes later, same session, 2026-09-30** — same
   user-reported outage pattern, same explicit "restart it now" + "keep
   watch on it" instruction, same fix, same clean recovery signature.
   Given a second recurrence within the SAME short window, `systemctl
   is-active frr` was then checked proactively (not just reactively) after
   every subsequent host-affecting action for the rest of that session —
   stayed `active` throughout roughly 90 minutes and ~40 checks covering a
   live Kamailio module swap + restart, 3 backend container rebuilds, and
   a live-API testing pass exercising real actions across every module —
   no 6th recurrence during that window, so nothing else that session
   independently triggered it.
   **A real, concrete root-cause LEAD surfaced the same session, still not
   acted on** (found by a read-only live-API testing pass, independently
   re-confirmed directly against the real running config): `show running-
   config`'s `router eigrp 1` block currently declares `network
   192.168.253.0/24`, but the real transit interface (`ens20`) is
   configured `192.168.253.2/30` — a genuine declared-mask-wider-than-
   real-mask mismatch, the same general class of root trigger as the
   2026-09-25 occurrence documented above (which had the mismatch in the
   OPPOSITE direction — declared narrower, `/30`, when the real interface
   was a `/24`). Confirmed independently via `vtysh -c "show running-
   config"` and `ip -4 addr show ens20` directly, not just trusted from
   the agent that first noticed it. **Deliberately NOT acted on** —
   editing an EIGRP `network` statement is exactly the class of change
   this same pattern's own guidance above says requires a manual,
   deliberate operator step (never auto-edited), and this was found
   mid-incident by an agent whose actual task was live-API testing, not
   FRR remediation. If this comes up again: this specific mismatch (declared
   `/24` vs real `/30` on the `192.168.253.0` transit network) is a
   real, standing candidate worth checking/correcting deliberately via the
   documented safe `vtysh` incremental method (not a blind `systemctl
   restart`) — `no network 192.168.253.0/24` + `network 192.168.253.0/30`
   under `router eigrp 1`, then `write memory` — the NEXT time the
   topology is confirmed clean (not mid-corruption; recall the
   2026-09-25 entry's own finding that the safe incremental method
   actively spread corruption when applied to an ALREADY-corrupted
   topology, so only attempt this right after a confirmed-clean state,
   e.g. immediately following one of these `systemctl restart frr`
   recoveries).
   **DONE — applied and verified live 2026-10-07, on explicit user
   instruction. This mask mismatch is no longer open; do not "fix" it
   again.** `router eigrp 1` now declares `network 192.168.253.0/30`,
   matching `ens20`'s real `192.168.253.2/30`, persisted to
   `/etc/frr/frr.conf`. Pre-flight (all four confirmed before touching
   anything): crash-guard patch still present in the running
   `/usr/lib/frr/eigrpd`; topology clean (0 prefixes with anything other
   than "1 successors", 29 prefixes total); exactly one real neighbor
   (`192.168.253.1`); and — worth knowing for next time — `show ip eigrp
   neighbors` reports `Uptime`/`SRTT` as `0` and `RTO` as `2`
   permanently. Those are unimplemented display fields in FRR's eigrpd,
   **not** a flapping adjacency; confirmed by `journalctl -u frr` being
   essentially silent (1 line in 45 minutes, zero adjacency events).
   Don't misread those zeros as churn and abort the change.
   **Deliberate deviation from the order written above**: applied
   `network .../30` FIRST, then `no network .../24`, so `ens20` was
   never momentarily uncovered by any `network` statement. Doing the
   removal first risks pulling the interface out of the EIGRP process
   and forcing a re-add, which is a fresh neighbor resync — precisely
   the documented frr#943 crash trigger. Adding is the proven-safe
   operation per this same pattern, so front-load it. Use this order if
   you ever correct another `network` statement on a transit interface
   that carries the adjacency itself.
   **Verification that it was non-disruptive** (the useful signal is the
   neighbor's `Seq Num`): it read `31` both immediately before and
   immediately after the change, proving the adjacency was never torn
   down or resynced; `systemctl show frr -p ActiveEnterTimestamp` was
   unchanged (no restart); `ip route show` was **byte-identical**
   before and after (zero kernel route changes); topology stayed clean
   at the same 29 prefixes; `10.0.2.0/24` kept its single clean nexthop
   (same `nhid`); and all 14 established radio SCTP connections
   survived. Whether this actually stops the recurrence is of course
   not provable yet — it removes a confirmed, real misconfiguration of
   the same class as the 2026-09-25 trigger, but a 6th recurrence would
   mean the trigger lies elsewhere.

8. **MME hostname vs IP behavior** (4G-side version of gotcha #6): Open5GS MME also
   calls `getaddrinfo()` synchronously during config parse for SGs-AP peer addresses —
   an IP (even unreachable) always works, an unresolvable hostname aborts fatally at
   startup. `MmeEditor.tsx` shows a warning banner when a hostname is detected.

9. **SGs-AP `map` is an object, not an array** in Open5GS's MME config schema — a past
   bug class from building it as an array. If you touch `mme-config.ts` or
   `MmeEditor.tsx`'s SGs-AP section, keep this in mind.

10. **Subscriber sync reconciliation.** Both IMS (`ims-controller.ts`) and SMS
    (`sms-controller.ts`) have a `sync-subscribers` endpoint that pushes Open5GS
    subscribers into an external system (PyHSS's DB / OsmoHLR's sqlite). Both do a
    reconciliation pass after the main sync loop to delete rows for subscribers that
    were removed from Open5GS or had their MSISDN cleared — the sync loop alone only
    ever inserts/updates, so without this pass, deleted subscribers orphan forever in
    the external system. If you add a third "sync subscribers to X" feature, copy this
    reconciliation pattern, don't skip it.

11. **Per-subscriber traffic accounting owns its own nftables table.**
    `subscriber-ip-accounting.ts` is the first real nftables rule-management
    code in this codebase (as opposed to `auto-config.ts`'s pre-existing
    `iptables` NAT rules) — it installs one counter rule pair (up/down) per
    subscriber UE IP in a dedicated `inet open5gs_nms_acct` table/`acct_fwd`
    chain, matching by UE IP only (no interface matching needed — UE pool IPs
    are unique on this host). If you add another nftables-based feature,
    give it its own table rather than sharing this one, and remember: if a
    UE IP gets reassigned to a different subscriber, the old rule pair must
    be deleted and recreated (not just relabeled) so the counter resets to
    zero instead of the new owner inheriting the old owner's byte count.

12. **Traffic History reuses the existing Prometheus, it doesn't store its
    own history.** `prometheus-metrics.ts` exposes raw cumulative counters
    (`open5gs_gtp_{rx,tx}_bytes_total{dnn}`, `open5gs_subscriber_{up,down}
    _bytes_total{imsi}`) via a `/metrics` endpoint that `sync-prometheus-config.ts`
    scrapes alongside every NF — deliberately NOT a separate MongoDB
    time-series store (an earlier version of this feature used one; it was
    replaced once we realized Prometheus was already deployed and already
    doing this job). `traffic-history-controller.ts` is a thin proxy that
    turns the frontend's filter params into a PromQL `query_range` call and
    lets Prometheus's own `rate()` compute Mbps — don't reintroduce
    rate/delta math on our side. Retention is whatever Prometheus's own
    `--storage.tsdb.retention.time` is set to (shared with NF metrics), not
    independently configurable per feature.

13. **Real VoLTE calling needs the P-CSCF↔PCRF Rx interface for dedicated QCI=1
    bearers — this is now built and active, not optional.** Real phones (unlike the
    IMS Test Number bot) won't ring for a UE-to-UE call unless the network actually
    creates a dedicated GBR voice bearer (QCI=1) via Gx, which requires P-CSCF to
    speak Diameter Rx to PCRF (`ims_qos`/`cdp`/`cdp_avp` Kamailio modules, gated by
    `#!define WITH_RX` in `pcscfIncludeCfg()`'s generated `pcscf.cfg` — confirmed
    live 2026-07-26 this was fully built in a prior session but left disabled by one
    commented-out line). **Correction, 2026-10-10**: an earlier version of this entry said
    `pcscfDiameterXml()` deliberately has NO `<Peer>` element for PCRF
    (accept-only). That is **false** — it unconditionally emits
    `<Peer FQDN="${p.pcrfFqdn}" port="${p.pcrfPort}"/>` plus a matching
    `<DefaultRoute>`, and the live `pcscf.xml` has it. Do NOT delete it: the
    code's own adjacent comment explains `<Peer>` is what drives CER/CEA and
    that cdp's config parser silently ignores `<ConnectPeer>`, so removing it
    breaks the Rx interface — and it would also take P-CSCF's cdp `peers`
    count to 0, which is the condition that makes the lost `cdp.so`
    process-slot patch bite (see TODO.md). The element is labelled
    `EXPERIMENT 2026-08-01` in the source with no recorded conclusion; treat
    the live, working config as the authority. (Original text, for history:
    `pcscfDiameterXml()` has no `<Peer>` element for PCRF (accept-only — P-CSCF and PCRF both trying to actively connect to each other
    causes a real, confirmed connect/disconnect flap that starves all INVITE
    processing). `upsertPcrfPcscfPeer()` cleans up stale `ConnectPeer` entries from
    old PLMNs on every Configure run — don't remove that cleanup, stale entries
    genuinely interfere with the real connection (confirmed via PCRF's own
    freeDiameter logs misrouting CEAs to a stale peer's state machine). See memory:
    ims-ue-to-ue-calling-investigation for the full debugging arc, including a
    real-radio hardware limitation (a specific eNB model rejecting QCI=1 outright,
    S1AP cause 37 `not-supported-QCI-value`) that looks identical to a software bug
    at first — don't assume every "call won't ring" report is fixable in this
    codebase; check the eNB's own S1AP response first.

14. **A real B2BUA (Asterisk) splits one call into two dialogs — rtpengine needs
    both halves of each one.** A direct real-UE-to-UE call is one shared SIP
    dialog/Call-ID all the way through P-CSCF, so rtpengine correlates the
    existing "mo request" (caller's offer) + "mt reply" (callee's answer)
    handling in `kamailio_pcscf/route/rtp.cfg` into a single complete relay
    automatically. The PSTN Gateway's Asterisk is a real B2BUA — every call
    through it is actually **two separate dialogs** with different Call-IDs
    (caller↔Asterisk, Asterisk↔callee), and each one independently needs its
    own complete offer+answer pair processed by rtpengine, or it has a relay
    allocated with nowhere to forward either phone's audio. If you're adding
    another B2BUA-style module (another gateway, an IVR, anything that
    re-originates rather than proxies), budget for this same requirement —
    it will not "just work" the way direct UE-to-UE calls do. See memory
    `pstn-rtpengine-b2bua-dual-dialog-fix` for the full arc, including two
    dead ends that looked plausible first (a Kamailio "null send_sock"
    CRITICAL error, and an Asterisk `bridge_native_rtp` bug) that were real
    but NOT the actual remaining cause once fixed — verified via a direct
    bit-level RTP payload decode (real AMR-WB frames extracted from a packet
    capture and decoded with a real decoder) before finally finding this.

15. **SecGW: every radio needs its own dedicated pool address, and Baicells vs
    Nokia use fundamentally different IPsec models — don't assume one vendor's
    approach applies to the other.** `allocatePoolAddress()` hands each radio a
    unique single-address pool/traffic-selector — never a shared CIDR (a real
    outage: shared selectors collide on one kernel XFRM policy slot, and
    whichever radio negotiates last silently steals it from the others, who
    then show ESTABLISHED in swanctl with no real traffic path). Baicells
    negotiates that address dynamically via IKEv2 Configuration Payload (CP).
    **Nokia has no CP support at all** (confirmed live 2026-08-14 by reading the
    radio's own IPsec page directly) — it only offers static tunnel endpoints +
    traffic selectors as one or more standalone "Protect" policies, so Nokia's
    `remote_ts`/`remote_addrs`/IKE identity must be the radio's own real IP
    (`localIpAddress`), never the pool/CP mechanism (see `resolveRemoteTs()`'s
    comment for the full story). A Nokia radio needing to reach anything beyond
    the auto-derived core NF pair (e.g. the BIND DNS server) needs it added via
    `extraLocalCidrs` as a real "Protect" policy on the radio's side, matched by
    widening this gateway's own `local_ts` — Nokia's "Bypass" IPsec action isn't
    reliably usable for this, don't assume it is.

16. **Cross-RAN Calling: when two sibling modules each need to read the
    other's data, only ONE direction of the cross-module import can be
    static — the other must be a lazy `await import()` at the call site, or
    it's a real load-time circular dependency.** `pstn-controller.ts` (PSTN
    Gateway's Asterisk) and `asterisk-2g-controller.ts` (Asterisk-2G) are two
    independent B2BUA instances; Cross-RAN Calling peers them with a new
    inter-Asterisk PJSIP trunk on each side (`[asterisk2g_trunk]` in
    `pjsip_pstn.conf`, `[pstn_trunk]` in Asterisk-2G's `pjsip.conf`) plus
    dialplan blocks on each side that **forward, not resolve** — dialing the
    other side's short code re-enters that side's own dialplan at the exact
    same digit string, where its own already-existing per-mapping `Dial()`
    logic completes the call unchanged (neither side ever needs to know the
    other's subscriber mapping). `pstn-controller.ts` already had a
    pre-existing static `import { isAsterisk2gInstalled } from
    './asterisk-2g-controller'` (a deliberate one-way dependency — see that
    function's own comment) — extending that SAME direction with more named
    exports (`setCrossRanPeer`, `listGsm2gShortCodesForCrossRan`,
    `getAsterisk2gEchoTestNumber`, `getAsterisk2gBindAddress`) was safe. But
    Cross-RAN Calling also needs the reverse (Asterisk-2G's own routine
    single-side short-code regen, `regenerateExtensions2g()`, needs to know
    whether to keep including PSTN's forwarding blocks — with no orchestrator
    in that call path to push the data in as a parameter) — so that direction
    uses `await import('./pstn-controller')` right at the two call sites that
    need it (a private `getCrossRanPeerCodes()` helper, and the `/extensions`
    collision guard), never a static top-level import. This mirrors the
    pre-existing `setMscMnccMode` pattern (`sms-controller.ts`, consumed via
    lazy import from both `asterisk-2g-controller.ts` and `gsm-controller.ts`)
    — **static import for a genuinely one-directional relationship, lazy
    `await import()` the moment a second file needs to import back**, in this
    codebase specifically to avoid circular static imports between sibling
    controllers. The toggle itself (`setCrossRanCalling()` in
    `pstn-controller.ts` — the sole orchestrator, since the one-button UI
    lives on the Voice Gateway page's Extensions tab, backed by `pstnApi`) is
    deliberately **fail-closed with no rollback on partial failure**: both
    dialplans are exact-match-only (PSTN's has no catch-all at all;
    Asterisk-2G's `_X.` catch-all always loses to an exact match in the same
    context regardless of declaration order), so a half-applied state — one
    side wired, the other not — just means a call fails to route on one leg;
    it can never misroute or corrupt an in-progress call, so surfacing the
    specific inconsistency and letting the operator retry is safer than
    silently reverting a flag that would then lie about a still-half-wired
    trunk. A one-time collision sweep runs at enable time across both short-
    code registries (`pstn_extensions`/`gsm2g_extensions` Mongo collections)
    and each side's echo-test number; a matching, cheaper guard is gated on
    `crossRanEnabled` (not unconditional) inside each side's own
    `POST /extensions` handler, so two operators running both modules with no
    intention of ever bridging them can still reuse the same short code
    freely on each side. Real transcoding requirement (first time this
    project transcodes real call audio, not just relays it): the two new
    trunk endpoints (`asterisk2g_trunk` on PSTN's side, `pstn_trunk` on
    Asterisk-2G's side — the two ends of the same physical inter-Asterisk
    trunk) are **hard-restricted to `allow=gsm` only, nothing else**.
    **Real bug, confirmed live 2026-09-26, corrected from this pattern's own
    original text**: both endpoints originally also allowed `amrwb`/`amr`,
    on the theory that listing each endpoint's own native codec FIRST in
    `allow=` would bias negotiation toward exactly one transcode hop without
    hard-blocking the other codec. That bias never worked — both endpoints'
    effective `codec_prefs_outgoing_offer` (one explicit, on `asterisk2g_
    trunk`; one Asterisk's own default, on `pstn_trunk`) resolves the offered
    codec from what's *pending* on the OTHER leg or this endpoint's
    *configured* order, in a way that ends up narrowing to AMR in one
    direction and to AMR-first in the other — completely bypassing the
    intended gsm-biasing order in both cases. Net effect: raw AMR could reach
    Asterisk-2G's own GSM-only `sipconn` leg unconverted, producing one-way
    audio (confirmed via packet capture: identical SSRC/payload type on both
    sides of what should have been a real transcode boundary). A codec
    absent from `allow=` can never appear in an offer or answer for that
    endpoint no matter what `codec_prefs_outgoing_offer` says, so restricting
    both ends of this trunk to `gsm` only forecloses the entire bug class —
    the AMR↔GSM transcode is now always forced onto PSTN Gateway's own
    Asterisk (`asterisk2g_trunk`↔`scscf_trunk`), never left ambiguous. If you
    ever add another codec-family boundary between two B2BUA legs, don't
    rely on `allow=` order as a soft bias — either hard-restrict one side to
    the single codec its real downstream requires, or verify the actual
    negotiated codec on the wire, not just what the config file implies.
    `direct_media=no` is a hard functional requirement here (not just
    inherited B2BUA hardening
    habit — Asterisk must stay in the RTP path on both legs for transcoding
    to happen at all), and both new endpoints carry `rtp_keepalive=5` from
    day one (the no-audio bug fixed live 2026-09-14, see the PSTN/Asterisk-2G
    entries above — this risk is generic to any `rtp_symmetric`-dependent
    B2BUA leg, so it's applied proactively here rather than waiting to
    rediscover it). Confirmed live 2026-09-14: enable/disable cycle produces
    working PJSIP endpoints and dialplan routing on both instances with zero
    impact on the pre-existing `scscf_trunk`/`sipconn` trunks, and the
    collision sweep correctly rejects a deliberately-colliding test code
    before writing anything. **Real over-the-air calls confirmed working
    2026-09-15, both directions, full bidirectional audio (packet-verified)**
    — getting there also surfaced and fixed a real, separate `osmo-bsc.cfg`
    bug unrelated to this feature's own code: `codec-support fr` was
    under-declaring the real nanoBTS's own AMR capability (it genuinely
    supports AMR per its own live OML Feature Vector), which had been
    misdiagnosed the day before as an unfixable hardware RF reliability
    issue. Fixed to `codec-support fr amr` in `gsm-controller.ts`'s
    `btsBlock()`. See memory: `gsm_2g_osmocom_module_progress.md` for the
    full arc — if a 2G TCH-assignment failure ever resurfaces, check
    `show bts 0`'s live `Features:` list against `codec-support`/
    `amr-config` before assuming it's hardware again.
    **Real bug, confirmed live 2026-09-26 — full-MSISDN cross-RAN dialing
    never actually worked**: `extensions2gConf()`'s `subscriberMsisdnBlocks`
    (Asterisk-2G's own exact-match-per-subscriber-MSISDN block, built in
    `regenerateExtensions2g()`) was generated from EVERY subscriber
    returned by `findAllFull()`, not just ones actually reachable via
    `sipconn`/osmo-msc. A 4G/5G-only subscriber's MSISDN got the same
    exact-match block as a real 2G subscriber, shadowing the `_X.`→
    `pstn_trunk` catch-all below it — dialing that MSISDN from the 2G side
    re-tried it through `sipconn` instead, and osmo-msc correctly rejected
    it as an unknown subscriber ("far end did not ring" / "call can't be
    connected", confirmed live against real test calls). Fixed by filtering
    to `s.gsmEnabled` before building this block — a real 2G subscriber's
    own MSISDN still routes via `sipconn` exactly as before, and everyone
    else now correctly falls through to `pstn_trunk`.

17. **SigScale OCS (Diameter Gy charging): `smf.conf` now has THREE
    independently-owned `ConnectPeer` lines — Gx (Open5GS core, untouched by any
    module), S6b (VoWiFi's `aaa.*` identity prefix), and Gy (this module's `ocs.*`
    prefix) — each module's upsert function must regex-strip ONLY its own
    prefix, never the whole file.** `upsertSmfGyPeer()`/`removeSmfGyPeer()`
    (`ocs-controller.ts`) are a direct copy of VoWiFi's own `upsertSmfAaaPeer()`/
    `removeSmfAaaPeer()` idiom (`vowifi-controller.ts:514-556`), scoped to
    `/^[ \t]*ConnectPeer\s*=\s*"ocs\.[^"]*"[^\n]*\n?/gm` — this exclusive `ocs.`
    naming slot is what keeps this module's writes from ever touching VoWiFi's
    `aaa.*` line or vice versa. Each module also keeps its own, separate
    one-time backup file (`HOST_SMF_CONF_BAK = .../.ocs-smf-conf.bak`, distinct
    from VoWiFi's own) — never share a backup filename between two modules that
    both write into the same live file, or the second module's first-write
    backup silently clobbers the first module's original. **Gy is 4G/EPC-only —
    SigScale also ships a 5G product (`sigscale/chf`), explicitly excluded from
    this module's scope**: Open5GS's SMF has zero Nchf client implementation
    upstream (confirmed live against the real `open5gs/open5gs#4421` GitHub
    discussion — a community proposal exists, not merged, no timeline), so
    wiring CHF too would have nothing on the SMF side to ever call it; a 5G NR
    UE's session is never charged/controlled by this integration at all. Four
    real bugs found live getting the Gy peer to actually connect (not just
    "config written, restart succeeded"): (1) OCS's default HTTP port 8080
    collides with PyHSS's own API service (`/opt/pyhss/services/apiService.py`)
    — moved to `8093` after confirming 8090/8091/8092 were also taken by other
    modules; (2) OCS's default `0.0.0.0:3868` Diameter bind can silently lose to
    another NF's dedicated-IP freeDiameter listener while the Erlang `diameter`
    application still reports its supervisor "up" — gave OCS its own dedicated
    loopback `127.0.1.10`, matching every other per-daemon-loopback module in
    this project; (3) **OCS is NOT accept-by-default for Diameter peers** — it
    rejects an unrecognized peer with `3010/DIAMETER_UNKNOWN_PEER` until
    explicitly registered via `ocs:add_client/6`, called over RPC into the real
    running node (`rpc:call('ocs@open5gs-core', ocs, add_client, [...])` in
    `addSmfAsOcsClient()`) — a fresh throwaway Erlang node can't call this
    directly, `add_client` needs Mnesia, which only runs on the real node; (4)
    OCS's default `Origin-Host`/`Origin-Realm` derive from
    `inet:gethostname()`/DNS search domain (confirmed live: `open5gs-core`/
    `example.net` on this host, neither PLMN-related), not anything
    deployment-specific — freeDiameter rejects the CEA outright until
    `sys.config`'s diameter options set these explicitly
    (`originHost`/`originRealm` in `ocs-controller.ts`, defaulting to
    `ocs.epc.mnc<mnc>.mcc<mcc>.3gppnetwork.org`, derived live from
    `mme.yaml` — matching the `pcrf.epc...`/`aaa.epc...` naming convention
    already used for SMF's other peers). `ENABLE_OCS_MODULE` defaults
    **disabled** (opt-in) — touches an always-on core NF's freeDiameter peer
    list, same caution class as VoWiFi's S6b line.

18. **cdp (Kamailio's own Diameter module, used by P/I/S-CSCF) behaves
    differently from freeDiameter (used by every core NF + VoWiFi + OCS's Gy
    peer) in two real, confirmed-live ways — don't assume freeDiameter
    knowledge transfers.** Found wiring S-CSCF's Ro (voice/airtime charging,
    Diameter Application-Id 4 — the same Credit-Control application Gy uses,
    confirmed via `ocsSysConfig()`'s generic per-application acct/auth
    structure, so no new OCS-side listener was needed) to SigScale OCS: (1)
    **cdp resolves `<Peer FQDN="...">` via a real synchronous `getaddrinfo()`
    at connect time** — same "DNS or die" shape as gotcha #6, just for cdp
    instead of a core NF's own advertise FQDN. freeDiameter's `ConnectPeer`/
    `ConnectTo` takes an IP directly and never needed this, so SMF's own Gy
    peer never surfaced it. If you add a `<Peer>` whose FQDN isn't already
    covered by this file's own IMS BIND zone, add an `/etc/hosts` entry for
    it too, or cdp fails with a real, reproduced "Name or service not known".
    **Correction 2026-10-10**: an earlier version of this entry named
    `upsertOcsHostsEntry()` as the reusable pattern for that. No such
    function exists anywhere in the repo. The real mechanism is
    `upsertOcsDnsRecord()` (`ims-controller.ts`), which writes a BIND **zone
    record**, not an `/etc/hosts` line — and the stray OCS line actually
    present in `/etc/hosts` is a dead leftover from a superseded draft. Use
    `upsertOcsDnsRecord()`; the pre-existing HSS peer's own `/etc/hosts`
    line (`configureIms()` step 9) is the older idiom. (2) **cdp does not bind its outbound Diameter
    connection to the peer's own configured listen address — freeDiameter
    does.** Registering S-CSCF's real configured IP (`scscfIp`, e.g.
    `127.0.1.2`) as OCS's trusted client produced a real, reproduced
    `3010/DIAMETER_UNKNOWN_PEER` rejection — OCS's own log showed the
    connection actually arriving from `addresses: [{127,0,0,1}]`, confirmed
    via `kamcmd -s /run/kamailio_scscf/kamailio_ctl cdp.list_peers` (shows
    live per-peer `State`, e.g. `I_Open`, plus negotiated Application-Ids —
    the cdp equivalent of freeDiameter's `STATE_OPEN` grep-the-log check).
    `ims-controller.ts` now has a dedicated `OCS_CLIENT_SOURCE_IP =
    '127.0.0.1'` constant, always registered instead of `scscfIp` — this is
    a genuine cdp behavioral difference, not host-specific config, so it
    should hold for any future cdp-based Diameter peer this project adds,
    not just OCS.

19. **osmo-sip-connector's `MNCC_SETUP_COMPL_IND` has a real hardcoded 5s
    timer a genuine over-the-air CONNECT round trip can legitimately
    exceed — and Asterisk-2G's `_X.` catch-all had no real route to the
    external PSTN trunk at all.** Two separate, real bugs found chasing a
    "2G call rings/answers but never connects, then hangs up" report
    (confirmed live 2026-09-21): (1) `mncc.c`'s generic `start_cmd_timer()`
    (`/opt/osmo-sip-connector-build/osmo-sip-connector/src/mncc.c`, tag
    1.6.1) hardcodes 5s for several "wait for the next expected MNCC
    message" cases, including the originating leg's own
    `MNCC_SETUP_COMPL_IND` right after the callee answers — real GSM
    scheduling routinely exceeds that under normal (not faulty)
    conditions, tearing down a call both legs had just marked connected
    (`command(0x106) never arrived for leg(...)`). Widened to 15s for just
    that call site via a new `start_cmd_timer_t()` helper (every other
    caller — RTP_CREATE, REL_CNF, REL_IND — stays at the original 5s);
    baked into `osmo-sip-connector-build.ts` (`SIPCONN_SETUP_COMPL_TIMEOUT_
    PATCH`) so a reinstall picks it up too. **Widened again to 30s
    (`BUILD_REV` 3, 2026-09-26)** after a real 19-call mixed 2G/4G/5G/PSTN
    test session reproduced this exact timer firing on 3 separate calls
    even at 15s — still an explicit stopgap, not a confirmed root cause
    (worth a fresh capture with Asterisk verbose logging enabled — both
    instances' `asterisk.conf` now sets `verbose = 3` for this — before
    widening a third time if 30s still isn't enough).
    (2) Asterisk-2G's `[2g-loopback]` dialplan (`extensions2gConf()` in
    `asterisk-2g-controller.ts`) never had a real path to an external PSTN
    number — its `_X.` catch-all was built only for "2G subscriber dials
    another known subscriber's raw MSISDN" and looped ANY unmatched digit
    string (including a genuine external number) back through `sipconn`,
    which osmo-msc correctly rejected as `rx MNCC_SETUP_REQ for unknown
    subscriber number` — the call died instantly, never reaching PSTN at
    all. Fixed by generating one exact-match extension per known
    subscriber MSISDN (Asterisk always tries an exact match before a
    pattern — same idiom the file already used for short codes) and
    pointing the `_X.` catch-all itself at `pstn_trunk` instead — reaching
    PSTN Gateway's own `[pstn-internal]` `_X.` catch-all (`external_trunk`
    + its existing IMSI-keyed outbound-caller-ID DB lookup), confirmed
    live: calls now actually reach and ring a real external number in
    both directions. **What's still open, confirmed NOT fixed by either
    patch above:** a real, intermittent 2G radio-link reliability
    problem — genuine `abis_rsl.c` `Timer T200 expired (N200+1) times` →
    `CONNECTION FAIL (cause=Radio Link Failure)` on the BTS's own real
    hardware, hitting BOTH 2G UEs under test unpredictably (not one
    specific device) — is still dropping some calls mid-setup or
    mid-connect, sometimes with no user-visible signaling error at all (a
    still-open case showed a clean `MNCC_HOLD_IND`/"leg is requesting
    hold" from a real handset — genuine over-the-air Hold behavior, not
    this project's own code — right after connecting, which reads exactly
    like "connects but no audio"). As a mitigation (not a fix — the real
    cause is still open), `radio-link-timeout` in the generated
    `osmo-bsc.cfg` (`gsm-controller.ts`) was raised from 32 to 64
    (osmo-bsc's real VTY-confirmed max via `radio-link-timeout ?`; the
    test-only `infinite` option was deliberately not used — a truly dead
    link would then never release its channel at all). If a 2G call still
    intermittently fails after this, suspect the BTS's own hardware/RF
    condition next, not this project's code — swapping the physical
    nanoBTS unit is one of the next steps under consideration as of this
    date.

20. **`nsenter -p` forks internally before exec'ing the wrapped command —
    a plain `execFile`/`spawn` + timeout only kills the tracked top PID and
    orphans the real process.** This is unconditional on whether the
    wrapped command itself forks: even a bare, non-forking binary
    (`kamcmd`, `sleep`) ends up a grandchild of whatever Node process
    started it, invisible to any timeout logic that only tracks the one
    PID it spawned (documented util-linux behavior — a process cannot
    `setns()` itself into a new PID namespace, only its future children
    can; see `nsenter --help`'s own `-F, --no-fork` entry). Confirmed live
    2026-09-25 chasing a real bug in `ocs-controller.ts`'s Erlang-RPC chain
    (`runOcsEval` → `runuser` → `bash` → `erl`), then found to also be
    `LocalHostExecutor.executeCommand()`'s own underlying mechanism — the
    single most widely-used host-execution path in this codebase, with
    `KamailioStatsMonitor` alone calling through it every 15s forever in
    production, making it the highest-consequence caller found so far.
    Fixed by `backend/src/infrastructure/system/safe-nsenter.ts`
    (`safeNsenter()`): spawn `detached: true` so `nsenter` leads its own
    process group and every descendant inherits that PGID, so a timeout or
    stdout-overflow can `process.kill(-pid, 'SIGKILL')` the WHOLE group
    instead of Node's single-PID default. `LocalHostExecutor` and
    `ocs-controller.ts` are on this fixed path; `gsm-controller.ts` was
    retrofitted 2026-09-29 after a full-session audit found 3 separate 15s
    `setInterval` polling loops (VTY signal/traffic caches) still going
    through a local, unfixed `nsenter()` helper with real timeout headroom
    concerns. **Many other files still have their own local, unfixed
    `execFileAsync('nsenter', ...)` + timeout helper** (grep for that exact
    string) — most are one-shot request handlers or long detached build
    scripts (frr/kamailio/rtpengine source-build, osmo-\* builds), which
    only orphan on a rare, individual timeout, a much lower-consequence
    shape than a forever-running poll loop. If you add a NEW `nsenter()`
    caller that runs on any kind of recurring interval/loop, use
    `safeNsenter` from the start rather than copying one of the still-local
    per-file helpers — that's exactly the pattern that hid this bug for as
    long as it went unnoticed.

## Feature inventory (as of v2.0-beta_0.64, 2026-09-30)

| Feature | Status | Key backend files | Key frontend files |
|---|---|---|---|
| Core 17 NF config | stable | `yaml-config-repository.ts`, `apply-config.ts`, `config-controller.ts` | `ConfigPage.tsx` + `editors/*.tsx` |
| SEPP (N32 roaming) | stable | `sepp-controller.ts`, `sepp-config.ts` | `SeppEditor.tsx` |
| Framed Routing | stable | `subscriber-management.ts`, `ip-utils.ts` | `SubscriberPage.tsx` |
| DNS/FQDN Migration Wizard | stable, actively used | `dns-migration-usecase.ts`, `dns-migration-controller.ts`, `bind-controller.ts` | `DnsMigrationPage.tsx`, `BindPage.tsx` |
| IMS / VoLTE (PyHSS-based) | stable — real UE-to-UE calling with full audio confirmed working end-to-end over **direct IMS** on both real iPhone and Android hardware, PLMN 001-01, incl. dedicated QCI=1 bearers via the P-CSCF↔PCRF Rx interface. Earlier notes in this project's history describing Android as broken (a direct-IMS PRACK-relay socket bug, plus separate Asterisk/PSTN-path issues) are stale — confirmed fixed. **4G↔5G cross-RAT calling (VoNR), opt-in** — requires the separate, opt-in Kamailio 5.8.8→6.0.8 source rebuild (`kamailio-source-build.ts`/`/api/kamailio/source-build/*`; SCP's N5/Npcf_PolicyAuthorization interface is genuinely HTTP/2-only, fixed via `http_client_request_v2pk()`, added in Kamailio 6.0) plus a PCF `qos_profiles` config entry (`qosVoNR` → 5QI=1, already default in `pcf.yaml`). `pcscfIncludeCfg()` only `#!define`s `WITH_N5` when `isKamailioHttp2Capable()` confirms Kamailio 6.0+ is actually running — **do not remove this gate**: `http_client_request_v2pk()` doesn't exist in stock 5.8.8 at all, and calling it is a fatal config-PARSE error (P-CSCF won't start), not a runtime failure — confirmed 2026-09-30 by literally reproducing it against a real 5.8.8 binary. On a 5.8.8-only deployment (the default — every fresh install, and any existing deployment that hasn't separately run the 6.0.8 build), VoNR/cross-RAT calling stays at its prior limitation (Rx fails for a 5G leg) while everything else including direct-IMS 4G-4G/5G-5G-same-generation calling is unaffected. The 6.0.8 build's own patching step now automatically reapplies `kamailio-ims-modules-build.ts`'s `CCR_C_PATCH`/`IMS_RO_C_PATCH`/`SAVE_C_PATCH`/`CMD_C_PATCH_KAMAILIO6`/`CDP_COMMON_C_PATCH`/`CDP_ACCTSM_C_PATCH`/`SECVERIFY_C_PATCH` (the `ims_charging`/`cdp`/`ims_ipsec_pcscf`/`ims_registrar_pcscf` AVP/behavioral fixes) every time it runs — no manual reapplication needed. **N5 AppSession-ID lifecycle (PATCH-if-exists/POST-if-new/DELETE-on-call-end) implemented 2026-10-02** in `mo.cfg`/`mt.cfg` via the pre-provisioned-but-previously-unused `mo_call_id_to_call_app_session_and_ue_ip_map`/`mt_...` htables. **CONFIRMED WORKING END-TO-END on a real device, 2026-10-03**: a real 4G→5G call (0004 calling the Pixel 7 on genuine standalone NR, phone's own "Voice Network Type: NR_SA" cross-checked and confirmed accurate — PCRF explicitly logged `No Gx Session found` for the 5G leg, ruling out any EPS-Fallback-to-LTE explanation) completed with a real `200 OK`, a live multi-second conversation, and a clean `BYE` — and the full AppSession lifecycle fired correctly: initial `POST` (HTTP 201, real AppSession ID), a mid-call `UPDATE` renegotiation correctly reusing it via `PATCH` (HTTP 200, same ID — confirmed NOT creating a duplicate), then `DELETE` at hangup. Ro/Gy billing (`cdp.so` fix below) also completed cleanly for the same call. **This is the first real, end-to-end, device-confirmed validation of this project's own N5/VoNR implementation with the full AppSession lifecycle actually exercised**, not just a signaling-level success. One small, benign, NOT-fully-root-caused loose end observed in this same call: at `BYE`, `MT_N5_CALL_PCF_POLICY_AUTH_DELETE` fired twice for the same Call-ID from two different worker processes (P-CSCF relays one in-dialog message through its own MO/MT route split, which can invoke the same per-leg cleanup route more than once per message) — the first found and deleted the real AppSession (PCF returned `405`, not `204`, a minor oddity also not yet explained), the second then correctly found nothing (`sht_rm()` already having removed the entry) but logged `AppSession 0` instead of the expected "No call AppSession found" text, meaning `$sht(...)` returned non-`$null` in that instant despite the key being gone — doesn't affect call correctness (the failure path is designed to be non-fatal either way) but is worth a closer look if seen again. **What's still genuinely unresolved: whether this same success holds in NR-ONLY (no LTE) radio mode** — the investigation that led here started from a real, reproducible failure (`480 Temporarily not available` on 4G→5G, and a device-side "no mobile network" error on a 5G UE dialing out) that was initially assumed to be mode-independent; it has NOT yet been re-tested specifically in NR-only mode since the N5 AppSession fix and a real, unrelated Ro/Gy `cdp.so` charging bug (also found and fixed the same session — see that gotcha below) were deployed. Do not assume either way until specifically re-tested. Full arc: memory `kamailio_6_source_build_progress.md` and `pyhss_diameter_hang_and_pixel_5g_rejection_open.md`; PROJECT_STATE.md Known Issues §12. | `ims-controller.ts`, `kamailio-source-build.ts` | `IMSPage.tsx` |
| SMS | stable — **SMS over IMS is the default/primary path** (real phones prefer it whenever IMS-registered anyway; this is also the confirmed-working baseline). SMS over SGs (osmo-\*) is available as an opt-in, experimental alternative via a "SMS Delivery Mode" toggle on the SMS/MMS page (`POST /api/ims/sms-delivery-mode`) — selecting it hard-blocks SIP MESSAGE at S-CSCF (`#!ifdef BLOCK_IMS_SMS` in `kamailio_scscf.cfg`) so it can't silently fall through to peer-to-peer IMS delivery instead. Real two-UE SGs delivery has an open, unresolved bug (P-CSCF `ims_ipsec_pcscf` failing to relay a locally-generated reply back through the IPsec tunnel — see memory: sms-over-ims-vs-sgs-delivery-mode) — don't enable SGs mode without reading that first. Both `sms-controller.ts` and `ims-controller.ts` are involved; `configureIms()`/`/status` both default fresh deployments to `'ims'`. | `sms-controller.ts`, `ims-controller.ts` | `SMSPage.tsx` |
| MMS (VectorCore MMSC) | beta — real end-to-end MMS confirmed working on a real UE (2026-07-30), after fixing two real bugs: VectorCore logs its whole MM1 request path at Debug while shipping configured at Info (looked exactly like requests weren't reaching the app at all — set to `debug`), and real phones send MMS PDUs with no usable `From` field, which VectorCore expects a GGSN/PGW-style `X-MSISDN` HTTP header to supply. Fixed with a small compiled-Go reverse proxy (`mm1-msisdn-proxy.go`, its own `vectorcore-mm1-proxy` systemd unit, built during every Configure from the same already-guaranteed Go toolchain — deliberately not Node, which isn't a documented prerequisite anywhere in this project) sitting in front of VectorCore's real public `:8002`, resolving sender MSISDN from the UE's Framed-Routing IP and injecting the header — see memory: `mms-mm1-msisdn-header-injection-fix`. `ENABLE_MMS_MODULE` defaults **disabled** (opt-in). Lives as a second tab on the SMS/MMS page, not a separate nav entry. | `mms-controller.ts` | `SMSPage.tsx` (MMS tab) |
| PSTN / Voice Gateway (Asterisk) | **stable** — internal short-code/MSISDN dialing and Cross-RAN Calling (one toggle on the Voice Gateway page's Extensions tab, bridges this instance to Asterisk-2G — see architectural pattern #16, confirmed live 2026-09-15 with real over-the-air calls in both directions, full bidirectional audio, packet-verified) are both confirmed stable; signaling AND audio both confirmed working end-to-end (full duplex, both call directions, both the PSTN-extension dialing method and normal MSISDN dialing, over VoWiFi) — see `PROJECT_STATE.md`'s Handoff Summary for the real bugs found and fixed to get there. The external SIP trunk + inbound DID mapping mechanism (all 4 buildable phases) has been tested with real external calling and confirmed working, including a real inbound call routed to a 2G subscriber with full audio (2026-09-21, see that same date's Handoff Summary entry for the early-ringback fix this needed) — a real commercial trunk provider account is not currently linked, since there's nothing to connect to on this deployment, not because the mechanism is unfinished. `ENABLE_PSTN_MODULE` defaults **disabled** (opt-in) | `pstn-controller.ts`, `asterisk-2g-controller.ts` | `PstnGatewayPage.tsx` |
| VoWiFi (ePDG) | alpha, experimental | `vowifi-controller.ts`, `vowifi-build.ts` | `VoWiFiPage.tsx` |
| eSIM generation (Simlessly API) | stable | `esim-generator.ts`, `esim-controller.ts` | `EsimGeneratorModal.tsx` |
| Subscriber Groups | stable | `subscriber-groups-controller.ts` | `SubscriberPage.tsx` (grouping UI) |
| Syslog Forwarding | stable | `syslog-controller.ts` | `SyslogForwardingModal.tsx` |
| Major Event Classification | stable — the "view in context" card (`LogContextModal.tsx`) now also extracts structured protocol fields (TEID, S_NSSAI, PLMN, GUTI, correlation IDs, whatever else is actually present) scoped to just the selected event, via a generic `KEY[VALUE]` bracket-tag scanner (`log-event-details.ts`) rather than a hardcoded field list — confirmed working in the browser UI (user-confirmed 2026-10-06), on top of the earlier verification via the real compiled function against live log data. See memory: `major_events_log_detail_extraction` | `major-event-classifier.ts`, `log-event-details.ts` | `MajorEventsView.tsx` |
| FRR source build + crash-guard patch | stable | `frr-source-build.ts`, `frr-source-build-controller.ts` | `FrrSourceBuildTab.tsx` |
| Sercomm NR provisioning | stable | `sercomm-nr-controller.ts` | `SercommNRTab.tsx` |
| UE Validation (UERANSIM 5G + srsRAN 4G) | stable | `validation-controller.ts` | `ValidationPage.tsx` |
| CBRS SAS server | stable — has a real, deliberately-scoped WINNF-TS-0016 Category B `installationParam` validation gap: `registration()` hard-exempts exactly ONE named radio identity (`fccId=#2345CBSDTEST01`/`serial=AH193701274.NR`, a `CATEGORY_B_TEST_EXEMPT_*` constant pair) from the missing-lat/long/height/heightType rejection, per explicit user instruction on this being a test harness — every other Category B registration still gets the real rejection. Don't widen this without the same explicit direction. See memory: `sas_pki_and_nokia_grant_investigation` for the full arc — that same radio (Nokia AirScale 5G) still, as of 2026-09-28, has never sent a single `/grant` despite this and every other fix tried; unresolved. | `sas-service.ts`, `sas-controller.ts` | `SASPage.tsx` |
| GenieACS radio provisioning | stable | `genieacs-controller.ts` | `AutoConfigPage.tsx`, `FemtoConfigTab.tsx` |
| Traffic History (aggregate + per-subscriber) | stable | `subscriber-ip-accounting.ts`, `prometheus-metrics.ts`, `traffic-history-controller.ts` | `TrafficHistoryPage.tsx` |
| Security Gateway (SecGW) | alpha — real IPsec tunnels confirmed live for both radio vendors simultaneously: 3 Baicells eNBs (IKEv2 Configuration Payload/virtual-IP based) and 1 Nokia AirScale (static tunnel endpoints + traffic selectors, no CP) — real S1AP/GTP-U traffic verified flowing through the tunnel via packet capture (ESP wrapper + decrypted SCTP heartbeat to MME, 2026-08-14). See architectural pattern #15 for why Baicells and Nokia are configured completely differently. `ENABLE_SECGW_MODULE` defaults **disabled** (opt-in). | `secgw-controller.ts`, `secgw-build.ts` | `SecGWPage.tsx` |
| RF Planning | **beta — rewritten 2026-10-13 to A.T.O.M feature parity, in our own design.** Workflow is deliberately one line: **drop radios on the map -> enter parameters -> Simulate**; everything else is progressive disclosure. The headline addition is **deterministic segmented ray tracing** (`ray-trace.ts`): rays are cast across the sector beam and marched in 25 m steps, charging per-wall penetration loss at every building footprint crossing, emitting colour-coded segments that carry their own evidence (wall loss, LOS state, obstructing building id) so the map answers *why* a street is dark rather than only *that* it is. Ten capabilities were added to the pre-existing ~4,100-LOC engine (which already had more propagation models than A.T.O.M: FSPL, Hata, Walfisch-Ikegami, close-in/UMi, log-distance, ITM/Longley-Rice, diffraction, Fresnel, earth curvature, terrain/landcover): **`uma-model.ts`** (3GPP TR 38.901 UMa, the model A.T.O.M used), **`building-index.ts`** (grid-indexed footprints, segment intersection, and height-aware LOS/NLOS that reports `unknown` when blockage rests only on an assumed height), **`radio-quality.ts`** (RSRP/SINR/RSRQ/RSSI), **`building-entry.ts`** (TR 38.901 O2I), **`coverage-gap.ts`**, **`network-optimize.ts`** (demand-weighted azimuth coordinate descent + Pareto frontier + marginal-gain site ranking), **`measurement-validation.ts`** (MAE/RMSE/bias on **spatially blocked** folds, never a random split, plus a holdout-checked calibration offset), and **`osm-buildings.ts`** (Overpass footprint import with demand scoring). **Two corrections to what A.T.O.M did, both load-bearing**: its NR resource-block table hardcoded 120 kHz SCS (FR2/mmWave), which is the wrong radio for CBRS n48 — ours takes SCS explicitly and defaults 5G to 30 kHz (51 RB at 20 MHz, not 66 at 100 MHz, a ~6 dB RSSI error); and its demand table scored OSM `building=yes` at zero, which is the most common tag in suburban mapping and made demand-driven optimisation inert on real data (measured: a sector facing 10 real buildings reported totalDemand 0). Model reference, including every formula and the parity checklist: **`docs/rf-planning-model-reference.md`**. Uses raw `leaflet` only — **never add `react-leaflet`**, which is Hippocratic-2.1 and conflicts with this project's AGPL-3.0 licence. **Extended 2026-10-13 (same day) with the heatmap, multi-sector sites, model selection, a context inspector and a PDF report.** (1) **Coverage heatmap** (`coverage-heatmap.ts`) is the continuous best-server raster the ray tracer deliberately is not — the raster answers "how good is it here", the rays answer "why", and both share `receivedPowerAtPoint()` so they cannot disagree about identical geometry. The grid is row-major with **row 0 at the NORTH edge** so the client blits it straight into an `ImageData`; there is a test asserting that ordering using the antenna pattern as a compass, because a vertically mirrored raster is a completely plausible-looking bug. Rendering interpolates bilinearly between real samples but **never across a `null`**. (2) **Standard 3-sector and 4-sector site placement**: sectors sharing a `siteId` are one mast, so moving the site moves every panel, and the inspector splits **site-level** fields (position, height, channel, technology) from **sector-level** ones (azimuth, beamwidth, tilt, power). Getting that boundary wrong is what makes a sectored editor painful — per-sector height silently drifts, per-site azimuth makes a sectored site impossible. Defaults are what actually gets ordered: 3×65° on 120° spacing, 4×45° on 90°. (3) **Context inspector** — selecting a site marker, a sector wedge or a building footprint switches the right-hand panel to that thing. It is docked beside the map, never floating over it, so the geometry stays visible while being edited. The building context is also the only home for the O2I entry-loss calculation, since entry loss only means anything against a specific building. (4) **Model selection** (`propagation-select.ts`) is the single synchronous dispatcher for both the rays and the raster; `site-signal.ts`'s async `computeBasePathLossDb()` delegates to it and keeps only its ITM branch, so the dispatch stays single-sourced. ITM is deliberately not offered (profile-shaped, meaningless without per-point terrain). **The load-bearing fact: at CBRS 3.6 GHz, Hata (0.15–1.5 GHz), COST-231 (1.5–2.0) and Walfisch-Ikegami (0.8–2.0) are all out of band, and they HARD-REJECT out-of-range inputs rather than extrapolating** — so selecting one used to mean a technically-successful run with an empty map and no stated reason. `modelApplicability()` now gates the run up front, quotes the real published range, and names the models that do cover the scenario. A radius below a model's minimum is blocking; above its maximum is only a warning. Suggestions are computed by a separate non-recursive helper — recursing into `modelApplicability()` blows the stack as soon as two models are mutually inapplicable, which is the normal case here. (5) **PDF report** (`rf-simulation-report.ts`, `POST /report.pdf`) renders the current workspace including the coverage raster, which the CLIENT supplies as a PNG — the older projects report's own header comment flags its missing map as a known fidelity gap, and this closes it without adding native `canvas` or a headless browser to the image. Two pdfkit traps are handled explicitly: a positional `doc.text(str, x, y)` leaves the text cursor parked in that column, so every block writer re-asserts the margin (otherwise later prose renders inside a ~100 pt gutter on the right), and each table cell is height-clamped so an over-long value ellipsises instead of wrapping the row. Legacy `/link-budget`, `/point-analysis`, `/coverage-grid`, `/interference-grid` and the projects/reports store are retained and still regression-tested; saved projects load into the new workspace via `ProjectBar.tsx` as single-sector sites (the stored schema has no multi-sector concept, and guessing which saved sites share a mast from their coordinates would let one radio's edits silently move another). `ENABLE_RF_PLANNING_MODULE` gates visibility. | `rf-planning-controller.ts`, `rf-simulation-controller.ts`, `domain/rf/*` | `RfPlanningPage.tsx`, `components/rfplanning/{PlanningMap,RadioEditor,ProjectBar}.tsx` |
| UE Signal Monitoring | **new, community-contributed** (PR #32) — per-UE RSRP/RSRQ/SINR/BLER/MCS/CQI/throughput correlated with subscriber identity (IMSI/ICCID/MSISDN), 7-day SQLite history, AES-256-GCM encrypted radio credentials, admin-triggered downlink wake for idle UEs. **Baicells-native connector only** — other vendors need the generic JSON connector, which requires the radio to already expose its own metrics in that shape, so it is not a drop-in for every vendor. `ENABLE_UE_SIGNAL_MODULE` defaults **enabled** (set to `false` to hide it — this is a visibility gate, not an install/uninstall lifecycle like most other opt-in modules). | `radio-signal-controller.ts` | `RadioSignalPage.tsx` |
| 2G GSM (Osmocom) | **alpha** — real GSM radio access (osmo-bsc/osmo-bts) layered on the osmo-hlr/osmo-msc/osmo-stp that SMS-over-SGs already runs, on real nanoBTS hardware confirmed on-air. CS attach/ciphering, GPRS/EDGE data, and 2G↔4G SMS (via VectorCore SMSC, its own separate module) are **stable**. Real voice calling is **alpha**: osmo-msc's own built-in call handler can complete signaling (ring/answer) but never implements `MNCC_RTP_CREATE` (confirmed live 2026-09-13, upstream Osmocom limitation, not fixable here) — no audio ever flows in Internal mode. Real 2G↔2G audio needs External mode routed through **Asterisk-2G**, a second, fully isolated Asterisk instance (own config tree, own systemd unit, own loopback IP `127.0.1.7` — never touches the separate Asterisk instance PSTN Gateway owns) whose only job is looping a call back through osmo-sip-connector so the second phone gets paged. One button (GSM page's "2G Voice" tab, gated on `ENABLE_ASTERISK_2G_MODULE`, defaults **disabled**) installs, configures, wires the SIP tab's remote peer, and switches MNCC to External automatically. `ENABLE_GSM_MODULE` defaults **disabled** (opt-in) — real radio (and, for a real BTS, actual spectrum transmission) is a bigger blast radius than a broken lab feature. If a real call ever fails at TCH assignment (osmo-bsc logs "Assignment Failure"/"NACK on IPACC CRCX"), it is NOT necessarily a hardware issue — see architectural pattern #16's tail and memory `gsm_2g_osmocom_module_progress.md`: a real `codec-support`/AMR config mismatch caused exactly this, confirmed live 2026-09-15, and had been misdiagnosed as unfixable hardware the day before. | `gsm-controller.ts`, `asterisk-2g-controller.ts`, `osmo-sip-connector-build.ts` | `GsmPage.tsx` |
| 3G UMTS (OsmoHNBGW) | **alpha** — Home NodeB Gateway bridging a 3G femtocell's Iuh interface to the existing osmo-msc (IuCS) and osmo-sgsn (IuPS) over the already-running osmo-stp. `osmo-hnbgw` isn't an apt package on this host — built from source, pinned to tag `1.3.0` (NOT the `1.9.0` every other daemon here uses — its own version numbering is independent, and `1.9.0` needs a newer `libosmocore` than this host has; confirmed live 2026-09-13 via a real scratch build). Adds a new `cs7`/IuPS point-code block into the 2G module's own `osmo-sgsn.cfg` via ownership-merge (never a blind overwrite — see `vty-config-ownership.ts`), and a third, dedicated OsmoMGW instance (own config/systemd unit/loopback `127.0.1.8`, reusing the already-installed `osmo-mgw` binary). `osmo-stp.cfg`/`osmo-msc.cfg` need **zero changes** — confirmed live from both HNBGW's and MSC's own logs (STP's existing dynamic-ASP-registration + MSC's existing SCCP link both already handle it). Subscriber credentials need no new provisioning either — reuses the 2G module's own `gsmEnabled` flag and its `auc_3g` MILENAGE row (confirmed via OsmoHLR's own manual: the same row serves both 2G and full UMTS AKA). A software test HNB, **OsmoHNodeB** (tag `0.1.0`, same source-build pattern, needs its own dedicated GTP-U bind `127.0.1.9` — its default collides fatally with Open5GS's own UPF), deployable from the module's own page, proved a full live HNBAP registration end-to-end before any real hardware was touched. Real hardware target: an ip.access nano3G — unlike 2G's OML, Iuh/HNBAP has no remote-provisioning push, so a real HNB self-registers once pointed at this gateway's IP on its own local config, rather than being discovered/pushed-to from this NMS. `ENABLE_HNBGW_MODULE` defaults **disabled** (opt-in). | `hnbgw-controller.ts`, `osmo-hnbgw-build.ts`, `osmo-hnodeb-build.ts` | `HnbPage.tsx`, RAN page's "3G UMTS" section |
| SigScale OCS (Online Charging, Diameter Gy) | **beta** — real-time prepaid credit-control charging for 4G/EPC PDN sessions, wiring Open5GS SMF's own native Gy client (present since v2.4.7, previously completely dormant in this deployment) to a newly-installed SigScale OCS (Erlang/OTP, real apt package via a pinned Google-Cloud-hosted `.deb`, not source-built). Full one-button Configure: writes OCS's own `sys.config`, registers SMF as a trusted Diameter client via `ocs:add_client/6` (RPC into the real running node — Mnesia only works there, not on a throwaway node), upserts the `ocs.*` Gy `ConnectPeer` into `smf.conf`, restarts `open5gs-smfd`, and verifies a real `STATE_OPEN` Gy connection from SMF's own log — end-to-end confirmed live 2026-09-16. **4G/EPC only — 5G NR sessions are never charged by this integration**; see architectural pattern #17 for why SigScale's 5G product (`chf`) was researched and explicitly excluded (Open5GS SMF has no Nchf client upstream). Pattern #17 also covers the 4 real bugs found getting the Gy peer to actually connect (port conflict, wildcard-bind conflict, default-deny client registration, Origin-Host/Realm mismatch) and the exclusive-naming-slot scheme that lets this module and VoWiFi both safely own one `ConnectPeer` line each inside the same `smf.conf`. No rating-plan/balance/subscriber CRUD in this NMS — Setup tab links out to OCS's own Polymer web GUI and REST API docs instead, matching this project's established "link out, don't reimplement" convention for full third-party apps. **Voice/airtime charging (Diameter Ro), added 2026-09-17, confirmed fully working end-to-end** — completes the dormant `#!ifdef WITH_RO` block `kamailio_scscf.cfg` already carried (same "built, left disabled" shape as pattern #13's Rx interface); shares OCS's existing Gy listener (same Diameter Application-Id 4), new `setVoiceChargingEnabled()`/`POST /api/ims/voice-charging` toggle (in `ims-controller.ts`, defaults **off**, same risk class as Gy). Getting a real call to actually complete took 2 cdp-vs-freeDiameter connectivity bugs (architectural pattern #18) plus **five separate real bugs inside the compiled `ims_charging.so` module itself** — duplicate Origin-Host/Realm AVPs, two AVPs that don't belong in a CCR at all (Accounting-Record-Type/Number, Vendor-Specific-Application-Id), a missing mandatory Auth-Application-Id, and a subscriber-identity format (`sip:` URI vs `tel:` URI) OCS's lookup didn't recognize — every one confirmed via OCS's own `erlang.log`, not guessed. All five are now real unified-diff patches baked into `kamailio-ims-modules-build.ts` (`CCR_C_PATCH`/`IMS_RO_C_PATCH`, same `apt-get source` → `patch` → build → ABI-verify → `.apt-original`-backup → deploy pipeline already used for `ims_ipsec_pcscf`/`ims_registrar_pcscf`), not just hand-patched on one host — independently verified by running the real generator script end-to-end against a fresh source fetch. Full bug-by-bug writeup: memory `sigscale_ocs_module_progress`. `ENABLE_OCS_MODULE` defaults **disabled** (opt-in). | `ocs-controller.ts` | `OcsPage.tsx` |
| Charging Plans (simple data + voice caps GUI) | **beta, voice half confirmed working end-to-end 2026-09-17** — a deliberately simplified layer over SigScale OCS's own full rating-plan vocabulary, per explicit user request ("the sigscale gui is to complex"). One GUI "Plan" (name + data cap GB + voice cap minutes) = one OCS bundle offer referencing a data sub-offer (`specification="4"`) and a voice sub-offer (`specification="5"`, source-confirmed correct against the real rating engine's `?IMSVOICE` guard). New `nms_charging_plans` Mongo collection mirrors Subscriber Groups' own CRUD/assignment shape exactly; subscriber assignment reachable both from the Subscribers page's bulk-select toolbar AND a per-row "Set plan" control in the Plan column (added after the bulk-only flow proved hard to discover). **Real bug, found chasing a usage readout stuck at 0 despite a confirmed real charge**: `assignSubscribersToPlan()` linked a subscriber's IMSI and MSISDN to OCS **separately**, landing them on two disconnected products with independent buckets — Gy (data) keys off IMSI, Ro (voice) keys off MSISDN, so a subscriber's data and voice usage silently drew from unrelated pools. Fixed to link every identity for one subscriber to a single shared product atomically; full mechanics (including a second bug in the fix's own "already linked" short-circuit) in memory `sigscale_ocs_module_progress`. Depends on SigScale OCS being installed/configured first; the voice half additionally depends on the Ro toggle above. **An "Unlimited" plan (1,000,000 GB / 1,000,000 min — a deliberately huge finite cap, not a dedicated no-cap code path, to avoid exercising an untested interaction with the still-unresolved `charge2` crash below) is auto-provisioned by `ensureDefaultUnlimitedPlan()` on every OCS Configure, idempotent by plan name.** A cap at/above 100,000 GB or minutes renders as "Unlimited" in the UI instead of the raw number (`ChargingPlansPage.tsx`, `TrafficHistoryPage.tsx`, and the Subscribers page's plan dropdown all apply this). A real, still-unresolved **OCS-side rating-engine bug** (`ocs_rating:charge2`, `function_clause` on `type: final`/termination) periodically leaks stuck Gy/Ro reservations across multiple subscribers — no longer needs manual intervention: `OcsReservationGuard` (`backend/src/application/use-cases/ocs/ocs-reservation-guard.ts`, started unconditionally in `index.ts`, on by default) sweeps every 30 minutes and clears any reservation entry older than 2 hours via a balance-preserving Mnesia write (`remain` never touched, verified live). The deep root cause itself is still not fixed (no exact-version source obtainable for the installed 3.4.73 release, and the `.beam` has neither debug info nor an exported `charge2` to probe) — the guard is a mitigation, not a patch. Full diagnostic arc, including a complete captured crash dump and the recommended next step (file it as a SigScale GitHub issue), in memory `sigscale_ocs_module_progress`. | `charging-plans-controller.ts`, `ocs-reservation-guard.ts` | `ChargingPlansPage.tsx` |
| Call History (CDR module) | **beta** — unified call detail records across PSTN, 2G, and 4G/5G IMS, synced into a new `nms_cdr` Mongo collection (retention-configurable TTL index, default 180 days) from each system's own real source rather than a new primary store (same CLAUDE.md pattern #12 distinction as Traffic History vs. Prometheus). Three independent phases, staged by risk: **Phase 1** (PSTN Gateway Asterisk CSV tailing) stable, verified against a real 76+-row dataset. **Phase 2** (Asterisk-2G) — fixed a real bug where `asterisk-2g-controller.ts` never created the `cdr-csv/` subdirectory `cdr_csv.so` needs, so it silently never wrote a single record; **confirmed working live 2026-09-25** (found independently by two agents researching the Asterisk Grafana dashboard, then re-confirmed via a direct aggregation query — 75 real rows with correct dispositions/durations from real Cross-RAN Calling test calls). **Phase 3** (direct 4G/5G IMS-to-IMS calls, the one path with no B2BUA CDR of its own) — Kamailio's own `acc` module, basic flag-based `db_flag`/`db_missed_flag` accounting (deliberately NOT `acc`'s newer `cdr_enable`, which needs a module literally named `dialog` that this deployment doesn't load — see `ims-controller.ts`'s `scscfIncludeCfg()` comment), gated behind its own `WITH_CDR` build flag plus a runtime toggle (`setCdrAccountingEnabled()`, "Direct IMS Call Recording" on the Call History page's Settings panel) independent of the module's own compile-time gate, same shape as OCS's Ro toggle. **Confirmed fully working end-to-end live 2026-09-17** against 3 real test calls (answered, a rang-then-fell-to-voicemail call, and a PSTN-Gateway-routed call captured correctly as its real two separate B2BUA-split dialogs) — see architectural pattern #16's sibling gotcha (added this same day) on why the live host's static template was stale and needed a manual redeploy before the toggle could do anything. `missed_calls` (busy/rejected calls) is implemented per Kamailio's well-documented, stable module behavior but not yet empirically verified live — no real busy-call test was available this session. A voicemail pickup is indistinguishable from a normal human answer at the SIP/`acc` level (both are real 2xx-terminated INVITE transactions) — documented in the UI's info banner, not a bug. Full arc: memory `cdr_module_progress`. | `cdr-store.ts`, `cdr-sync-monitor.ts`, `cdr-controller.ts` | `CallHistoryPage.tsx` |

| IP Plan Tool | **beta** — bulk re-address a whole deployment from one page instead of visiting every module's own, via an explicit "Propose → review → Apply" flow (never an ambient background sync — a full redesign after direct user correction of the original silent-write-back version). `GET /api/ip-plan` always reads each module's own **current** live state fresh, never a registry; `POST /api/ip-plan/propose {subnet}` is a pure preview computing non-colliding suggestions (`ip-suggest.ts`); `POST /api/ip-plan/apply` is the only write path, an async job (`ip-plan-apply-usecase.ts`, same polling pattern as `module-fixall-usecase.ts`) that live-applies opt-in-per-row for secgw-gateway/vowifi-epdg/gsm-bsc-mgw+gsm-sgsn-gb/ims-pcscf+ims-rtpengine/pstn-external-trunk/mms-mm1/all 7 core-17 address fields (batched into one `AutoConfigUseCase.execute()` call, `applyInterfaces`/`applyPfcp` toggled only for groups actually touched, `localUpfOnly`/`localSgwuOnly` explicitly forced off when a PFCP field is checked since that flag would otherwise silently no-op the change) — while sepp-sbi/sepp-n32c/sepp-n32f/bind-dns are **registry-only, unconditionally**, since SEPP's only live-apply path is a full 17-NF core restart, disproportionate for 3 fields. IMS is ordered before PSTN/MMS in the same batch (both depend on it) with an explicit short-circuit if IMS's own step fails partway through a run. The old bulk-save route and its frontend client method were deleted outright as part of the rewrite (not just stopped being called) — a deliberate verification mechanism so any stale call site fails to compile instead of silently doing nothing; confirmed zero remaining `ipPlanApi.save()` call sites anywhere in the frontend. **Confirmed working end-to-end with a real live Propose → Apply click-through (user-confirmed 2026-10-06)**, on top of the earlier static audit against its own approved plan (which found no deviations). Known edge case still worth knowing: an MME/AMF interface currently bound by interface name (`dev:`) rather than a static address reads as "not configured", and applying a plan there converts it to address-binding. | `ip-plan-controller.ts`, `ip-plan-apply-usecase.ts`, `ip-suggest.ts`, `main-interface.ts` | `IpPlanTab.tsx` (a tab on the Auto-Configuration Wizard page) |
| RAN Kill Switches (Dashboard) | **beta** — five header buttons (Block RAN, plus Block 2G/3G/4G/5G individually) that bulk-block every currently connected/registered radio of that generation, each flashing red (`animate-flash-red`) for as long as anything of that generation is currently blocked and doubling as the unblock-all action while flashing (explicit user request). 4G (`radio-block-controller.ts`) and 5G (`gnb-block-controller.ts`) reuse pre-existing nftables mechanisms unchanged. **3G had no blocking mechanism of any kind before this feature** — built `hnb-block-service.ts`/`sqlite-hnb-block-repository.ts`/`hnb-block-controller.ts` from scratch mirroring `gnb-block-service.ts`'s exact shape (own nftables table `open5gs_nms_hnb_block`), with one real difference from every other generation's block service: HNBGW's Iuh port is operator-configurable in this project (`HnbgwState.iuhLocalPort`, unlike S1AP/NGAP's fixed 3GPP port numbers), so the service reads it live via an injected `getIuhPort()` callback and encodes the port into each rule's own tracking comment (`hnb_block_<ip>_<port>`) so a port change while blocked is detected as "no longer desired" by the existing reconcile loop instead of silently leaving a dead rule. 2G reuses the real per-BTS osmo-bsc admin-lock (`blockBtsByIdx`, extracted from the pre-existing single-BTS route so the new bulk `/bts/block-all` route can drive it) — genuinely different blast radius (drops camped UEs immediately, real device impact) than the other three's mild host-only nftables rules, so its button/copy are deliberately distinct rather than looking identical. **Building this feature's 2G path surfaced a real, long-standing bug — see the 2G GSM gotcha below.** | `radio-block-controller.ts`, `gnb-block-controller.ts`, `hnb-block-controller.ts`, `gsm-controller.ts` | `DashboardPage.tsx`, `RANPage.tsx` (same flash-red treatment extended to every individual per-radio Block/Unblock button) |
| TWAMP (Backhaul Link Quality) | **stable** — RFC 5357 TWAMP client + reflector, own thin Go wrappers (`twamp-client.go`/`twamp-server.go`) around `github.com/ncode/twamp`, vendored+patched for multi-homed bind-IP support (see that patch's own header comment). Client side runs short-lived tests against operator-added targets (currently 3 real Nokia radios on this deployment, all TWAMP-Light) on a per-target poll cadence; reflector side is the reverse direction (an always-on systemd service, `twamp-server.service`, answering inbound tests from other TWAMP-capable devices) — independent of each other. History persists to `nms_twamp_history` (retention-configurable TTL index); live status/metrics reuse the existing Prometheus+Grafana stack (`twamp.json` dashboard, uid `twamp-backhaul`, 11 metrics) rather than a new store, same pattern as Traffic History. **Real bug fixed 2026-09-25** (found building that dashboard): TWAMP-Light blocks per-LOST-packet on the binary's own `-timeout-ms`/`-interval-ms`, previously never passed explicitly and never accounted for by the external Node-side safety timeout — as few as 2-3 lost packets out of a normal 10-packet test could exceed that external budget, and the empty stdout this produced was silently parsed as a valid-but-all-blank result (`JSON.parse('{}')` doesn't throw) instead of a real error, hiding real packet loss as no-data-at-all. Fixed by deriving both the binary's own flags and the external timeout from the same shared constants, and no longer accepting empty stdout as a silent success — confirmed live against a real currently-lossy target (10/10 loss, real `"reflector unreachable"` error now returned in ~40s instead of a blank result). Also fixed the same session: the 8 success-gated Prometheus gauges (RTT/jitter/loss/one-way-delay) never called `.remove()` on a failed test, so a target that stopped succeeding kept showing its last-good value frozen forever instead of a gap — same bug existed a second way for a fully deleted target, since `TwampMonitor`'s in-memory cache never pruned one either. `ENABLE_TWAMP_MODULE` defaults **disabled** (opt-in). | `twamp-controller.ts`, `twamp-runner.ts`, `twamp-monitor.ts`, `twamp-metrics.ts`, `twamp-history.ts` | `TwampPage.tsx` |

Full detail on any of these: `docs/features.md`.

## Reference facts

- **PLMN**: MCC 001, MNC 01 (`5gc.mnc001.mcc001.3gppnetwork.org`,
  `epc.mnc001.mcc001.3gppnetwork.org` — the two zones the DNS Migration Wizard
  manages; migrated off the original 999-070 test PLMN, confirmed live 2026-07-29 —
  older docs/memory referencing 999/070 are stale).
- **Radio IPs** (verify before trusting — deployments change):
  - `10.0.2.100–102` — Baicells eNB(s), B48, 4G/LTE
  - `10.0.2.47` — Nokia AirScale Pico BBU, B66, 4G/LTE side (re-IP'd from
    `10.0.2.214` as of 2026-09-27 — the same physical unit, now split into
    separate 4G/5G IPs; `.214` is stale, don't trust older notes citing it)
  - `10.0.2.48` — same Nokia AirScale Pico BBU, 5G NR side
  - `172.16.0.117` — Sercomm SCE5164-B48 gNB, B48, 5G NR
  - EIGRP neighbor for the RAN-facing routes: `192.168.253.1` on `ens20`.
- **SAS bands**: Baicells B48 CBRS (group `baicells`, 3550–3700 MHz, 20 MHz slots),
  Sercomm B48 CBRS (group `SC_Group`, 3616–3655 MHz). Sercomm FCC IDs start `P27-`.
- **Backend port** 3001, **frontend** 8081 internally / nginx on 80 + 8888 externally,
  **SAS HTTPS** 8443, **Sercomm factory-default ACS relay** 443 (DNS-hijack trick, needs
  `acs.crt`/`acs.key` with `CN=acs.sc.sercomm.com` — see gotcha below).
- **Version**: `backend/package.json`/`frontend/package.json` version should match
  `CHANGELOG.md`'s top entry — keep them in sync when bumping.

## Known-fixed gotchas worth knowing about (so you don't reintroduce them)

- **nginx needs two self-signed certs to start at all** (`nginx/setup-sas-cert.sh`,
  run by the `cert-init` Docker service): the SAS cert pair and
  `acs.crt`/`acs.key` (must be `CN=acs.sc.sercomm.com` — hardcoded in `nginx.conf`'s
  `server_name`). Missing either one means nginx fails to start entirely (it loads
  every `conf.d/` server block up front) — found on a genuinely fresh install where
  only the `sas.crt` generator existed; `acs.crt` had only ever been created manually
  on the original dev host and nobody noticed the script never made it.
  **The SAS side is a real two-tier PKI now, not a single flat self-signed
  cert** (changed live 2026-09-27): `sas.crt`/`sas.key`/`sas.pem` is a proper
  root CA (`basicConstraints=CA:TRUE`) — this is what a radio's own "install
  CBRS vendor chain" flow should be pointed at (downloadable at
  `/sas-cert/sas.crt` or `.pem`, same bytes, two extensions since some
  radios' upload UIs validate on extension). `sas-leaf.crt`/`sas-leaf.key`
  is the actual TLS server identity nginx presents (signed BY that root,
  not self-signed); `sas-fullchain.crt` (leaf+root concatenated) is what
  `nginx.conf`'s `ssl_certificate` directive actually references. Root
  cause: Nokia AirScale's own CBRS Cert Management rejected the old flat
  self-signed leaf outright ("Invalid trust chain - intermediate CA or root
  CA of EE/RA is missing") since it had no `CA:TRUE` marker for firmware to
  recognize as a real trust anchor — confirmed live, and confirmed the
  rebuild didn't break already-connected radios (Baicells/Sercomm kept
  heartbeating successfully through the nginx restart that deployed it).
  If you ever touch these files again: `sas.crt` is the root now, not a
  leaf — don't hand it to nginx's own `ssl_certificate` directive directly.
- **`.gitignore` must exclude runtime data**: `mongo_docker/`, `hlr.db*`, `sms.db`,
  `backend/radio-backups/` — these contain real subscriber keys/PII and are NOT
  meant to be committed. Already fixed once (2026-07-16) after nearly being swept
  into a commit via `git add -A`.
- **CIDR/IP-range math**: `backend/src/domain/services/ip-utils.ts`'s `cidrRange`/
  `cidrNetworkRange` had a real bug — any subnet with a first octet ≥128 (e.g.
  `192.168.x.x`) produced a corrupted signed 32-bit integer from an unmasked bitwise
  `&`, silently returning wrong ranges. Fixed by normalizing with `>>> 0` after the
  AND. If you add more IP-math helpers, watch for this exact class of bug — it's a
  classic JS bitwise-operator footgun (`&`/`|` operate on signed Int32).
- **jest wasn't actually installed** despite being in `backend/package.json`'s
  devDependencies — `npm test` was silently broken. If tests won't run, check
  `node_modules/.bin/jest` actually exists; `npm install` fixes it.
- **PyHSS's own `Answer_16777216_300`/`_302` (Cx UAA/LIA) could crash on a
  missing AVP** (`/opt/pyhss/lib/diameter.py`, a third-party file, not part of
  this repo): if the expected identity AVP was absent, an `IndexError` inside
  the `try` block left the id variable (`imsi`/`username`) unassigned, and the
  `except` handler's own Redis-metric label then referenced that same
  unassigned variable, raising a second, uncaught `UnboundLocalError` — the
  function died before writing either the success AVP or the proper
  `5001 Experimental-Result-Code`, which looked exactly like a "genuinely
  intermittent" Cx failure with no result code at all. Fixed live (2026-07-26)
  and baked into `POST /api/ims/install` in `ims-controller.ts` (same
  idempotent, exit-code-checked patch style as the `cdp.so` process-slot
  patch above it) — runs on every Install, so existing deployments just need
  to re-run Install to pick it up. See memory: `ims-pyhss-uaa-lia-crash-guard`.
- **PyHSS's `default_ifc.xml` could corrupt a subscriber's SIP identity to
  `sip:<msisdn>@None`** (`/opt/pyhss/default_ifc.xml`, a third-party file, not
  part of this repo): its `<PrivateID>`/`<Identity>` elements built the
  domain from `scscf_realm`, a DB column `database.py`'s
  `Update_Serving_CSCF()` explicitly nulls on every deregister — a
  deregister/re-register race could bake the literal string `"None"` into
  the subscriber's Implicit Registration Set, cached by S-CSCF until the
  next re-register. Looked exactly like a client-side phone bug (previously
  "fixed" by toggling Airplane Mode) — it wasn't. Fixed by deriving the
  domain from `mnc`/`mcc` instead (always fresh, never touched by the
  dereg-clearing bug). Fixed live (2026-07-27) and baked into
  `POST /api/ims/install` the same way as the two bugs above. See memory:
  `ims-pyhss-none-domain-corruption`.
- **Phantom `nms-*` classes/tokens silently render unstyled — Tailwind doesn't
  error on an undefined custom class, it just generates nothing.** Found live
  (2026-08-14): `nms-btn-secondary` was used on 5 buttons across the frontend
  but was never defined in `index.css` (only `nms-btn-primary`/`nms-btn-danger`/
  `nms-btn-ghost` exist) — every button using it rendered with zero color/box
  styling. A full audit turned up the same class of bug three more times:
  `nms-accent-hover`/`nms-surface-1`/`nms-text-secondary` used as Tailwind
  color tokens in 20+ places but never defined in `tailwind.config.js`'s
  `colors`, and `nms-checkbox` used on 11+ checkboxes with no CSS rule at all.
  If you add a new `nms-*`-prefixed class or color token, grep both
  `index.css` and `tailwind.config.js` first to confirm it actually exists.
- **A static IMS Kamailio template (`kamailio_scscf.cfg`/`pcscf.cfg`/etc.) only
  reaches the live host via `deployImsTemplate()`, which only runs inside a
  full IMS Install/Configure — none of the lightweight per-feature toggle
  setters (`setSmsDeliveryMode()`, `setVoiceChargingEnabled()`,
  `setCdrAccountingEnabled()`, etc.) ever call it.** Those setters only
  rewrite the small *generated* include file (`scscf.cfg`) and restart the
  one affected service — editing the static template source in this repo and
  then just flipping a toggle does NOT redeploy your edit. Found live
  2026-09-17 wiring CDR Phase 3: `kamailio_scscf.cfg`'s live host copy was
  stale by a full day, missing both that day's earlier Ro/voice-charging
  origin-host fix AND the new WITH_CDR blocks — `setCdrAccountingEnabled(true)`
  restarted `kamailio-scscf` and reported success, but the running config
  still had no `acc` module loaded at all, since only the *generated*
  `scscf.cfg` had been rewritten. If you edit a static IMS template's source
  and need it live without a full re-Configure, redeploy that one file
  manually (copy the built `dist/config/ims-templates/.../*.cfg` to its real
  host path) before restarting the service — don't assume any toggle setter
  did it for you.
- **The 2G BTS Block/Unblock feature (`gsm-controller.ts`) never actually
  worked, since the day it was first built — a background osmo-bsc
  reconciliation loop silently overrode it every time, with zero error
  anywhere.** Only discovered 2026-09-21 because the RAN Kill Switches
  Dashboard feature finally gave this route its first-ever real UI trigger.
  The original command, `change-adm-state locked` sent at the `(oml)`
  pseudo-node (targeting NM object class "bts" directly), is accepted with
  zero VTY error and zero journalctl error — but osmo-bsc's own
  `nm_bts_fsm.c`'s `configure_loop()` runs a background reconciliation that
  silently re-unlocks any "bts"-class object it considers should be in
  service, with no guard against a manual lock at that level. Confirmed live
  by locking, then re-reading `show bts N` immediately and repeatedly over
  8+ seconds — Admin state never left 'Unlocked', and the OML Link's own
  uptime counter never reset either (ruling out a reconnect race, not just a
  timing issue). Root-caused by reading osmo-bsc 1.9.0's real source
  (`apt-get source osmo-bsc`, not guessed) — `rf_locked (0|1)`, a
  config-tree command on the TRX object specifically (`configure terminal`
  → `network` → `bts N` → `trx N`), is the real, sticky mechanism: it sets
  `trx->mo.force_rf_lock`, the one guard the equivalent TRX-level
  reconciliation loop in `nm_rcarrier_fsm.c` DOES check before
  auto-re-unlocking. Fixed in both `blockBtsByIdx` (the interactive route)
  and `reapplyBtsLocks()` (the restart-recovery counterpart, which means
  **this also silently never worked for the entire time the 2G module has
  existed** — any BTS marked `blocked` never actually came back locked
  after an osmo-bsc restart). The verify query also had to change: `show
  bts N` has no per-TRX NM State line at all — `show trx N 0` is what
  prints the TRX's own "Radio Carrier NM State", which
  `parseBtsLinkStatus`'s existing regex still matches unmodified. If you
  ever add another osmo-bsc administrative-state action, don't assume
  `change-adm-state` at a low-level NM pseudo-node actually sticks for
  every object class — check whether that class's own FSM has a
  `configure_loop()`-style reconciliation loop first, and whether a
  dedicated `force_rf_lock`-style config-tree command already exists for
  it.
- **The same "editing repo source doesn't redeploy an already-built
  artifact" class of bug above also applies to `kamailio-source-build.ts`'s
  own patching step — fixing the build SCRIPT doesn't retroactively patch a
  module that was already compiled by an older version of it.** Found live
  2026-09-30: the `==STEP:patching==` block (applies `CMD_C_PATCH_KAMAILIO6`/
  `SAVE_C_PATCH`/`CCR_C_PATCH`/`IMS_RO_C_PATCH` to a fresh Kamailio 6.0.8
  clone) was added to the script mid-session, but the host's actually-
  deployed `ims_charging.so` had been built by an earlier run that predated
  that addition — 100% stock, zero patches. This silently broke Ro/Gy
  charging (`cdp: Sending CCR with no/incorrect accounting record type AVP`
  → immediate CCR failure), which blocked **every single IMS call setup on
  both 4G and 5G** for about 24 hours, since the Ro CCR-Initial fires before
  S-CSCF routes the INVITE onward. Zero effect on registration (which is why
  it looked like "IMS is broken" with no obvious single cause) — only calls.
  A prior same-session *targeted* fix (a surgical `make modules
  modules="src/modules/ims_ipsec_pcscf"` rebuild of just the 2 P-CSCF
  modules) was real and correct for THOSE modules, but got misremembered/
  summarized afterward as "all 4 patches now live" without independently
  re-verifying `ims_charging` — don't let a partial rebuild's success imply
  a sibling module sharing the same patch step is also current. Detection
  signature: compare the deployed `.so`'s checksum/mtime against the
  snapshot taken at the START of the most recent *full* rebuild
  (`/etc/open5gs-nms/kamailio-source-build-snapshots/<ts>/modules-dir/`) —
  if they match, it predates that rebuild. A `kamailio -V`-style version
  string ending `-dirty` (vs. a clean tag) is a cheap signal a patch was
  actually applied to the source tree that produced the running binary.
  Fix: re-run the FULL `/api/kamailio/source-build/start` pipeline (not a
  single-module `make modules` shortcut), then verify with a real test call
  (e.g. via the IMS Test Number feature or a direct `asterisk -rx "channel
  originate PJSIP/<imsi>@scscf_trunk application Echo"`), not just a clean
  build log. Full writeup: memory `kamailio_6_source_build_progress.md`
  (its own "all 4 patches live" claim was the thing that turned out wrong —
  read the correction at the end of that file, not just the top).
  **Recurred a 4th time, confirmed live 2026-10-02/03, same underlying
  mechanism, different module**: the live-deployed `cdp.so` (shared by
  P/I/S-CSCF) predated `CDP_COMMON_C_PATCH`/`CDP_ACCTSM_C_PATCH` being added
  to the pipeline — both patches ARE correctly wired into
  `kamailio-source-build.ts` (confirmed by reading the script directly, not
  assumed), this was purely a stale-deployed-artifact problem, same as the
  3rd recurrence above. Real, confirmed-live impact: `ims_charging.so` (ccr.c/
  ims_ro.c) had ALREADY been correctly patched to stop sending
  Accounting-Record-Type (a Diameter Base Accounting AVP that has no defined
  slot in Credit-Control and that OCS's own strict dictionary rejects) — but
  `cdp.so`'s own `cc_acc_client_stateful_sm_process()` had NOT been given its
  matching patch to tolerate that AVP's resulting absence, so it fell through
  to the exact same `Sending CCR with no/incorrect accounting record type AVP`
  error on literally every call. A mismatched *pair* of patches (one side
  applied, the other not) produces an identical-looking failure to "nothing
  patched at all" — checking only one module in the pair is not enough.
  Fixed via the same targeted `make modules modules="src/modules/cdp"`
  rebuild + swap. **Found a real, separate, higher-severity bug fixing
  this live**: swapping the rebuilt `cdp.so` into place with a plain
  `cp` (overwriting the existing file's content in-place) while ~100+ live
  Kamailio worker processes already had that exact file memory-mapped
  **corrupted their in-memory code and crashed all 3 processes with
  `SIGILL`** almost immediately — a worker page-faulting into a not-yet-
  rewritten part of the file mid-copy reads a mix of old and new bytes and
  executes it as garbage. The automated `kamailio-source-build.ts` pipeline
  is NOT vulnerable to this (confirmed by reading it: it explicitly
  `systemctl stop`s all 4 Kamailio services BEFORE `make install` copies
  anything, so nothing is ever mapped during the write) — this is
  specifically a risk for the **manual, targeted single-module
  `make modules` + hand-swap** shortcut this project's own history uses
  repeatedly for a fast, non-disruptive fix (see the 2026-09-30 "surgical
  rebuild" mention above, and `kamailio_6_source_build_progress.md`'s whole
  history of this technique). **Fix/rule for any future manual `.so` swap
  while the owning service(s) are still running: never `cp` over the live
  path directly — copy the new file to a temp name in the SAME directory,
  then `mv`/rename it into place.** A rename swaps the directory entry
  atomically; any process with the old inode already open/mapped keeps
  seeing fully-consistent old bytes until it actually restarts, and nothing
  can ever observe a half-written file. Confirmed live: the identical fix,
  redeployed via rename instead of `cp`, caused zero disruption to the
  already-running processes. Full writeup: memory
  `kamailio_6_source_build_progress.md`.
- **Restarting `kamailio-pcscf` for ANY reason — even just to deploy an
  unrelated `.cfg`/module change — wipes every currently-registered UE's
  real IPsec SA, and this is invisible unless you specifically check for
  it.** Confirmed live repeatedly in one session, 2026-10-02/03: the
  registrar (`ulpcscf.status`) keeps showing AoRs as "registered" with a
  normal-looking `Expires` countdown even with **zero** matching entries in
  `ip xfrm state` — the SIP registration-state table and the kernel IPsec
  SA table are two entirely independent subsystems that can desync, and the
  registrar side gives no indication anything is wrong. A call touching an
  affected UE doesn't fail cleanly — it manifests as a real, several-second
  delay (Kamailio trying and failing to actually deliver the request over
  the dead tunnel) before a local error, which can look exactly like a
  network/radio-layer problem if you don't check `ip xfrm state` directly.
  The only fix is the affected device re-registering for real (toggle
  Airplane Mode, or a full restart) — there is no server-side remediation.
  If you restart `kamailio-pcscf` more than once in a debugging session,
  re-check (or have the operator re-toggle) EVERY device involved in the
  next test, not just the one you most recently fixed something for.
- **Manually deploying a static IMS Kamailio template file (copying straight
  from the built `dist/config/ims-templates/...` tree to its real host path,
  bypassing `deployImsTemplate()`) skips that function's own
  `__TOKEN__`-style substitutions, silently leaving the literal placeholder
  text live in production.** Confirmed live 2026-10-02: manually
  redeploying `kamailio_pcscf.cfg` this way left
  `rtpengine_sock="1 == udp:__RTPENGINE_IP__:2223"` completely unsubstituted
  — `__RTPENGINE_IP__` isn't a real hostname, so every single call's RTP
  handling failed immediately (`build_rtpp_socks(): Name or service not
  known` → `no available proxies`), a real, total outage for the RTP/NAT
  side of every call, 4G and 5G alike, until caught and fixed. `mo.cfg`/
  `mt.cfg` happen to have no such tokens so this specific case was silent
  on those two files, but any manual redeploy of a template using
  `deployImsTemplate()`'s substitution feature needs the same substitutions
  applied by hand, or needs to go through the real install/configure flow
  instead. Grep the freshly-deployed file for `__[A-Z_]*__` as a cheap,
  reliable check before trusting a manual redeploy.
- **A single-FILE Docker bind mount pins to the file's inode, so rewriting that
  file on the host does not reach the container — and `nginx -t` will happily
  report "syntax is ok" for config the running nginx is not using.** Confirmed
  live 2026-10-13: `nginx/nginx.conf` is bind-mounted as
  `/etc/nginx/conf.d/nms.conf`, and the ATOM rollback had rewritten that file
  (new inode, 67563394 on the host vs 67954293 still mounted in the container).
  The container therefore kept serving the **pre-rollback** config for hours,
  complete with `location ~ ^/api/atom/dataset/`, `^/api/atom/engine/` and
  `|atom` in the streaming-install regex, all proxying to an engine that no
  longer existed. Nothing requested those paths so nothing broke, which is
  exactly why it went unnoticed — and the rollback had been reported as
  complete on the strength of the repo and the systemd unit alone. Worse, a
  newly-added location block simply never took effect, and `nginx -s reload`
  cannot fix it: reload re-reads the same stale inode.
  **Detection**: compare inodes across the boundary, not contents —
  `stat -c %i nginx/nginx.conf` against
  `docker compose exec nginx stat -c %i /etc/nginx/conf.d/nms.conf`. A
  size/mtime mismatch is the same signal (the live copy here was 14171 bytes
  against the repo's 13276).
  **Fix**: `docker compose up -d --force-recreate nginx`, which re-binds to the
  current inode. **Prevention**: an in-place rewrite that preserves the inode
  (`sed -i` without `--follow-symlinks` does NOT — it writes a temp file and
  renames; Python `open(p,'w')` truncating in place DOES) keeps the mount
  valid, but the reliable habit is to recreate the container after editing any
  single-file bind mount rather than trusting that the edit propagated. Mounting
  the parent DIRECTORY instead of the file avoids the whole class of problem,
  since directory mounts resolve names per lookup rather than pinning an inode.
  This applies to every single-file mount in `docker-compose.yml`, not just
  nginx's.

- **A diagnostic feature must not make "load a Kamailio module" the
  operator's problem — Kamailio only loads modules at startup, so an
  on-demand load means restarting a CSCF, and restarting `kamailio-pcscf`
  drops every registered UE's IPsec SA.** The SIP capture feature
  (Packet Capture page's SIP Tracing tab) originally defined
  `CAPTURE_NODE` only while capture was switched on, which made the first
  enable restart all three CSCFs — i.e. looking at a call flow cost a real
  registration outage for every handset on the network, which no operator
  will accept, so in practice the feature was unusable. Fixed 2026-10-13:
  `captureNodeDefine()` in `ims-controller.ts` now emits `CAPTURE_NODE`
  **unconditionally**, so `siptrace.so` is resident on every CSCF from the
  first Configure onward, and a separate `CAPTURE_TRACE_ON` define (which
  the three `kamailio_*.cfg` templates turn into `trace_on 1|0`) carries
  the actual on/off state. Starting loaded-but-off is cheap,
  verified in siptrace's own source rather than assumed: `sip_trace()`
  returns immediately on a clear `trace_on_flag`, and with
  `trace_to_database 0` the module never binds a database module at all
  (which matters on this host — see the `max_connections` entry below).
  **Correction, same day — an earlier version of this entry said "genuinely
  free", which overclaimed.** Transaction-mode tracing (next entry) calls
  `trace_transaction()` BEFORE the `trace_is_off()` check, so while capture is
  switched off each request still costs one small shm allocation and three tm
  callback registrations. The callbacks and `sip_trace()` both short-circuit
  on the trace_on flag, so nothing is emitted, no socket is written and no
  database is touched — but it is not nothing. That cost is inherent to
  capturing replies at all: any mode that can see a response has to register
  for it before the response exists. If it ever matters on a busier
  deployment, the lever is to gate the trace call on a shared, RPC-settable
  variable (`$shv(...)` + `pv.shvSet`), NOT to go back to message mode, which
  cannot see replies at all.
  Toggling is then purely `siptrace.status on|off` over `kamcmd`, in both
  directions, and the persisted define means the choice survives any later
  restart. `setSipTracingEnabled()` contains no `systemctl` at all and
  `SIP_TRACE_INSTANCES` deliberately no longer carries unit names; an
  instance whose live config predates this reports `not-loaded` +
  `needsConfigure` and the UI points at Configure rather than restarting
  anything itself. A wiring test pins all of this
  (`sip-trace-wiring.test.ts`). **The general rule: if a feature needs a
  Kamailio module that isn't loaded, add it to the Configure-time config
  so the cost lands in the restart Configure already performs — never
  restart a CSCF as a side effect of someone opening a diagnostic view.**
  Nested `#!ifdef`/`#!else` inside an outer `#!ifdef` is supported by
  Kamailio's preprocessor (verified against the real 6.0.8 binary), which
  is what lets the template choose a `trace_on` value without the
  generated include having to supply one.

- **Kamailio's `siptrace` module emits HEP version **1** by default, not
  v3 — and a HEP collector that requires the `HEP3` magic silently counts
  every real message as a parse failure while the UI reports capture as
  running.** Found live 2026-10-13, immediately after the first IMS Configure
  that loaded `siptrace.so`: all three CSCFs reported `siptrace.status` as
  `Enabled`, HEP datagrams were confirmed arriving at the collector with
  tcpdump, and `nms_sip_trace` stayed at zero documents. Root cause read from
  the real source, not guessed — `siptrace.c` declares `int hep_version = 1`
  and the module's own README says "Default value is 1"; v1/v2 route to
  `trace_send_hep2_duplicate()`, a fixed-layout binary header with no `HEP3`
  magic, so `hep-parser.ts`'s `parseHep3()` rejected all of it as `bad_magic`.
  Invisible because the collector deliberately counts parse failures rather
  than logging them (correct — a misdirected sender would otherwise flood the
  log), so the only symptom was an empty capture. **Detection signature**: HEP
  packets visible on the collector port via tcpdump while `messagesStored`
  stays 0; dump the first four payload bytes (`tcpdump -X`) — `01 10 02 11`
  is a v1 IPv4/UDP header, `HEP3` is v3. **Fixed in the collector, not the
  templates, deliberately**: `hep_version` is a modparam, so it must follow
  its own `loadmodule` and cannot live in the generated include — setting it
  would mean editing the three static `kamailio_*.cfg` templates, which only
  reach the host through a full Configure, i.e. another CSCF restart and
  another dropped IPsec SA for every handset. `hep-parser.ts` now has
  `parseHep1or2()` plus a `parseHep()` dispatcher that switches on the magic,
  and the collector calls that; v1 loses nothing this project uses (its only
  absent fields are the payload-type and capture-agent ids — capture is SIP
  by construction here, and the three CSCFs are told apart by which collector
  PORT received the packet, per `CAPTURE_PORTS`, never by a capture id). Two
  real layout traps are handled and pinned by tests: v2's time header is
  **little-endian** while every other HEP field is big-endian (`to_le()` is a
  no-op on x86), and `sizeof(struct hep_timehdr)` rounds 10 bytes of fields
  up to 12, so two zero padding bytes are on the wire — skipped by ignoring
  leading NULs rather than by guessing the sender's compiler. A CSCF that
  later gains `hep_version 3` keeps working with no collector change. The
  regression test pins the exact 16 header bytes a live I-CSCF put on the
  wire. **General rule: when a capture/telemetry feature stores nothing,
  confirm the format on the wire before trusting the sender's documented
  default — and prefer widening our own parser over changing a config that
  costs a restart to deploy.**

- **`siptrace`'s default tracing mode is "message", so a bare `sip_trace()`
  mirrors the one message in hand and NOT a single reply — and which mode you
  get silently depends on the ORDER of two lines in the config.** Found live
  2026-10-13 on the first real call captured after the HEP fix above: 33
  messages stored, every one of them a request (INVITE/PRACK/ACK/BYE/CANCEL),
  zero `100`/`180`/`200` anywhere. A capture with no responses is not a call
  flow at all, and it presents as a *working* feature because messages are
  being stored and counted. Mechanism, from `siptrace.c` rather than guessed:
  `sip_trace()` with no mode argument resolves the mode as
  `(msg->flags & trace_flag) ? SIPTRACE_TRANSACTION : SIPTRACE_MESSAGE`, and
  only TRANSACTION/DIALOG call `trace_transaction()`, which is what registers
  the `TMCB_REQUEST_SENT`/`TMCB_RESPONSE_IN`/`TMCB_RESPONSE_SENT` callbacks
  that capture onward hops and replies. The three CSCF templates called
  `sip_trace();` and only *then* `setflag(FLT_CAPTURE);` — so at the moment of
  the call the flag was not yet set, message mode was chosen, and the
  configured `trace_flag` modparam had no effect whatsoever. **Fixed** by
  using the explicit `sip_trace_mode("t")` (exported with 1 param, ANY_ROUTE —
  verified present in the deployed `.so`) with `setflag` ahead of it, so the
  behaviour no longer depends on line order at all. Pinned by
  `sip-trace-wiring.test.ts`, which now rejects a bare `sip_trace()` in any of
  the three templates. Dialog mode (`"d"`) is deliberately NOT used: it needs
  the `dialog` module, which this deployment does not load (same constraint
  that kept `acc`'s `cdr_enable` out — see the Call History entry).
  **This is a config-logic change, so unlike the on/off toggle it only reaches
  the host through a Configure and its CSCF restart.** **General rule: when a
  capture looks thin rather than empty, check what the tap was asked to
  capture before suspecting the transport — and prefer a library's explicit
  mode argument over its flag-dependent default, because the default's
  behaviour can hinge on statement order that reads as irrelevant.**

- **A network-initiated SIP keepalive every 5s holds every registered UE
  permanently out of RRC idle — a real, operator-visible cost that was never
  weighed against the bug the keepalive was added to fix.** Reported from the
  RAN side 2026-10-13: a handset "staying active all day". Cause confirmed
  live, not guessed: `route[NATPING]` in `kamailio_pcscf.cfg`, driven by
  `modparam("rtimer", "timer", "name=NATPING;interval=5;...")`, fires a
  `uac_req_send()` OPTIONS at **every registered contact every 5 seconds** —
  measured on this host at 3 contacts / 36 pings per minute. 5s is shorter
  than any RRC inactivity timer, so no UE can ever reach idle: battery and
  radio resources burned for every subscriber, continuously. The keepalive
  itself is NOT the mistake — it exists because of the 2026-09-29 fix
  documented in `pcscfIncludeCfg()` (the natping htables were populated at
  REGISTER but `route[NATPING]` was gated behind an undefined `WITH_NATPING`,
  so idle TCP contacts went stale before their registration `Expires` and the
  next INVITE failed on a ~3s connect timeout). The mistake was the hardcoded
  *rate*, chosen to sit safely under an unknown TCP idle timeout rather than
  measured against one. **Fixed** by making it a setting: the template now
  carries `interval=__NATPING_INTERVAL__`, the NMS default is **30s**
  (range 5–300, with 5 kept reachable so the previous behaviour is one step
  away), and the IMS page exposes it. Applying it necessarily restarts
  kamailio-pcscf — an rtimer interval is a modparam read once at startup, with
  no RPC — so the UI states plainly that every handset's IPsec SA is dropped
  and they must re-register; that cost is why it is a considered setting and
  not a live slider. **Two traps worth knowing if you touch this again**:
  (1) the P-CSCF template now bears TWO tokens, and `RTPENGINE_IP` had been
  handled by three separate hardcoded checks (token list, deploy loop,
  staleness renderer) — now one shared `imsTemplateSubstitutions()`, because
  missing the new token in the DEPLOY path fails loudly via
  `deployImsTemplate()`'s leftover-token guard, but missing it in
  `checkImsTemplateStaleness()` is SILENT and makes every deployment report
  permanently stale forever; (2) the setter redeploys the whole template
  through `deployImsTemplate()` rather than patching the one line, because
  this is the same file whose hand-rolled redeploy once left
  `__RTPENGINE_IP__` literal and broke RTP on every call. Pinned by
  `ims-natping-wiring.test.ts`, which rejects a hardcoded NATPING interval
  outright. **General rule: a periodic network-initiated poll aimed at UEs is
  a RAN power decision as much as a SIP one — pick the interval against the
  idle timer you are actually fighting, and make it configurable rather than
  guessing a safe-looking constant.**

- **This host's MySQL/MariaDB `max_connections` (151, the compiled-in
  default) was genuinely too low for this deployment's own steady-state
  load** — confirmed live 2026-10-02 (`Max_used_connections` peaked at
  exactly 152, one over the cap) when a `kamailio-pcscf` restart's own
  startup connection burst, on top of what S/I-CSCF, SMSC, and PyHSS
  already hold open, tipped it over and took the whole service down
  (one `ims_usrloc_pcscf` worker's DB connect failing with "Too many
  connections" aborts the entire Kamailio startup, not just that one
  worker). Raised to 300 and persisted in
  `/etc/mysql/mariadb.conf.d/50-server.cnf` (`max_connections = 300`,
  with a comment explaining why) — if this project adds more DB-backed
  services, watch `Threads_connected` vs this ceiling again.

## User / workflow conventions

- **Never include `Co-Authored-By: Claude` (or any AI attribution) in git commits.**
  User has explicitly said this multiple times.
- **Always rebuild AND restart the frontend container after any frontend file
  change** — `docker compose build frontend && docker compose up -d frontend`. Vite
  builds are static; source changes do nothing until rebuilt. Same for backend.
- **Never factory-reset, wipe, or perform any other destructive action on a radio or
  device without explicit confirmation first** — this destroys all device config and
  requires full re-provisioning. Stop and ask before queuing anything like this.
- **UI layout convention (standard as of 2026-08-16 — apply to every new page)**:
  outer wrapper `p-6 space-y-6`; header is `flex items-center justify-between
  flex-wrap gap-3` with a title (`h1.text-2xl.font-semibold.font-display`) +
  subtitle (`p.text-sm.text-nms-text-dim.mt-1`) block on the left, and — for any
  page that owns a module lifecycle (install/configure/start/stop/restart) —
  status badges + action buttons on the right (never buried in a body card).
  When a page has more than one logical section, use a **centered pill-style
  tab bar**: `flex justify-center` wrapping `flex gap-1 p-1 bg-nms-surface-2
  rounded-lg border border-nms-border`, each tab `flex items-center gap-2 px-4
  py-2 rounded-md text-sm font-medium transition-all` with an icon, active
  `bg-nms-accent text-nms-accent-fg shadow-sm` / inactive `text-nms-text-dim
  hover:text-nms-text hover:bg-nms-surface` (**`text-nms-accent-fg`, never
  `text-white`** — see the theme-token rule below) — not the older left-aligned
  underline-tab style. Full-width cards throughout (no `max-w`/centering
  wrappers on card content itself). Reference implementations: `AutoConfigPage.
  tsx`, `SecGWPage.tsx`, `VoWiFiPage.tsx`, `IMSPage.tsx`, `PstnGatewayPage.tsx`,
  `FRRPage.tsx`, `SASPage.tsx`, `MetricsPage.tsx`. Gotcha: gate header
  service-control visibility on "is this module installed" (`installedOnDisk`/
  `installed`), never on "is it fully configured" — a real bug (VoWiFi's Start/
  Stop/Restart buttons vanishing while the service was actively running,
  because they were gated on `configured` instead) came from getting this
  wrong. Full rationale and a per-page shape breakdown: PROJECT_STATE.md's
  Engineering Decision Log, "centered pill-style tab nav + header-mounted
  service control" entry.
- **Theme tokens and accessibility baseline (standard as of 2026-10-12 — every
  new page, panel, modal and control).** The frontend was audited and fixed
  against WCAG 2.2 AA in one pass; the whole point of that pass is lost if new
  UI reintroduces what it removed. Concretely, for anything new:
  - **Never `text-white` on a themed background.** Use `text-nms-accent-fg` on
    `bg-nms-accent` (primary buttons, active tabs) and `bg-nms-red-strong` for a
    solid red fill that carries white text. White on `nms-accent` measures
    2.15:1 (amber theme) to 4.23:1 (violet) — it fails AA in **all five** themes
    and fails even the 3:1 large-text floor in three of them. `index.css`'s
    header comment carries the measured numbers.
  - **Never hardcode a hex colour in a component.** There are five themes
    swapped at runtime via CSS custom properties; a literal hex pins that
    element to whichever theme it was eyeballed against. (Real example: the
    `Toaster` in `App.tsx` had Cyan Slate's palette inlined, so toasts stayed
    blue-grey on every theme.) Use the `nms-*` Tailwind tokens.
  - **`border-nms-border-strong` for interactive boundaries** (input, select,
    textarea, checkbox), which WCAG 1.4.11 holds to 3:1. Plain `nms-border` is
    1.32–1.53:1 against the page — correct for a decorative card edge or
    divider (those are exempt), wrong for the edge of a control.
  - **Every icon-only button needs an `aria-label`**, and a destructive one must
    name what it acts on ("Remove network slice", not "Remove"). A state toggle
    should describe what pressing it will *do*
    (`aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}`).
  - **Every form control needs an accessible name.** A visible `<label>` that is
    merely adjacent does not give the control one — associate it with
    `htmlFor`/`id`, wrap the control in the label, or put an `aria-label` on the
    control matching the visible text. A wrapper component whose caller renders
    the `<label>` (`PasswordInput`, `DnnSelect`) must accept a name prop and
    forward it, because the caller's label cannot reach inside.
  - **Don't remove focus outlines.** `index.css` has one zero-specificity
    `:focus-visible` rule covering every interactive element; `focus:outline-none`
    is only acceptable alongside a `focus:ring-*` replacement (which is what
    `.nms-input` does).
  - **A new overlay/modal closes on Escape.** Use `useEscapeKey(onClose)` from
    `hooks/useKeyboardA11y.ts`. A backdrop that closes on click has no keyboard
    equivalent, and giving the backdrop a tab stop is worse than the gap.
    (`StaleModulesModal` is the one deliberate exception — non-dismissible by
    design while auto-fixable staleness remains.)
  - **A clickable non-button** (`div`/`tr` with `onClick`) needs
    `tabIndex={0}` + `onKeyDown={activateOnKey(fn)}` (same module) plus
    `role="button"`, or for a table row, the `tabIndex`/`onKeyDown` pair and
    `aria-expanded`/`-selected`/`-current` without `role="button"` — that role
    on a `<tr>` destroys the table's semantics. Never nest an interactive
    element inside another (a `<button>` inside a `<button>` is invalid HTML and
    the inner one is keyboard-unreachable).
  - **Wrap any table that can outgrow its column in `.nms-table-scroll`.** The
    old idiom, a bare table inside `rounded-lg overflow-hidden`, *clips* the
    overflow and leaves those columns permanently unreachable.
  - **Body copy and field labels stay at `text-xs` (12px) or larger.** Badges,
    inline markers, `<pre>` log output and table cells may go smaller — that
    density is deliberate and WCAG sets no minimum font size — but explanatory
    `<p>` help text must not.
  - **New motion must survive `prefers-reduced-motion`.** There is a global
    reduce block in `index.css`; anything with its own keyframes should be
    checked against it (spinners there slow rather than freeze, because a
    motionless spinner during a real multi-minute install reads as a hung UI).
  - **A new page is lazily imported in `App.tsx`** (`lazy(() => import(...)
    .then(m => ({ default: m.X })))`), not statically. Static imports are what
    produced a single 2.9 MB initial bundle; route splitting cut first load from
    ~821 kB to ~111 kB gzip, and one new static page import silently gives a
    chunk of that back.
- **Only commit when explicitly asked.** This project has gone through periods of
  large uncommitted work by design (user wanted a clean-host test before committing) —
  don't assume "the fix works" means "commit it."
- **Verify, don't trust "success."** A use-case returning `{success: true}` doesn't
  mean every sub-step actually worked (seen with `applyPhaseC` reporting success while
  one of 11 NF restarts had actually crashed) — always independently check
  `systemctl is-active`/`journalctl` after any apply/restart/migrate action before
  reporting it as done.

## Where to look for more detail

- `docs/features.md` — full feature descriptions.
- `docs/troubleshooting.md` — diagnostic playbooks, including the DNS/BIND9 NF
  crash-loop one.
- `docs/frr-eigrpd-crash-guard-patch.md` — the FRR patch, full writeup.
- `docs/api-reference.md` — REST API reference, GenieACS NBI patterns.
- `docs/requirements.md` — system/software prerequisites, port table.
- `CHANGELOG.md` — dated, detailed entries for everything shipped.
- `INSTALL.md` — fresh-install walkthrough.
