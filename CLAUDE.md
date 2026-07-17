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
- **MongoDB**: subscriber data, SAS grant data.
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

## Feature inventory (as of v2.0-beta_0.13, 2026-07-17)

| Feature | Status | Key backend files | Key frontend files |
|---|---|---|---|
| Core 17 NF config | stable | `yaml-config-repository.ts`, `apply-config.ts`, `config-controller.ts` | `ConfigPage.tsx` + `editors/*.tsx` |
| SEPP (N32 roaming) | stable | `sepp-controller.ts`, `sepp-config.ts` | `SeppEditor.tsx` |
| Framed Routing | stable | `subscriber-management.ts`, `ip-utils.ts` | `SubscriberPage.tsx` |
| DNS/FQDN Migration Wizard | stable, actively used | `dns-migration-usecase.ts`, `dns-migration-controller.ts`, `bind-controller.ts` | `DnsMigrationPage.tsx`, `BindPage.tsx` |
| IMS / VoLTE (PyHSS-based) | alpha | `ims-controller.ts` | `IMSPage.tsx` |
| SMS (SGs path, osmo-\*) | stable | `sms-controller.ts` | `SMSPage.tsx` |
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

Full detail on any of these: `docs/features.md`.

## Reference facts

- **PLMN**: MCC 999, MNC 070 (`5gc.mnc070.mcc999.3gppnetwork.org`,
  `epc.mnc070.mcc999.3gppnetwork.org` — the two zones the DNS Migration Wizard manages).
- **Radio IPs** (verify before trusting — deployments change):
  - `10.0.2.100–102` — Baicells eNB(s), B48, 4G/LTE
  - `10.0.2.214` — Nokia AirScale Pico BTS, B66, 4G/LTE
  - `172.16.0.222` — Sercomm SCE5164-B48 gNB, B48, 5G NR
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
