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
   targeted-upsert functions (`readForwarders`/`writeForwarders`,
   `readListenOn`/`writeListenOn`, both exported) that other modules import and merge
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
    commented-out line). `pcscfDiameterXml()` deliberately has NO `<Peer>` element for
    PCRF (accept-only — P-CSCF and PCRF both trying to actively connect to each other
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

## Feature inventory (as of v2.0-beta_0.29, 2026-07-28)

| Feature | Status | Key backend files | Key frontend files |
|---|---|---|---|
| Core 17 NF config | stable | `yaml-config-repository.ts`, `apply-config.ts`, `config-controller.ts` | `ConfigPage.tsx` + `editors/*.tsx` |
| SEPP (N32 roaming) | stable | `sepp-controller.ts`, `sepp-config.ts` | `SeppEditor.tsx` |
| Framed Routing | stable | `subscriber-management.ts`, `ip-utils.ts` | `SubscriberPage.tsx` |
| DNS/FQDN Migration Wizard | stable, actively used | `dns-migration-usecase.ts`, `dns-migration-controller.ts`, `bind-controller.ts` | `DnsMigrationPage.tsx`, `BindPage.tsx` |
| IMS / VoLTE (PyHSS-based) | beta — real UE-to-UE calling with full audio confirmed working end-to-end over **direct IMS** on real iPhone hardware, PLMN 001-01 (2026-07-26), incl. dedicated QCI=1 bearers via the P-CSCF↔PCRF Rx interface. **iPhone-only** — Android as callee (both direct IMS and via PSTN Gateway) currently fails; root cause not yet found (2026-07-29) | `ims-controller.ts` | `IMSPage.tsx` |
| SMS | stable — **SMS over IMS is the default/primary path** (real phones prefer it whenever IMS-registered anyway; this is also the confirmed-working baseline). SMS over SGs (osmo-\*) is available as an opt-in, experimental alternative via a "SMS Delivery Mode" toggle on the SMS/MMS page (`POST /api/ims/sms-delivery-mode`) — selecting it hard-blocks SIP MESSAGE at S-CSCF (`#!ifdef BLOCK_IMS_SMS` in `kamailio_scscf.cfg`) so it can't silently fall through to peer-to-peer IMS delivery instead. Real two-UE SGs delivery has an open, unresolved bug (P-CSCF `ims_ipsec_pcscf` failing to relay a locally-generated reply back through the IPsec tunnel — see memory: sms-over-ims-vs-sgs-delivery-mode) — don't enable SGs mode without reading that first. Both `sms-controller.ts` and `ims-controller.ts` are involved; `configureIms()`/`/status` both default fresh deployments to `'ims'`. | `sms-controller.ts`, `ims-controller.ts` | `SMSPage.tsx` |
| MMS (VectorCore MMSC) | beta — real end-to-end MMS confirmed working on a real UE (2026-07-30), after fixing two real bugs: VectorCore logs its whole MM1 request path at Debug while shipping configured at Info (looked exactly like requests weren't reaching the app at all — set to `debug`), and real phones send MMS PDUs with no usable `From` field, which VectorCore expects a GGSN/PGW-style `X-MSISDN` HTTP header to supply. Fixed with a small compiled-Go reverse proxy (`mm1-msisdn-proxy.go`, its own `vectorcore-mm1-proxy` systemd unit, built during every Configure from the same already-guaranteed Go toolchain — deliberately not Node, which isn't a documented prerequisite anywhere in this project) sitting in front of VectorCore's real public `:8002`, resolving sender MSISDN from the UE's Framed-Routing IP and injecting the header — see memory: `mms-mm1-msisdn-header-injection-fix`. `ENABLE_MMS_MODULE` defaults **disabled** (opt-in). Lives as a second tab on the SMS/MMS page, not a separate nav entry. | `mms-controller.ts` | `SMSPage.tsx` (MMS tab) |
| PSTN Gateway (Asterisk, internal-only) | **beta — no public SIP trunk yet**; signaling confirmed working end-to-end (iPhone↔iPhone via extensions), but **audio via Asterisk is not currently confirmed working** — a same-day 2026-07-28 "full-duplex audio" claim did not reproduce in same-day live testing, treat as an open regression until re-verified with a fresh capture; `ENABLE_PSTN_MODULE` defaults **disabled** (opt-in) | `pstn-controller.ts` | `PstnGatewayPage.tsx` |
| VoWiFi (ePDG) | alpha, experimental | `vowifi-controller.ts`, `vowifi-build.ts` | `VoWiFiPage.tsx` |
| eSIM generation (Simlessly API) | stable | `esim-generator.ts`, `esim-controller.ts` | `EsimGeneratorModal.tsx` |
| Subscriber Groups | stable | `subscriber-groups-controller.ts` | `SubscriberPage.tsx` (grouping UI) |
| Syslog Forwarding | stable | `syslog-controller.ts` | `SyslogForwardingModal.tsx` |
| Major Event Classification | stable | `major-event-classifier.ts` | `MajorEventsView.tsx` |
| FRR source build + crash-guard patch | stable | `frr-source-build.ts`, `frr-source-build-controller.ts` | `FrrSourceBuildTab.tsx` |
| Sercomm NR provisioning | stable | `sercomm-nr-controller.ts` | `SercommNRTab.tsx` |
| UE Validation (UERANSIM 5G + srsRAN 4G) | stable | `validation-controller.ts` | `ValidationPage.tsx` |
| CBRS SAS server | stable | `sas-service.ts`, `sas-controller.ts` | `SASPage.tsx` |
| GenieACS radio provisioning | stable | `genieacs-controller.ts` | `AutoConfigPage.tsx`, `FemtoConfigTab.tsx` |
| Traffic History (aggregate + per-subscriber) | stable | `subscriber-ip-accounting.ts`, `prometheus-metrics.ts`, `traffic-history-controller.ts` | `TrafficHistoryPage.tsx` |

Full detail on any of these: `docs/features.md`.

## Reference facts

- **PLMN**: MCC 001, MNC 01 (`5gc.mnc001.mcc001.3gppnetwork.org`,
  `epc.mnc001.mcc001.3gppnetwork.org` — the two zones the DNS Migration Wizard
  manages; migrated off the original 999-070 test PLMN, confirmed live 2026-07-29 —
  older docs/memory referencing 999/070 are stale).
- **Radio IPs** (verify before trusting — deployments change):
  - `10.0.2.100–102` — Baicells eNB(s), B48, 4G/LTE
  - `10.0.2.214` — Nokia AirScale Pico BTS, B66, 4G/LTE
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
  run by the `cert-init` Docker service): `sas.crt`/`sas.key` (any hostname) and
  `acs.crt`/`acs.key` (must be `CN=acs.sc.sercomm.com` — hardcoded in `nginx.conf`'s
  `server_name`). Missing either one means nginx fails to start entirely (it loads
  every `conf.d/` server block up front) — found on a genuinely fresh install where
  only the `sas.crt` generator existed; `acs.crt` had only ever been created manually
  on the original dev host and nobody noticed the script never made it.
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

## User / workflow conventions

- **Never include `Co-Authored-By: Claude` (or any AI attribution) in git commits.**
  User has explicitly said this multiple times.
- **Always rebuild AND restart the frontend container after any frontend file
  change** — `docker compose build frontend && docker compose up -d frontend`. Vite
  builds are static; source changes do nothing until rebuilt. Same for backend.
- **Never factory-reset, wipe, or perform any other destructive action on a radio or
  device without explicit confirmation first** — this destroys all device config and
  requires full re-provisioning. Stop and ask before queuing anything like this.
- **UI layout convention**: page title top-left, action buttons top-right, full-width
  cards (no `max-w`/centering wrappers) — follow existing pages like
  `TunInterfacePage.tsx` as the reference.
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
