# Changelog

All notable changes to open5gs-nms are documented here.

---

## [v2.0-beta_0.19] - 2026-07-19

### Added — PLMN Migration Wizard

New Auto Config tab (`PlmnMigrationTab.tsx`) for a coordinated mass MCC/MNC
change across every layer that references the PLMN in one operation: core
NF `plmn_id` values, DNS (reusing the DNS/FQDN Migration Wizard's Phase A/B/C
logic), IMS, SMS, and VoWiFi, with a dry-run plan preview, per-phase (A–E)
apply buttons with scrollable logs, backup, and rollback. SAS/CBRS, radio
TR-069 provisioning, and subscriber records are deliberately out of scope.
`configureIms`/`configureSms`/`configureVowifi` were extracted from their
respective `/configure` HTTP routes into standalone functions so the wizard
can call each module's real configure logic in-process with an explicit
`{ ...currentConfig, mcc, mnc }` input, instead of an empty-body HTTP
self-call that would silently reset every other already-configured
parameter back to hardcoded defaults.

Verified with a full live round-trip (999/070 → 001/01 → 999/070) on the dev
host, including a 17-NF health check, the Phase E cross-service PLMN
consistency check, and both the VoLTE and VoWiFi E2E test modules passing
under the new PLMN. Four real bugs were found and fixed in the process, all
the same underlying issue in different code paths: **`yaml.load()`'s YAML 1.1
octal parsing silently corrupts leading-zero mcc/mnc/sd values** (e.g. `"070"`
becomes the number `70`) whenever a save path re-parses a raw YAML file
outside `YamlConfigRepository.loadRaw()`'s own string-preserving pass —
found in `saveRaw()`'s merge-base read, `vowifi-controller.ts`'s
`upsertSmfAaaPeer()`, and SMS's `extractExistingMapEntries()` (which also
left behind several corrupted duplicate `sgsap` map entries in `mme.yaml`
from repeated Configure runs before the fix). The fourth bug: Phase D's
`configureSms()`/`configureVowifi()` wrote fresh config but never restarted
their own daemons (osmo-stp/hlr/msc; vowifi-osmo-epdg/charon), so a running
`osmo-epdg` kept presenting the *old* PLMN's S6b identity until an unrelated
restart happened to pick up the change.

### Added — Subscriber IMSI editing

The Edit Subscriber form's IMSI field was unconditionally disabled outside
create mode, even though the backend's `update()` already had working (if
unreachable) conflict-detection for a renamed IMSI. Enabled the field in
edit mode; `subscriber-management.ts` now validates the new IMSI's format
when changed, cascades the rename into `nms_subscriber_groups.imsis` (group
membership is stored by raw IMSI value, not a foreign key), and returns a
warning reminding the operator to re-sync IMS/SMS afterward — both PyHSS
and OsmoHLR keep their own IMSI-keyed copy and treat a renamed IMSI as
"old deleted, new created" until their own sync-subscribers endpoint runs.

### Added — Packet Capture module

New top-level "Packet Capture" page (`ENABLE_PCAP_MODULE`, default on) for
capturing real on-the-wire traffic on any host interface, scoped by NF, 4G/5G
function type, all-GTP, or custom BPF at capture time, and decoded afterward
with Wireshark display-filter presets (5G Core, IMS/VoLTE/VoWiFi, 4G EPC,
GTP only) — including the exact filter strings requested (`gtpv2 || gtp ||
ngap || s1ap || pfcp || diameter || http2` for 5G Core, `sip || diameter ||
pfcp || gtp` for IMS). NF/port descriptors are built from live config, never
hardcoded, since `auto-config.ts` can rebind MME/AMF/UPF/SGW-U off loopback
onto real routable addresses. Captures run as transient host systemd units
(`nsenter` + `systemd-run --collect` + `dumpcap`), not bare spawned child
processes, specifically so an in-progress capture survives a backend
container restart/redeploy — proven live by restarting the backend
mid-capture and confirming it kept running and was correctly reconciled as
still-active afterward.

Clicking a packet row opens a collapsible, Wireshark-style Packet Details
tree (parsed from `tshark -T pdml`, the same format Wireshark's own "Export
Packet Dissection" uses) plus a hex/ASCII bytes pane, rather than a flat
text dump — expand any protocol layer (Frame, Ethernet II, IP, ...) down to
individual bit-level sub-fields, collapsed by default exactly like a fresh
packet selection in the real Wireshark GUI.

Interface groups (Loopback/TUN/Physical/Other) carry hover tooltips
explaining what traffic actually lands on each — `dummy-*`/`veth`
interfaces were dropped from the picker entirely after live-testing showed
real unicast traffic to a dummy-interface IP (e.g. the AMF's `dummy-amf`
address) is delivered via loopback, not the dummy device itself, which only
ever saw unrelated broadcast traffic (EIGRP hellos).

Eight real bugs were found and fixed via live testing on the dev host:
mme/hss/pcrf/sgwc/sgwu/sepp1 silently missing from the NF picker (`loadGeneric()`
has no `s1ap`/`freeDiameter` parser and sepp1's real YAML key is `sepp`, not
`sepp1`); `dumpcap` silently ignoring a single trailing `-f` filter with
multiple `-i` interfaces (must be repeated per-interface); tshark's cosmetic
"Running as root" stderr line drowning out real error messages in the UI;
`getSummary()` missing the SBI HTTP/2 decode-as hint, making genuinely
captured SBI traffic look absent from the protocol hierarchy view; Node's
default 1MB `execFile` buffer silently killing large `tshark -T fields`
decodes with no real error (now a 100MB ceiling, a latent bug affecting
every `LocalHostExecutor` caller, not just this module); an invalid BPF
filter for any NF selection touching the Diameter mesh's `127.0.0.0/8`
placeholder (`host` only accepts a single IP, needed `net` for a CIDR
range); and `fast-xml-parser` not decoding numeric HTML entities like
`&#x27;` in PDML attribute values by default.

## [v2.0-beta_0.18] - 2026-07-18

### Added — VoWiFi end-to-end test module + VoLTE test verbosity

New "Run VoWiFi Test" card on the UE Validation page, mirroring the VoLTE E2E
test but genuinely tunneled: reuses the SWu-IKEv2 emulator to establish a real
IKEv2/EAP-AKA IPsec tunnel to the configured ePDG, then runs `linphonec`
*inside that tunnel's network namespace* so SIP/RTP actually transit the
encrypted tunnel — the same path a real VoWiFi phone takes. Registers,
places a call to a plain local test subscriber, verifies bidirectional RTP,
tears down the tunnel and both test identities automatically regardless of
outcome. `swu-emulator-controller.ts`'s tunnel start/stop logic was refactored
into reusable exported functions so both the manual "Test Tunnel" UI and this
new test module share one implementation.

Also made the existing VoLTE test module's output significantly more verbose:
every step now carries a human-readable detail (what was actually created/
registered/sent), and SIP-signaling steps carry an expandable raw log
transcript in the UI, not just a pass/fail pill.

### Fixed — real bugs surfaced while live-verifying the new VoWiFi test

- `osmo-epdg`'s S6b Diameter identity was never wired up during VoWiFi
  Configure — it shipped with the stock `aaa.localdomain`/`localdomain`
  placeholders while SMF's own S6b peer config correctly expected
  `aaa.<real-plmn-realm>`. This silently broke *all* VoWiFi tunnel
  establishment (not just the new test module): Open5GS SMF misinterprets
  the resulting S6b failure and sends a phantom Gx CCR-Termination for a
  session that was never created, which PCRF correctly rejects
  (`DIAMETER_UNKNOWN_SESSION_ID`) — surfacing to the IKE client as a generic
  `AUTHENTICATION_FAILED` with no indication the real cause was a Diameter
  identity mismatch two hops away. Fixed `vowifi-controller.ts`'s Configure
  to patch osmo-epdg's `dia_s6b_origin_host`/`dia_s6b_origin_realm`/
  `dia_s6b_context_id` from the real PLMN, matching what SMF already expects.
- VoWiFi's `/start` route had the same `systemctl enable --now` no-op bug
  found earlier in BIND9/IMS's Configure flows — a no-op on an
  already-running unit, so Configure changes (like the S6b fix above)
  wouldn't take effect until something else happened to restart the
  service. Now uses `enable` + unconditional `restart`.
- The host's `/etc/resolv.conf` reverted to `8.8.8.8`/`8.8.4.4` for a third
  time this session (same class of issue as the earlier NF crash-loop
  incident), this time breaking Kamailio's own SIP domain resolution mid-test.
  The exact trigger wasn't conclusively identified (ruled out resolvconf,
  DHCP hooks, NetworkManager, and dummy-interface creation, which
  deliberately avoids triggering a networkd reload) — made the file
  immutable (`chattr +i`) as a durable safeguard pending further investigation.

## [v2.0-beta_0.17] - 2026-07-18

### Added — Automated VoLTE end-to-end test module (UE Validation)

New "Run VoLTE Test" card on the UE Validation page
(`POST /api/validation/volte/run`, streamed NDJSON progress). Provisions two
disposable PyHSS-only test subscribers, drives two `linphonec` instances through
REGISTER (both) → place call → answer → verify bidirectional RTP → hang up, and
always cleans up (deprovision subscribers, revert S-CSCF back to `HSS-Selected`
auth) regardless of outcome. Deliberately isolated to the IMS/SIP signaling layer —
no RAN/NAS/UERANSIM/srsRAN involvement, unlike the rest of this module's sessions.

### Fixed — real bugs surfaced while live-verifying the new test module

- `ims-controller.ts`'s `/configure` route used `systemctl enable --now` to bring
  up the 4 kamailio-* CSCF services, which is a no-op on an already-running unit —
  since none of them hot-reload config (cdp's Diameter Peer/DefaultRoute config is
  parsed once at startup), a *re*-Configure on a long-running host silently left a
  stale process running against newly-regenerated config files. Now uses `enable` +
  unconditional `restart` for those 4 services, matching what `/api/ims/restart`
  already did correctly.
- New test module's step-streaming helper only invoked its callback on success —
  a failing step's name/detail never reached the client, only a generic error on
  the final line. Fixed so both outcomes stream immediately.
- New test module wrote its scratch config files via the container's own `/tmp`
  instead of the host's (`/proc/1/root` prefix was missing) — `linphonec`, which
  runs inside the host's mount namespace via `nsenter -m`, couldn't find them.
- New test module hardcoded P-CSCF's address as `127.0.0.1` instead of reading the
  actual configured `pcscfIp`/`pcscfPort` from `.ims-config.json`.
- Added `restart: unless-stopped` to MongoDB's compose service
  (`mongo_docker/docker-compose-basic.yaml`) — found stopped with no auto-restart
  during this session's earlier DNS-outage triage.


## [v2.0-beta_0.16] - 2026-07-17

### Fixed — VoLTE SIP REGISTER now actually completes (real end-to-end test, `linphonec`)

Following the v2.0-beta_0.15 install/configure fixes, drove a real SIP REGISTER
through the full P-CSCF → I-CSCF → S-CSCF → PyHSS chain using `linphonec` (a
console SIP client) against a Digest-MD5 test subscriber. Found and fixed 7 more
real bugs uncovered only by an actual end-to-end auth handshake — none of these
were reachable by the install/configure smoke-testing alone:

- IMS DNS zone had no apex A record. Added one pointing at **I-CSCF**, not
  P-CSCF: P-CSCF's own `route[REGISTER]` has no explicit dispatcher target (that
  only exists under `WITH_SBC`, unused here) — its `t_relay()` falls back to
  Kamailio's own RFC 3263 resolution of the Request-URI domain, which must land
  on I-CSCF (does the Cx UAR/LIR S-CSCF lookup) or P-CSCF ends up relaying to
  itself. Also added apex SRV/NAPTR records for UEs that resolve the bare
  home-network domain directly.
- `icscfDiameterXml()`/`scscfDiameterXml()` had a `<Peer>` element but no
  `<DefaultRoute>` — confirmed against cdp's own `configparser.c`: `<Peer>` only
  drives CER/CEA connectivity, `<DefaultRoute>` is the *only* thing that
  populates cdp's outbound routing table. Without it, Diameter connections came
  up (TCP ESTABLISHED) but every UAR/MAR/SAR failed with "Empty routing table".
- `ifc_path` was never set when creating `ims_subscriber` rows. PyHSS's
  documented "falls back to the globally configured Default_iFC" behavior
  doesn't actually exist in its SAR handler — a NULL `ifc_path` crashes with
  `AttributeError: 'NoneType' object has no attribute 'split'`, silently timing
  out every registration's Server-Assignment-Request.
- PyHSS's `config.yaml` needs a `geored:` section unconditionally — one code
  path (`Update_Serving_CSCF`, called on every successful SAR) skips the safe
  `.get()` pattern used everywhere else in the codebase and does a bare
  `config['geored']['sync_actions']`, throwing `KeyError: 'geored'` without it.
- Missing `CxDataType_Rel7.xsd` (`modparam("ims_registrar_scscf", "user_data_xsd", ...)`)
  — every SAA's iFC XML failed schema validation, surfacing as a confusing
  `"500 Server error on UAR select next S-CSCF"` once no more candidate S-CSCFs
  were left to retry. Bundled the authoritative copy straight from Kamailio's
  own `ims_registrar_scscf` module source.
- The bundled iFC Jinja2 templates used bare `{{ imsi }}`/`{{ msisdn }}` —
  PyHSS actually renders with `template.render(iFC_vars=ims_subscriber_details)`,
  nesting every field under a single `iFC_vars` dict. Bare variables silently
  render as empty strings (no error), producing `<PrivateID>@</PrivateID>` and
  failing schema validation. Fixed to `{{ iFC_vars.imsi }}` etc.
- Template used `<IMSAddressOfRecord>` inside `PublicIdentity`; the real 3GPP
  Rel7 XSD (`tPublicIdentity`) requires the child element to be named
  `<Identity>` — `IMSAddressOfRecord` doesn't exist in this schema at all.

Also fixed `Default_iFC`/`Default_Sh_UserData`/per-subscriber `ifc_path` to use
paths relative to PyHSS's own Jinja2 `FileSystemLoader` (`searchpath="../"`,
resolved from its `/opt/pyhss` cwd) instead of filesystem-absolute paths, which
404 as Jinja2 template names.

With all of the above, a full REGISTER → 401 challenge → credentialed REGISTER →
200 OK round trip now completes cleanly, confirmed registered in S-CSCF's usrloc
with a proper `Service-Route` and `P-Associated-URI`.

---

## [v2.0-beta_0.15] - 2026-07-17

### Fixed — DNS/FQDN Migration Wizard: systemd-resolved bypass no longer requires a manual fix

Live end-to-end wizard run on a freshly-redeployed host (test01) surfaced that Phase A
can make BIND answer every record correctly while `getaddrinfo()` (what every NF
actually calls) still bypasses it entirely, because `/etc/resolv.conf` points at
systemd-resolved's stub — this used to require a separate, easy-to-forget manual call
to `POST /api/bind/fix-resolver` before Phase C. `dns-migration-usecase.ts` now checks
and fixes this automatically at the end of Phase A and again as a pre-flight guard at
the start of Phase C, reusing the same detection logic as the BIND page's own health
check.

### Fixed — DNS Migration Phase C's own verification was always wrong

Phase C's post-restart check (`curl` to each NF's SBI port) reported `HTTP 000` for
every NF regardless of health, because Open5GS's SBI servers are HTTP/2-cleartext
(h2c) only and expect prior-knowledge, not a plain HTTP/1.1 request — confirmed live
against a genuinely healthy NRF (000 without `--http2-prior-knowledge`, a real 400
with it). Also added a `systemctl is-active` check for all 11 SBI NFs after restart —
Phase C now actually fails if any NF crashed, instead of reporting `success:true`
regardless (the exact historical failure class already called out in this project's
conventions).

### Fixed — IMS install/configure: several real gaps that made a fresh install non-functional

A live install/configure run on a freshly-redeployed host surfaced that IMS had
effectively never worked on any host other than the original dev machine, which had
accumulated undocumented, hand-applied fixes from earlier sessions that were never
written back into the actual application code:

- The `cdp.so` process-slot patch (works around a real Kamailio bug where the CDP
  timer hits "Process limit exceeded", breaking Cx/Rx Diameter) silently failed on
  Ubuntu 24.04 — its deb-src detection false-positived on a comment inside cloud-init's
  `ubuntu.sources.curtin.orig` backup file, and it never understood the new deb822
  `ubuntu.sources` format Ubuntu 24.04 defaults to. The step's exit code also was never
  checked, so a failed patch was reported as install success. Fixed the deb-src setup
  and now warns loudly on failure.
- The ~1200-line main Kamailio routing-script configs for P/I/S-CSCF, and all 6
  systemd units (P/I/S-CSCF + PyHSS hss/api/diameter), were never written by any code
  path — they only existed because an earlier session placed them by hand on one dev
  host. Bundled as static templates (`backend/src/config/ims-templates/`, following the
  existing `config/defaults` convention) and wired into `/configure`.
- Three Kamailio modules the templates require (`presence`, `sctp`, `json`) were never
  in `/install`'s package list.
- The bundled configs need Kamailio 5.8.x — Ubuntu 24.04's own archive only has 5.7.4,
  which cannot resolve a `#!substdef` used across an `import_file` boundary that these
  configs rely on. `/install` now adds the official `deb.kamailio.org` repo before
  installing (this repo previously only existed as a hand-added file on one dev host,
  from 2026-06-20, predating this session — never in the codebase or its git history).
- `/sync-subscribers` restarts `pyhss-hss`, which now correctly cascades to restart
  `pyhss-api` too (now that `pyhss-api`'s systemd unit correctly `Requires=pyhss-hss`,
  fixing the second bullet above) — but PyHSS's own startup reliably takes ~25-30s
  (Diameter library init), while the code only waited a fixed 3 seconds, so every
  subscriber sync call hit an API that wasn't listening yet. Replaced with a real
  readiness poll (up to 45s).

---

## [v2.0-beta_0.14] - 2026-07-17

### Added — SMS over SGs uninstall

- New `POST /api/sms/uninstall` + Uninstall button on the SMS page: stops+disables
  osmo-stp/osmo-hlr/osmo-msc, removes the sgsap block from mme.yaml (restarting
  open5gs-mmed), deletes the Osmocom config files and the OsmoHLR database, and purges
  the osmo-stp/osmo-hlr/osmo-msc packages (deliberately not `sqlite3` — a generic system
  utility, not SMS-specific). Same confirmation-modal + streaming-log UX as VoWiFi's
  existing uninstall.

### Fixed — VoWiFi uninstall left the `gtp` kernel module loaded

Every previous VoWiFi uninstall left the `gtp` kernel module (and `gtp0`) active on the
host even though osmo-epdg — the only thing that ever uses it in this deployment — was
already stopped. Uninstall now runs `rmmod gtp` right after stopping services.

### Added — BIND9 self-healing (real incident found and fixed live, 2026-07-17)

While debugging a live "whole 5G core crash-looping" incident (root cause: DNS/FQDN
migration's NFs FATAL on startup if their advertise FQDN can't resolve — see
`docs/troubleshooting.md`), found and fixed the actual underlying causes, then added
permanent detection + one-click repair so this doesn't require SSH-ing in by hand again:

- **Root cause #1**: `apt purge bind9` wipes `named.conf.local`/`named.conf.options`
  back to their stock Debian package defaults on reinstall — but the zone *files* under
  `zones/` survive (the package doesn't own that directory), silently orphaning them.
- **Root cause #2**: even with BIND itself healthy, `/etc/resolv.conf` can be a
  `systemd-resolved` stub symlink (127.0.0.53) instead of pointing at BIND (127.0.0.1) —
  every NF's own `getaddrinfo()` call bypasses BIND entirely in that case, regardless of
  BIND's own health.
- **Fix**: `bind-controller.ts` now exposes `GET /api/bind/status` with three new health
  fields (`undeclaredZones`, `optionsNeedsRepair`, `resolvConfBypassesBind`), plus two
  new actions: `POST /api/bind/repair` (re-declares any orphaned zone file and
  re-asserts recursion/allow-query/forwarders/listen-on — safe to call anytime, a no-op
  if nothing's wrong) and `POST /api/bind/fix-resolver` (disables
  `systemd-resolved`'s stub listener, repoints `/etc/resolv.conf` at BIND — kept as a
  separate, explicit action from `/repair` since it changes host-wide DNS behavior, not
  just BIND's own config). The BIND page shows clear warning banners with one-click fix
  buttons only when actually needed — verified zero false positives against a real,
  healthy multi-zone BIND install, and verified both issues for real on two separate
  hosts before this fix (one via live SSH debugging, one caught proactively on the dev
  host by the same new detection logic).

---

## [v2.0-beta_0.13] - 2026-07-17

### Fixed — nginx fails to start on a fresh install

- **Real bug, found on a genuinely clean-host install**: nginx crash-looped forever
  (`cannot load certificate "/etc/nginx/certs/acs.crt"`), making the entire web UI
  unreachable. Root cause: `nginx.conf`'s port-443 vhost (the Sercomm factory-default
  ACS DNS-hijack relay, `server_name acs.sc.sercomm.com`) requires `acs.crt`/`acs.key`,
  but no script anywhere ever generated them — only `sas.crt`/`sas.key` had an
  auto-generation step (`nginx/setup-sas-cert.sh`, run by the `cert-init` Docker
  service). On existing dev hosts `acs.crt` had been created manually at some point in
  the past and just sat there, masking the gap; a fresh host never gets it.
- `nginx/setup-sas-cert.sh` now generates **both** certs — refactored into a
  `generate_cert()` helper called once for `sas` (CN=`sas.local`, any hostname) and
  once for `acs` (CN=`acs.sc.sercomm.com`, matching nginx.conf's hardcoded
  `server_name` and every factory-reset Sercomm radio's hardcoded ACS URL). Same
  skip-if-exists behavior as before, same manual-run instructions, no docker-compose.yml
  changes needed — `cert-init` already mounts and runs this exact file.

### Added — SEPP wired into Services/Logs pages

- Follow-up from SEPP shipping in v2.0-beta_0.10: SEPP is now a valid target for the
  Services page's individual Start/Stop/Restart/Enable/Disable controls and the "Start/
  Stop 5G Group" bulk action (`sepp1` added to `service-controller.ts`'s validation
  gates and `ServicesPage.tsx`'s `SERVICES_5G` group), and to the Logs page's log
  source menu (`open5gs-seppd` already logs to `/var/log/open5gs/sepp1.log` by
  convention, so this needed no backend changes). Confirmed live: SEPP was already
  showing on the Dashboard automatically (it has no hardcoded per-NF list, just
  reflects whatever the service-status feed returns) — the actual gap was only the
  Services page's per-action allowlist. Deliberately not wired into the Auto-Config
  Wizard, per explicit decision — that wizard's scope stays as-is.

---

## [v2.0-beta_0.12] - 2026-07-16

### Added — Framed Routing

- Subscriber sessions now support 3GPP Framed Routing (TS 23.501 §5.6.14) — lets a UE act
  as a gateway for an IP subnet behind it (e.g. an IoT gateway or fixed-wireless CPE with
  a LAN), routed through that UE's single PDU session. New `ipv4_framed_routes`/
  `ipv6_framed_routes` array fields per session, editable directly on the Subscriber page
  (comma-separated CIDR list), plus CSV import/export support (`framed_routes` column,
  pipe-separated, mirrors the existing MSISDN convention)
- **Static host route automation** — an "Apply static route on host" checkbox per
  session auto-manages the local `ip route` needed for the subnet to actually be
  reachable, resolving the correct `ogstun*` device from the session's DNN (not
  hardcoded) via live `upf.yaml`. Idempotent add/remove, diffed on every subscriber
  create/update/delete so routes never orphan
- **Overlap/duplicate warnings (non-blocking)** — on save, new framed routes are checked
  for exact-duplicate or CIDR-overlap conflicts against every other subscriber's framed
  routes and against the core UE pool subnets (from `upf.yaml`/`smf.yaml`), surfaced as
  toast warnings without blocking the save (an operator may be intentionally staging a
  route). IPv4 uses full numeric-range overlap math; IPv6 is exact-string-duplicate only
  (no 128-bit prefix library in this codebase yet — documented as a known limitation)
- **Framed Routes Registry** — new modal (Subscribers page → Addressing dropdown) listing
  every configured subnet across all subscribers, with owning IMSI/nickname, APN, and
  whether a static route is currently applied
- In-app guidance: the static-route checkbox's hint explains that a local route alone
  isn't enough — the rest of the network needs its own route to that subnet too, either
  via dynamic routing (e.g. an EIGRP `network` statement, not automated — FRR eigrpd has
  a documented crash-loop history, so this app deliberately never edits `frr.conf` for
  this) or a manual static route on the core/edge router pointing at **this Open5GS
  host's own IP**, never the UE's IP (the UE isn't a direct L3 hop from outside this
  host — this host is what forwards into the UE's tunnel), with a worked example
- Found and fixed a real bug while building the overlap math: the shared CIDR
  range/overlap helper (`backend/src/domain/services/ip-utils.ts`, extracted from
  previously-duplicated logic in `validation-controller.ts` and
  `swu-emulator-controller.ts`) produced a corrupted signed integer for any subnet whose
  first octet is ≥128 (e.g. `192.168.x.x`) — silently returning wrong host-pool ranges
  for IP auto-assignment too, not just the new overlap check. Fixed for both use sites

### Changed

- IMS and VoWiFi alpha warning banners now open with the same framing sentence: *"The
  goal is a 100% automated deployment — today, expect to do manual configuration beyond
  what this wizard automates."* Each banner keeps its own module-specific detail below.

---

## [v2.0-beta_0.11] - 2026-07-16

### Fixed — DNS/FQDN Migration Wizard: SEPP gap

- The DNS/FQDN migration wizard (converts hardcoded IPs to 3GPP FQDN/DNS addressing for
  every NF) didn't account for SEPP at all. Fixed two real bugs found while adding it:
  - SEPP's local SBI client (to our own SCP/NRF) was missing from the migration's service
    list entirely — added to both the DNS-zone and SBI-client phases. SEPP's N32 peer
    interface (to the *visited* PLMN's own SEPP) is correctly still excluded — that
    belongs to a different operator's infrastructure, not something local DNS resolves
  - `sepp1.yaml`'s internal YAML key is `sepp`, not `sepp1` — unlike every other NF where
    the filename matches the top-level key. The migration code was patching under the
    wrong key before this was caught and fixed with a `yamlKeyFor()` mapping helper
- **Production incident found and fixed during live testing**: `open5gs-seppd` does
  strict, synchronous DNS resolution of its own `advertise` FQDN at startup and aborts
  fatally (core-dump) if the record doesn't exist yet — unlike every other NF, which
  tolerates an unresolvable advertise value fine. Running the SBI-mesh migration phase
  for SEPP without the DNS-zone phase already reflecting its current FQDN crash-loops the
  service until the DNS phase is (re)run. Documented as a permanent operational note:
  always run the DNS-zone phase immediately before the SBI-mesh phase for SEPP, not just
  once at the start of a migration

### Fixed — Stale subscriber sync (OsmoHLR / SMS)

- SMS's `sync-subscribers` action (provisions MSISDN into OsmoHLR for CS-fallback SMS)
  only ever inserted/updated currently-eligible subscribers, with no reconciliation pass
  — a subscriber later deleted from Open5GS, or with its MSISDN cleared, stayed behind in
  OsmoHLR forever. Added a reconciliation step (mirroring the same fix already applied to
  IMS's subscriber sync) that removes OsmoHLR rows whose IMSI is no longer eligible.
  Surfaced in the UI as a "removed N stale" count alongside the existing sync result

---

## [v2.0-beta_0.10] - 2026-07-16

### Added — SEPP (Security Edge Protection Proxy)

- SEPP is now a fully configurable 17th core NF, on equal footing with the other 16 —
  its own Config tab, included in the standard bulk "Apply Config" restart flow, backed
  up with the rest. Previously the Config page had a static disclaimer that SEPP wasn't
  managed by this UI at all; that's no longer true
- **Home SEPP configuration** — SBI server/client (SCP), N32 identity (sender FQDN,
  scheme, N32-c/N32-f address+port), and an optional TLS section
- **TLS support with in-app cert generation** — a toggle switches N32 between plaintext
  HTTP and mutual TLS; when enabled, a "Generate Certs" action creates a self-signed
  keypair for the home SEPP's identity via `openssl req -x509` (the standard simplified
  trust model for a lab/test roaming setup, not a real GSMA-IPX-backed PKI), with the
  public cert displayed for copying and a paste box for the visited peer's public cert
- **"Generate Visited PLMN Config"** — a separate panel builds a complete, downloadable
  `sepp.yaml` for the visited-network operator's side, cross-referencing our
  already-configured home SEPP values and including our public cert content when TLS is
  enabled — so a real roaming partner has everything needed in one download
- Kept the existing `/etc/open5gs/sepp1.yaml`/`sepp2.yaml` filenames (matching the
  pre-existing systemd unit and the open5gs tutorial's naming) rather than migrating to a
  new name, since `open5gs-seppd` was already installed and running with TLS enabled
  using the tutorial's demo config when this feature was built
- New audit action `sepp_generate_certs`; all SEPP endpoints are admin-only

---

## [v2.0-beta_0.9] - 2026-07-16

### Fixed — FRR eigrpd crash-guard patch

- Hand-built patch on top of the from-source FRR 10.6.1 build, closing a long-standing
  upstream-unfixed bug ([FRRouting/frr#943](https://github.com/FRRouting/frr/issues/943))
  that crashed the entire `eigrpd` process — and withdrew every EIGRP-learned route,
  dropping every connected radio's S1AP/N2 association — whenever it fired. Confirmed
  recurring 3x in 3 days on this deployment (2026-07-12, then twice within 21 minutes on
  2026-07-15), triggered by events entirely outside this host's control (a dummy
  interface change, and separately a new EIGRP neighbor adjacency forming elsewhere on
  the network)
- Fix: replaces the six `assert(successors)` calls in `eigrpd/eigrp_fsm.c` that abort
  the process on a real, reachable (not corrupted) topology-table state with a graceful
  log-and-skip guard — DUAL re-evaluates the affected prefix on the next cycle instead
  of the whole daemon dying. Does not fix the true root cause (a maintainer-acknowledged
  FIFO/FILO ordering issue in EIGRP's DUAL FSM, never fully resolved upstream since
  2017) — only stops it from taking down routing entirely
- Verified stable for 12+ hours post-deploy with zero crashes, versus 3 crashes in the
  prior 3 days
- Full writeup, code, and reapplication steps: **[docs/frr-eigrpd-crash-guard-patch.md](docs/frr-eigrpd-crash-guard-patch.md)**, patch file at `docs/patches/frr-eigrpd-crash-guard.patch`

## [v2.0-beta_0.8] - 2026-07-16

### Added — eSIM Generator (Simlessly API)

- New "Generate eSIM" action on the Subscribers page — per-row (pre-fills from that
  subscriber's IMSI/K/OPc/MSISDN/ICCID) and a page-level toolbar button (blank entry,
  with an inline subscriber picker)
- Builds and sends a real, signed request to the [Simlessly](https://docs.simlessly.com)
  RSP platform's Single Generate AC API (`POST /api/v2/ac/generate`), returning a real
  activation code and, optionally, an AC link rendered as a scannable QR image
- Core fields (ICCID, IMSI, KI, Config Name) always visible; the rest of Simlessly's
  optional field set (OPC, MSISDN, PLMN lists, IMS params, PIN/PUK/ADM1, SMSP) lives
  behind a collapsed "Advanced" section
- The exact request JSON is always shown too, with copy-to-clipboard, independent of
  whether the live API is called — useful for manual use in other tools
- Requires `SIMLESSLY_ACCESS_KEY`/`SIMLESSLY_SECRET_KEY` (new env vars, obtained from
  the Developer module on your own Simlessly account) — the JSON preview works without
  them, but calling the live API does not. Admin-only action, audit logged
  (`esim_generate`) on every attempt, since it creates a real, likely billable resource
- Not yet supported: batch generation, live lookup of Simlessly profile config names,
  and full profile lifecycle management (query/delete/expire, webhook notifications)

---

## [v2.0-beta_0.7] - 2026-07-11

### Added — New Modules

**IMS / VoLTE — alpha, not production-ready**
- ⚠️ Early alpha: server-side IMS signaling has been verified with a third-party SIP client, but end-to-end VoLTE on real phones is not confirmed working and will likely require manual configuration beyond what the UI automates
- Full IMS core integration: P-CSCF/I-CSCF/S-CSCF (Kamailio 5.8.8), PyHSS Diameter HSS, BIND9 DNS, RTPEngine, MariaDB
- One-click install of Kamailio (built from source with IMS/TLS/MySQL/extra modules), MariaDB, BIND9, RTPEngine, Redis, and PyHSS (cloned from GitHub, Python deps via pip)
- Configure form wires P-CSCF into SMF (PCO + per-session DNS), writes Cx/Rx Diameter peer XML, generates the IMS DNS zone
- Subscriber sync pushes IMPI/IMPU identities into PyHSS's `ims_hss_db`
- **Known limitation:** Android's telephony framework suppresses VoLTE/SIP REGISTER on test PLMNs (MCC 999) — server-side signaling is verified with Linphone; see docs for the Early-IMS test procedure

**SMS over SGs**
- Osmocom CS-fallback SMS stack: `osmo-stp` + `osmo-hlr` + `osmo-msc`, connected to the MME via the SGs interface (SCTP)
- One-click package install, service lifecycle (start/stop/restart/enable/disable), subscriber sync (provisions MSISDN into OsmoHLR), and a raw config-file editor for all three `.cfg` files
- Requires a combined EPS/IMSI attach from the UE — no IMS/VoLTE deployment needed for basic SMS

**UE Validation**
- Spin up simulated 4G (srsRAN, built from a local Dockerfile) or 5G (UERANSIM) test UEs against your live core to validate attach, PDU session establishment, and idle-mode paging end-to-end without a physical radio
- Live log tailing, raw log download, and session persistence (survives an NMS backend restart)
- **Known limitation:** 5G idle-mode paging is unconfirmed — UERANSIM's simulated gNB may not implement an inactivity timer the way srsRAN's eNB does; 5G connected-state reachability is fully verified

**Subscriber Groups**
- Organize subscribers into named, colored groups on the Subscriber page — purely organizational (MongoDB-only), doesn't touch HSS/MME provisioning

**Sercomm 5G NR (Auto-Config)**
- New "Sercomm 5G" tab alongside the existing Open5GS/Femto/Baicells tabs — full SCE5164-B48 gNB (CU/DU split) provisioning including TDD slot configuration and SAS parameters

### Added — FRR / L3 Routing

- **Reinstall (Source) tab** — migrates FRR from the Ubuntu apt package (8.4.4, has long-standing eigrpd assertion-crash bugs — [FRRouting/frr#943](https://github.com/FRRouting/frr/issues/943), [#3701](https://github.com/FRRouting/frr/issues/3701)) to a from-source build (10.6.1+, built against libyang), with automatic backup, build, config-restore, and rollback. Fixed a real recurring production issue: `eigrpd` was crash-looping and briefly withdrawing/relearning routes on every restart, causing intermittent SCTP (S1AP/N2) drops across every connected radio
- **Log-level selector** — dropdown on the L3 Routing page for FRR's 8 syslog severities (emergencies…debugging); writes both `log syslog` and `log file` directives and reloads via `vtysh -b` (no neighbor flap)
- **FRR log file** — `frr.log` now exists (`log file` directive added to the generated config) and FRR is wired in as a 4th source on the Unified Logs page, alongside Open5GS/Docker/GenieACS
- **Nav reorganization** — TUN Interfaces and Dummy Interfaces are now sub-tabs of the L3 Routing page instead of separate top-level nav items, grouping all Layer 3 functionality together

### Added — Real-Time Logging

- **Syslog Forwarding** — forwards all Open5GS NF, GenieACS, and FRR logs to a remote syslog server (e.g. Graylog) via rsyslog. Detects/installs rsyslog if missing; writes a dedicated, fully self-owned drop-in file (never edits an existing `rsyslog.conf`); automatically fixes the two host-level gotchas that silently block this (AppArmor confinement, `frr` group read permission) via their own sanctioned override mechanisms
- **Major Events view** — new "Events" tab showing only classified, meaningful transitions (radio connect/disconnect, 4G attach/detach, 5G register/deregister, PDU session up/down) instead of raw DEBUG noise, across all 16 NF streams at once. Filterable by event type, radio, and IMSI (AND-across, OR-within). Click any event to open a zoomable log-context viewer showing the surrounding raw lines
- Log source switching now auto-selects that source's services (previously required a manual re-selection every time)

### Changed

- Web UI is now also reachable on port 80 in addition to the configurable `NGINX_PORT` (default 8888)
- New nginx HTTPS vhost (port 443, `acs.sc.sercomm.com`) relays factory-reset Sercomm radios — which hardcode this ACS URL — into the local GenieACS instance via DNS hijack, without needing to touch the radio's ACS config first
- SMS/IMS/Validation modules can now be hidden entirely at build time via `.env` flags (`ENABLE_SMS_MODULE`, `ENABLE_IMS_MODULE`, `ENABLE_VALIDATION_MODULE`) — requires a frontend rebuild to take effect
- Container timezone (`TZ`, default `America/New_York`) is now an explicit env var — several log parsers (Major Events classifier, FRR/GenieACS log streaming) depend on the container's local time matching the host's

### Known Issues / Follow-ups

- `backend/src/interfaces/rest/subscriber-groups-controller.ts`'s mutating routes are missing `requireAdmin` (every other admin-mutation route in this codebase has it) — any authenticated user, not just admins, can currently create/rename/delete subscriber groups. Low severity (doesn't touch real subscriber data) but should be fixed for consistency.
- The backend's `/var/run/docker.sock` mount changed from read-only to read-write — needs confirmation this is intentional before the next release.
- The `srsran4g/` Dockerfile (required for the 4G side of UE Validation) and a couple of other runtime-only paths were not yet committed to git as of this writing — check `git status` before relying on a fresh clone to have a working Validation module out of the box.

---

## [v2.0-beta_0.6] - 2026-06-18

### Changed

- **Nav layout** — grouped all Layer 3 functionality (Routing, TUN Interfaces, Dummy Interfaces) under a single "L3 Routing" nav item instead of separate top-level pages
- **RF status detection** — improved logic for MosoLabs/Sercomm radios

---

## [v2.0-beta_0.5] - 2026-06-13

### Changed — TUN Interfaces

- Interfaces are now persisted via systemd-networkd `.netdev`/`.network` file pairs (`/etc/systemd/network/`) instead of one-shot systemd services — they now survive a reboot
- Removed the `ogstun[0-9]+` naming restriction — any valid Linux interface name is accepted (letter-start, max 15 chars, alphanumeric/hyphen/underscore)
- `checkNetworkdActive()` specifically checks that `systemd-networkd` is active on the host
- Interface listing now uses `ip link show type tun` for accurate TUN-only detection
- Edit/Delete actions are restricted to NMS-managed interfaces only

### Fixed — SAS Spectrum Chart

- Per-group filtering bug: `getSlotLayout()` now uses `effectiveGroupId()` so manually-assigned groups (e.g. a Nokia radio manually placed in a group) are correctly included in that band's chart row
- Frontend filter logic was inverted — radios with no `groupId` were bypassing group filters and appearing in every band row instead of none

### Docs

- Added chrony and `frr`/`frr-pythontools` to INSTALL.md prerequisites

---

## [v2.0-beta_0.4] - 2026-06-04

### Security — 10 vulnerabilities fixed

- **(CRITICAL)** `/sas/admin/*` was fully unauthenticated — split into `createSasProtocolRouter` (WInnForum CBSD endpoints only, no auth needed) and `createSasAdminRouter` (all admin routes, `requireAdmin` on every mutating endpoint)
- WebSocket server is now authenticated — moved from a standalone port 3002 to `noServer:true` on the HTTP server, with the Lucia session cookie validated on the upgrade request before the socket is accepted; unauthenticated connections get HTTP 401
- `requireAdmin` added to all three femtocell routes (derive-credentials, probe, provision)
- Python code injection eliminated in the femto controller — string-interpolated `pythonRun()` calls replaced with `execFileAsync` argv calls; strict MAC/IPv4 validation added
- `requireAdmin` added to all 11 mutating GenieACS routes
- SSRF fix in `/execute-tasks` — the client-supplied `url` field was removed from the task type; the URL is now always constructed server-side
- Sensitive-data routes (`/subscribers/export`, `/backup/full/download`, `/logs/download`, `/logs/debug-bundle`) now require admin
- Zip Slip prevention in backup restore — archive members are enumerated and validated (rejects absolute paths, `..` components, symlinks, hardlinks, devices) before extraction
- Shell injection fix in log-download tar — `bash -c` replaced with `execFileAsync` argv calls; container names validated against an allowlist
- Auth route ordering fix — `/logout` and `/me` were always returning 401 because the auth router was mounted before `authMiddleware`

### Fixed — FRR / L3 Routing

- Route filters not loading on refresh (`frrApi.getState()` return shape mismatch)
- EIGRP `distribute-list` isn't supported in FRR 8.4.x — switched to zebra-level `ip protocol eigrp route-map` for inbound filtering
- FRR restart used instead of reload when applying filters (`eigrpd` was crashing on SIGHUP with `distribute-list` present — a known FRR 8.4.4 bug)
- OSPF/BGP config generators now correctly wire route filters (were generated but never applied)
- Read-only "Active Configuration" summary card shown once migration is complete, replacing the editable form
- Live Routing Status redesigned: status badge, stat pills, neighbor cards, topology table, collapsible running-config panel
- Auto VSI filter button creates/updates an outbound permit filter directly from VSI mappings

### Other

- Full backup now includes `frr.conf` and `daemons`
- "Stop 5G" no longer stops SMF/UPF (shared between 4G and 5G in Open5GS 2.7+)
- Prometheus container now runs as `65534:65534`, fixing a `queries.active` permission-denied panic on restart

---

## [v2.0-beta_0.3] - 2026-06-04

### Fixed

- **cert-init blocks nginx on fresh install** — The cert-init Docker service was failing with exit code 1 due to Docker Compose interpolating shell variables (`$SERVER_IP`, `$HOSTNAME`, `$expiry`, `$i`) in the inline entrypoint script as Compose variables (blank string). This caused nginx to never start since it `depends_on: cert-init: condition: service_completed_successfully`, making the entire web interface unreachable and preventing any user from logging in.
- **Inline script moved to `nginx/setup-sas-cert.sh`** — Mounted as a volume into the cert-init container. Docker Compose never interpolates file contents, only `docker-compose.yml` values directly.
- **Script rewritten as POSIX sh** — Was `#!/bin/bash` which is not available in the Alpine-based `alpine/openssl` container. Now `#!/bin/sh`.
- **Context detection** — Script detects whether it is running in the container (`/certs` volume mount exists) or on the host, and writes the cert to the correct location in both cases.
- **Skip logic** — Cert generation is skipped if `sas.crt` and `sas.key` already exist, preventing unnecessary regeneration on every `docker compose up`.
- **IP fallback** — Falls back to `127.0.0.1` if IP detection fails (was hardcoded to `172.16.0.168`).

### Workaround for existing broken installs

If nginx failed to start due to this issue, pre-generate the cert manually then restart:

```bash
mkdir -p nginx/certs
openssl req -x509 -newkey rsa:4096 -keyout nginx/certs/sas.key \
  -out nginx/certs/sas.crt -days 3650 -nodes \
  -subj '/CN=sas.local' -addext 'subjectAltName=DNS:localhost'
docker compose up -d
```

---


### Fixed — Critical Baicells SAS Issues

This release resolves a series of root-cause bugs that prevented Baicells BaiBLQ firmware radios from transitioning from GRANTED to AUTHORIZED state in SAS mode 2. Radios were heartbeating indefinitely in GRANTED state and never enabling RF.

**Root Cause 1 — Timestamp format (PRIMARY FIX)**
- `sasFmt()` was producing compact UTC format (`20260603T025409UTC`). Baicells firmware silently ignores this format and leaves `SAS_CONFIG_TRANSEXPIRETIME` empty, so the radio's SAS client never knows when it can transmit.
- Fixed: `sasFmt()` now produces ISO 8601 Z format (`2026-06-03T02:54:09Z`), matching the WInnForum reference SAS (`fake_sas.py`) exactly.
- This is the primary fix — all other SAS protocol behavior depends on the radio parsing this timestamp correctly.

**Root Cause 2 — REM scan blocking OAM state machine**
- Baicells radios are factory-configured with `LTE_REM_SCAN_ON_BOOT=1` scanning Band 7 (2600 MHz).
- The OAM state machine requires `remScanDone=1` before it will allow `SAS_RADIO_ENABLE` to persist. Band 7 is never found in CBRS deployments, so `remScanDone` stays 0 forever.
- Any TR-069 write of `SAS_RADIO_ENABLE=1` is treated as a "dynamic configure" and immediately reset to 0 with the message `Now Nothing To Do For Dynamic Configure`.
- Fixed: provision tasks now push `Device.Services.FAPService.1.REM.LTE.ScanOnBoot=false`, `ScanPeriodically=false`, and `InServiceHandling=Disabled`. Also must be pushed manually to existing radios before reboot via GenieACS NBI.

**Root Cause 3 — Heartbeat response too verbose**
- Our heartbeat response included `heartbeatInterval` and `operationParam` fields. The WInnForum reference SAS returns only `cbsdId`, `grantId`, `transmitExpireTime`, and `response`.
- Extra fields were causing firmware to reject or misparse the response. Removed `heartbeatInterval` and `operationParam` from heartbeat responses to exactly match reference SAS behavior.

**Root Cause 4 — NTP clock skew**
- Radio clock was offset by up to 1 hour. `transmitExpireTime` was always in the radio's past, so the SAS client disabled RF immediately after every heartbeat.
- Fixed by configuring NTP server on each radio. The Time Server page (Chrony) enables setting a network-wide NTP source.
- Added `transmitExpireTime` debug log at level 20 showing calculated interval for diagnosis.

**Root Cause 5 — SAS.RadioEnable resets to False**
- In SAS mode 2, `SAS.RadioEnable` is a volatile parameter (`mibAttributeStorageClass=0`) controlled by the radio's SAS daemon, not TR-069.
- RF On/Off endpoint now also sets `Device.DeviceInfo.SAS.RadioEnable=true` when `sasEnableMode != 0`, in addition to `X_COM_RadioEnable`.
- Post-reboot provision task also sets `SAS.RadioEnable` conditionally.
- **Only set when SAS is enabled** — deployments without SAS are not affected.

### Fixed — SAS Protocol

- **Grant keeper** — Now catches grants where `grantExpireTime` is already in the past (previously only caught near-expiry). Renews `grantExpireTime` inline when renewing a grant.
- **Heartbeat handler expired grant** — No longer returns `TERMINATED_GRANT` when `grantExpireTime` is past and the radio is still heartbeating. Instead renews the grant inline, preventing unnecessary relinquish/re-register cycles.
- **`assignChannelSlot` null check** — `groupPolicy.customSlots` stored as `null` in MongoDB (not `undefined`) caused `null.length` crash. Fixed with `Array.isArray()` guard.
- **`UNSUPPORTED_SPECTRUM` on re-registration** — Radios hitting GPS delay window after reboot now wait the full 75 seconds correctly. Added info-level logging for GPS delay countdown.
- **Deterministic slot log** — `assignChannelSlot` logs at info level now (was trace) showing all serials in sort order for debugging.

### Fixed — RF On/Off Logic

- **`rf-all` endpoint** — Was fetching all devices with `projection=_id` only, then sending `X_COM_RadioEnable` to every device including Sercomm (which uses `AdminState`). Now fetches with `projection=_id,_deviceId,Device.DeviceInfo.SAS.enableMode` and filters to Baicells only (OUI `48BF74`).
- **Per-radio RF endpoint** — Now checks `SAS.enableMode` from GenieACS before deciding what to push. If SAS is enabled, also sets `SAS.RadioEnable`. If SAS is disabled, only sets `X_COM_RadioEnable`.
- **`rf-sercomm-all`** — Confirmed Sercomm-only (OUI `000E8F`). No changes to Sercomm RF logic.
- **Double POST bug** — RF endpoint was posting the task twice (silent + connection_request). Now sends once with `connection_request` only.

### Fixed — GenieACS Provisions

- **`default` provision** — Was declaring `InternetGatewayDevice.*` paths (TR-098 schema) hourly. Baicells uses `Device.*` (TR-181) so every inform produced a `9005 Invalid Parameter Names` fault. Replaced with a no-op comment.
- **`inform` provision** — Was declaring both `InternetGatewayDevice.*` and `Device.*` ManagementServer params, causing `too_many_commits` fault loop when `PeriodicInformInterval` differed from the provisioned value. Cleaned to `Device.*` only with `PeriodicInformInterval=5` matching what the NMS provisions.
- **GenieACS faults** — `9005` faults from `InternetGatewayDevice.*` params in the default provision stopped appearing after provision cleanup. Existing faults cleared via `db.faults.deleteMany({})`.
- **REM scan provision** — Added to `buildProvisionTasks()`: `FAPService.1.REM.LTE.ScanOnBoot=false`, `ScanPeriodically=false`, `InServiceHandling=Disabled`.
- **Post-reboot task** — Now includes `SAS.RadioEnable=true` when `sasEnableMode !== '0'`.

### Fixed — Spectrum Chart

- **Baicells grants not showing** — `getSlots` TypeScript return type in `frontend/src/api/sas.ts` was missing the `bands` array, so `slots.bands` was `undefined` in the frontend. Backend was returning correct data all along. Fixed type definition.
- **Slot matching overlap threshold** — Replaced exact boundary matching (`gLow >= s.low-1 && gHigh <= s.high+1`) with center-of-mass overlap matching (≥40% overlap). Handles Sercomm CA grants that don't align to Baicells slot boundaries.
- **Cross-group grant leakage** — Slot matching now filters grants by `assignedGroupIds` before matching, preventing Baicells grants from appearing in the Sercomm band chart and vice versa.
- **Unicode escape sequences** — `\u2013` (en dash) in JSX text content was rendering as literal `\u2013`. Replaced with actual `–` characters throughout `SASPage.tsx`.
- **Header button layout** — All SAS page header buttons (Verbose, Freq Debug, Refresh, Clear DB, Pause/Resume) now on a single line using `flex items-center gap-1.5`. Shortened button labels ("Verbose ON/OFF", "▶ Resume", "⏸ Pause").

### Fixed — Baicells Radio Card

- **EARFCN display in SAS mode 2** — Was showing TR-069 `EARFCNDL` value which is the provisioned value and never updated by the SAS daemon. Now calculates EARFCN from `sasReqLowFrequency` and `sasReqHighFrequency` center point, which reflects the actual SAS-granted frequency. All three radios now show their correct distinct EARFCNs (e.g. 55340, 55540, 55740).

### Added

- **Heartbeat transmit expire debug log** — Level 20 log on every heartbeat showing `heartbeatInterval`, `transmitExpireMs`, and calculated `transmitExpireTime`. Useful for diagnosing NTP clock skew issues.
- **GRANTED state debug log** — Level 20 log when a radio heartbeats with `operationState: GRANTED` (not yet transmitting), noting that `X_COM_RadioEnable` may be False.
- **`rf-all` now logs per-radio** — Each successful RF task logs `RF set on Baicells radio` at info level with device ID, enable state, and HTTP status.

### Changed

- **`sasFmt()` format** — Changed from `20260523T211500UTC` to `2026-05-23T21:15:00Z`. **Breaking change for any SAS client that expected compact UTC format**, but Baicells firmware was already rejecting the old format silently.
- **Heartbeat response** — Removed `heartbeatInterval` from response body. Removed `operationParam`. Only `cbsdId`, `grantId`, `transmitExpireTime`, `response`, and (when `grantRenew=true`) `grantExpireTime` are returned. Matches WInnForum `fake_sas.py` reference exactly.
- **Version bumped to `2.0.0-beta_0.2`** across `backend/package.json` and `frontend/package.json`

---

## [v2.0-beta_0.1] - 2026-05-29

### Added

**📡 CBRS SAS — Multi-Band & Sercomm Integration**

- **Multi-band frequency configuration** — SAS Configuration tab now supports multiple independent frequency bands. Each band has a label, EARFCN or MHz range, and max grant bandwidth. Different radio hardware types can be assigned different bands (e.g. Baicells on 3560–3620 MHz, Sercomm on 3649–3700 MHz) without interfering with each other's slot assignments.

- **Three-level Band Assignment system** — New `sas_group_policies` and `sas_cbsd_policies` MongoDB collections. `resolveBand()` function in `SasService` applies priority: (1) per-CBSD override keyed by `fccId:serial` (survives Clear DB), (2) interference group policy keyed by `groupId`, (3) global `findMatchingBand()` fallback. Both `spectrumInquiry` and `grant` now use `resolveBand()` instead of `findMatchingBand()` directly.

- **Band Assignment tab** — New tab in the SAS page (renamed from "Band Policy" to "Band Assignment"). Three sections:
  - *Interference Groups* — shows each registered interference group with a band selector dropdown, member count, amber warning when no policy is set, slot preview showing member count vs available slots (green/red), and a slot assignment table showing which serial maps to which EARFCN within the chosen band
  - *Per-CBSD Overrides* — compact table showing all registered CBSDs with serial, FCC ID, group, and resolved band (with override/group/default source label). Edit button opens a fixed-position centered modal (prevents clipping in table rows) with band selector and notes field; ★ marks active overrides
  - *No Interference Group* — CBSDs without a coordination group, note to set per-CBSD override or use global default

- **Band policy REST endpoints** — Six new endpoints in `sas-controller.ts`:
  - `GET/PUT/DELETE /sas/admin/policies/groups/:groupId`
  - `GET/PUT/DELETE /sas/admin/policies/cbsds/:fccId/:serial`

- **Band policy frontend API** — Six new methods in `frontend/src/api/sas.ts`: `listGroupPolicies`, `setGroupPolicy`, `deleteGroupPolicy`, `listCbsdPolicies`, `setCbsdPolicy`, `deleteCbsdPolicy`

- **Unified spectrum chart** — New `UnifiedSpectrumChart` component renders all configured bands and all active grants on a single 3550–3700 MHz axis. Shows band background shading, unassigned slot hatching, active grant blocks with serial labels, band boundary lines, MHz tick marks every 10 MHz, and band name labels. Only shown when 2+ bands are configured. Per-band detail charts continue to show above it.

- **HTTPS SAS endpoint (port 8443)** — nginx now serves a second `server` block on port 8443 with TLS, proxying only `/sas/` paths. All other paths return 404. A new `cert-init` Docker service (`alpine/openssl` image) auto-generates a self-signed RSA-4096 certificate with correct SAN entries (server IP, hostname, `sas.local`, `localhost`) on first `docker compose up`. Certificate is written to `./nginx/certs/sas.crt` and `sas.key`. nginx `depends_on: cert-init: service_completed_successfully`. `nginx/certs/*.crt`, `*.key`, `*.pem` added to `.gitignore`; `nginx/certs/.gitkeep` tracks the empty directory.

- **Sercomm SCE4255W full SAS provisioning** — Complete rewrite of the Sercomm ACS module Location & SAS card. All previously hardcoded SAS parameters are now configurable form fields with correct defaults:
  - *Method* dropdown: Direct SAS (0) / Domain Proxy (1)
  - *Installation Method* dropdown: Single-Step (0, `CPIInstallParamSuppliedEnable=false`) / Multi-Step (1)
  - *Category* dropdown: A / B
  - *Channel Type* dropdown: GAA / PAL (`ProtectionLevel`)
  - *Location* dropdown: Indoor / Outdoor
  - *Location Source* dropdown: Manual (0) / GPS (1) (`HighAccuracyLocationEnable`)
  - *Height Type* dropdown: AGL / AMSL
  - *Lat/Long* in decimal degrees — auto-converted to microdegrees on push (multiply × 1,000,000)
  - *SAS User ID* (`UserContactInformation`)
  - *SAS Server URL* (defaults to `https://<hostname>:8443/sas/v1.2`)
  - *Manufacturer Prefix* checkbox (prepends `Sercomm-` to serial, default checked)
  - *CPI Required* checkbox (Cat B outdoor only, default unchecked)
  - *Verify SAS Cert* checkbox (`PeerCertVerifyEnable`, default unchecked for self-signed)
  - *Enable SAS* checkbox
  - Also sets: `ManufacturerPrefixEnable`, `UserIDSelectMethod=0`, `HighAccuracyLatitude`, `HighAccuracyLongitude`, `HighAccuracyLocationEnable`, `CPIEnable`, `CPIInstallParamSuppliedEnable`
  - `sasServerUrl` and `sasPeerCertVerify` added to `SercommProvisionInput` type in both backend and frontend

- **SAS Log filter** — "Filter by CBSD ID" text input on the Logs tab filters displayed lines client-side by any string (CBSD ID, serial, IP, response code).

- **Quiet docker compose logs** — Per-request SAS protocol traffic (`spectrumInquiry`, `grant`, `heartbeat` requests and responses, band resolution, slot assignment, duplicate grant, grant keeper renewal) downgraded from `info` to `trace` level. `startSummaryLogger(30_000)` started in `index.ts` alongside grant keeper; every 30 seconds logs one clean line: `SAS ─ N active grants: \u25cf <serial> <low>-<high>MHz EARFCN:<n>`. `stopSummaryLogger()` called on graceful shutdown.

### Fixed

- **Per-CBSD override modal clipped** — `CbsdPolicyEditor` popover changed from `absolute` positioning (clipped by table overflow) to `fixed` modal centered with `top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2`. Transparent backdrop closes on click-outside.

- **Spectrum chart unicode escape sequences** — `\u2013` (en dash), `\u25cf` (bullet), `\u00b7` (middle dot) inside template literals were rendered as literal escape text. Replaced with direct UTF-8 characters.

- **Sercomm `HeightType`** — Was hardcoded to `AMSL`. Corrected to `AGL` (WInnForum CBSD spec requirement for indoor Cat A deployments) as the default, now user-configurable.

- **Sercomm lat/long format** — `HighAccuracyLatitude` and `HighAccuracyLongitude` were not being set at all. Now set from form lat/long fields converted to microdegrees.

- **SAS `spectrumInquiry` returning all bands** — Previously returned all configured bands as available channels. Now returns only the CBSD's resolved band (via `resolveBand()`), preventing Sercomm radios from being offered Baicells-only slots.

- **Sercomm SSL connect error** — Radio was configured with `https://172.16.0.168:8888/sas/v1.2` (HTTP port). Fixed by updating default SAS URL to port 8443 and adding a validation note in the form.

- **`useMemo` not imported** — `BandPolicyTab` used `useMemo` but it wasn't in the React import in `SASPage.tsx`. Added to import.

- **`isShared` unused variable** — Removed unused `isShared` variable from slot table row renderer in `BandPolicyTab`.

- **`sasServerUrl` not in `SercommProvisionInput`** — Added as optional field to type in `genieacs.ts` to fix TypeScript build error.

### Changed

- **SAS tab renamed** — "Band Policy" tab renamed to "Band Assignment" for clarity
- **`getSlotLayout()`** — Now returns all configured bands (not just first band) as a `bands` array with per-band slot data. Legacy flat fields (`bandLow`, `bandHigh`, `slotWidthHz`, `slots`) preserved for backward compatibility.
- **`findMatchingBand()`** — Still used as fallback in `resolveBand()` for global default; no longer called directly from `spectrumInquiry` or `grant`
- **Version bumped to `2.0.0-beta_0.1`** across `backend/package.json` and `frontend/package.json`

---

## [v2.0-beta] - 2026-05-27

### Added

**📡 CBRS SAS Server**
- Full built-in WInnForum SAS-CBSD protocol server implementing the complete CBRS interface: registration, spectrumInquiry, grant, heartbeat, relinquishment, deregistration
- Deterministic per-CBSD channel assignment keyed by `cbsdSerialNumber` sort order within interference coordination group — race-condition-proof, survives re-registrations and Clear DB cycles
- Interference coordination group support (`groupType: INTERFERENCE_COORDINATION`) — radios in the same group are automatically spread across non-overlapping 20 MHz frequency slots
- Multi-site scaling — independent slot assignment per group ID; multiple sites can reuse the same physical frequencies without conflict
- GPS delay enforcement — configurable lock delay (default 75 s, keyed per `fccId:serial`) before grants are issued, ensuring radios are GPS-locked before transmitting
- Grants issued directly as `AUTHORIZED` (not `GRANTED`) so radios enable RF immediately on first grant response without waiting for a heartbeat cycle
- `Pause SAS` / `Resume SAS` toggle button — when paused, all SAS protocol endpoints return `DEREGISTER`/`TERMINATED_GRANT`; radios stop transmitting without any data being deleted. Red banner shown on dashboard when paused.
- `Clear DB` button — wipes all grants and CBSDs from MongoDB and clears GPS delay clocks; radios re-register and get fresh deterministic slot assignments on next contact
- Spectrum chart — visual frequency band display with color-coded slots, EARFCN labels, and per-CBSD assignment table showing which serial maps to which slot
- SAS admin REST API: `POST /sas/admin/reset`, `POST /sas/admin/pause`, `POST /sas/admin/resume`, `GET /sas/admin/status`, `GET /sas/admin/slots`
- SAS config page — band low/high EARFCN, max grant bandwidth, GPS lock delay, heartbeat interval, default max EIRP
- MongoDB-backed CBSD and grant persistence

**📡 Baicells eNodeB Provisioning**
- Full Band 42/43/48 band selector with auto-fill button for band-appropriate defaults
- EARFCN dropdown per band — in SAS mode 2 the EARFCN field is greyed out and labeled `(SAS)` since the radio tunes to the SAS-granted frequency
- EARFCN mismatch warning when configured EARFCN doesn't match the expected SAS-assigned slot center frequency
- All SAS TR-069 parameters provisioned: `SAS.enableMode`, `SAS.RadioEnable`, `SAS.ServerUrl`, `SAS.UserId`, `SAS.CallSign`, `SAS.FccId`, `SAS.groupType`, `SAS.groupId`, `SAS.LegacyMode`, `SAS.RegistrationType`, `SAS.reqLowFrequency`, `SAS.reqHighFrequency`, `SAS.PreferredFrequency`, `SAS.PreferredBandwidth`, `SAS.PreferredPower`, `SAS.MaxEIRP`, `SAS.EirpCapability`
- RF enable sends task twice (queued + connection_request) to ensure immediate effect
- `rfStatus` correctly derived from `X_COM_RadioEnable AND opState` (not just RadioEnable)
- EARFCN not pushed to radio in SAS mode 2 (radio tunes to SAS grant automatically)

**🔗 Remote UPF / SGW-U Architecture (4G + 5G Edge Deployments)**
- **Remote UPF config generator** (UPF config page, Section 2) — enter remote site PFCP and GTP-U addresses, DNN, session pool, DNS; generates ready-to-deploy `upf.yaml`; "Add to SMF & Apply" button wires the remote UPF into `smf.yaml` PFCP client list automatically; full deployment steps included
- **SMF config page** (fully rewritten) — UPF routing table showing local UPF (labeled "same host") and remote UPF entries; routing criteria: DNN, TAC (decimal), eNodeB Cell ID (hex, 28-bit), NR Cell ID (hex, 36-bit); routing destination badge on session pools showing which UPF handles each pool; routable SMF PFCP address selector; "Remove All Remote UPFs" bulk action
- **Remote SGW-U config generator** (SGW-U config page, Section 2) — mirrors UPF generator exactly; generates ready-to-deploy `sgwu.yaml` with SGW-C address, PFCP server, and GTP-U server; deployment steps for `open5gs-sgwu` on remote host
- **SGW-C config page** (fully rewritten) — SGW-U routing table with local SGW-U (labeled "same host") and remote SGW-U entries; routing criteria: TAC, APN, Cell ID (e_cell_id, hex); routable SGW-C PFCP server section; "Remove All Remote SGW-Us" bulk action
- Cross-navigation: "Edit in Generator" button on SMF/SGW-C routing entries navigates to UPF/SGW-U tab and pre-populates the generator form
- "How it works" topology button on SMF and SGW-C pages — opens modal with network diagram, key point cards (control plane / PFCP / user plane), IP requirements callout
- Network topology diagram (SVG) embedded inline — central site (AMF, MME, SMF, SGW-C) ↔ edge site (UPF, SGW-U) with all interface IPs, PFCP/N4/Gxc connections, N2/S1-MME control plane (dashed), N3/S1-U user plane; clean orthogonal routing, no crossing lines
- `sgwc.yaml` and `sgwu.yaml` added to auto-config backup list and service restart list

**⚙️ Auto-Config improvements**
- "Use Local UPF Only" checkbox (default checked) — hides PFCP addressing complexity for single-server deployments; shows loopback summary `127.0.0.4 ↔ 127.0.0.7`; auto-detects from existing `smf.yaml` pfcp.client.upf list
- `mergePfcpServers()` helper function — prevents duplicate IP entries in PFCP server lists for SMF, UPF, and SGW-C; deduplicates existing entries; replaces all previous ad-hoc dedup logic
- `localUpfOnly` and `localSgwuOnly` flags — when true, forces loopback defaults regardless of any IP fields entered
- SGW-C PFCP auto-config — when `localSgwuOnly: true`, sets `127.0.0.3` as SGW-C PFCP server and `127.0.0.6` as SGW-U client

**🧪 Unit Tests (Jest)**
- 32 unit tests for RAN UE session reporting in `backend/src/__tests__/active-sessions.test.ts`
- Coverage: 4G/5G UE detection, IMSI field variants (`supi` vs `imsi`, `imsi-` prefixed vs bare), UE deduplication, live eNodeB/gNodeB filter (setup_success), Prometheus metrics fallback, interface status (S1-MME, S1-U, N2, N3)
- `parsePeerIP` helper tests (bracketed IPv4, bracketed IPv6, plain `IP:port`, bare IP)
- `ts-jest` and `@types/jest` added to backend devDependencies; `jest` config added to `backend/package.json`
- Dockerfile updated to always use `npm install` (no lock file sync issues)

### Fixed

- **RAN page crash** — `mmeUe.supi` null guard added with fallback to `imsi` field for Open5GS versions that use `imsi` instead of `supi`. Crash was dropping all 4G UEs from display after the first malformed entry.
- **RAN page live eNodeB filter too strict** — `setup_success: false` was causing `liveEnbIps` to be empty, silently dropping all 4G UEs. Filter now only skips UEs whose specific radio IP is absent from the live set; UEs with unresolvable radio IPs pass through.
- **RAN page 5G-only deployment** — `getActive4GUEs()` now short-circuits immediately when both MME `/ue-info` and `/enb-info` return empty (no MME running), avoiding redundant SMF PDU queries and a redundant `getActive5GUEs()` dedup call
- **Services page Stop 4G / Stop 5G** — Express route order bug: `/:name/:action` was matching before `/all/:action`. Fixed by registering `/all/:action` first in `service-controller.ts` and `sas-controller.ts`.
- **SGW-C and SGW-U metrics sections removed** — Neither service exposes a Prometheus metrics HTTP endpoint. Metrics blocks removed from `SgwcEditor.tsx` and `SgwuEditor.tsx`.
- **Duplicate PFCP server IP (auto-config)** — Entering a loopback address already present in the YAML created a duplicate `pfcp.server` entry. `mergePfcpServers()` helper prevents this for all services and self-heals existing duplicates.
- **SAS double EARFCN grants** — Previous slot assignment was sorting CBSDs by `cbsdId` (UUID, changes on re-registration) causing position instability. Changed to sort by `cbsdSerialNumber` which is hardware-bound and never changes. Also removed PENDING grant placeholder approach (race-prone) in favor of pure deterministic serial sort.
- **SAS RadioEnable not set** — Grants were issued as `GRANTED` requiring a heartbeat to become `AUTHORIZED` before `SAS.RadioEnable` goes true. Changed to issue grants directly as `AUTHORIZED` since GPS delay is already satisfied by grant time.

### Changed

- **Version bumped to `2.0.0-beta`** across `backend/package.json` and `frontend/package.json`
- **SAS slot assignment** — switched from `cbsdId` sort key to `cbsdSerialNumber` sort key for stable, hardware-bound slot assignment
- **`getActive4GUEs()` signature** — accepts optional `imsi5GSet?: Set<string>` parameter; when provided by `GetInterfaceStatus`, skips the internal `getActive5GUEs()` call to avoid redundant API requests
- **`GetInterfaceStatus.execute()`** — now runs `getActive5GUEs()` first, passes resulting IMSI set to `getActive4GUEs(imsi5GSet)` eliminating the double 5G API call
- **`TopologyModal`** — new shared component (`TopologyModal.tsx`) with inline SVG topology diagram, key point cards, IP requirements callout; used by both SmfEditor and SgwcEditor
- **README** — added CBRS SAS section with feature list and screenshot placeholders; updated latest release section to v2.0-beta

---

## [v1.3.6] - 2026-05-18

### Added
- **Radio nickname tags** — Tag any eNodeB or gNodeB IP with a friendly name (e.g. "Site A gNB", "Lab eNB"). Tags stored in SQLite (`radio_tags` table), persist across sessions, visible to all users. Admins edit inline on the RAN Network page (pencil icon on hover, Enter to save, empty = delete).
  - `SqliteRadioTagRepository` — new repository sharing the existing auth SQLite DB (`getDb()` exposed on `SqliteAuthRepository`)
  - `radio-tags-controller.ts` — `GET /api/radio-tags` (all users), `PUT /api/radio-tags/:ip` and `DELETE /api/radio-tags/:ip` (admin only)
  - `radio_tags` table added to `sqlite-auth-repository.ts` `initSchema()`
  - `radioTagsApi` added to frontend `api/index.ts`
- **UE nicknames on RAN Network page** — Subscriber nicknames (set on Subscriber page) now appear below the IMSI in both per-radio UE sub-rows and the All Sessions table. Enriched at the backend by batch-fetching nicknames from MongoDB after building the active UE list.
  - `getNicknamesByImsi(imsis)` added to `MongoSubscriberRepository` and `ISubscriberRepository` interface
  - `getActive5GUEs()` and `getActive4GUEs()` in `active-sessions.ts` now enrich each `ActiveUE` with `nickname` from MongoDB
  - `ActiveUE` interface: `nickname?: string` added in both backend and frontend
- **RAN Network page — wider layout** — Container widened from `max-w-7xl` (1280px) to `max-w-[1600px]`. Table cell padding tightened from `px-4 py-3` to `px-3 py-2.5`. IMSI and Radio columns given `min-w` so nicknames have room to breathe.

### Fixed
- **Femtocell — password/username re-probe on blur** — WebUI Username and WebUI Password fields now call `probeDevice(cfg.ip)` on blur when an IP is already entered. Previously the user had to retype the IP after entering credentials to re-trigger the probe.
- **MongoDB log spam suppressed** — `systemctl is-active mongod` failures are now logged at `debug` (not `error`) since they are expected when MongoDB runs in Docker. MongoDB Docker probe info logs throttled to once per 15 minutes (was every 5 seconds).
- **TUN interface creation — IP not assigned** — `ip addr add` was returning exit 0 but the address never appeared on the interface. Root cause: `executeCommand` (nsenter `-m`) enters the host mount namespace but not the host network namespace. Fix: use `executeLocalCommand` with explicit `nsenter --net=/proc/1/ns/net` for all `ip` commands. Confirmed working.
- **TUN interface creation — networkctl race** — `networkctl reload` after `ip addr add` caused systemd-networkd to flush and reassign the address, creating a race where `list()` ran during the flush window and saw no address. `networkctl reload` removed from the create/edit flow. Persistence handled exclusively by a systemd oneshot service at `/etc/systemd/system/open5gs-tun-<name>.service`.
- **TUN interface state detection** — State now derived from the `<...,UP>` flags field in `ip -o link show` output, not the `state UP` keyword. TUN interfaces with `NO-CARRIER` always show `state DOWN` even when the UP flag is set, so the previous logic always reported them as down even after `ip link set up`.
- **TUN interface — not detected as created** — `exists` was derived from `liveMap` which was built from `ip addr` output and only populated when an IPv4 was assigned. Interfaces without a yet-assigned IP were reported as `NOT CREATED`. Fixed: `exists` now derived from `ip link` output which lists all interfaces regardless of IP.
- **SMF/UPF — local UPF routing label missing** — SMF Session Pools now show a green "↗ Local UPF" badge for all pools with no matching remote UPF DNN rule (including the default no-DNN pool). Previously only remote UPF pools showed a routing destination badge.
- **YAML round-trip safety (all 16 NFs)** — `saveRaw()` in `yaml-config-repository.ts` now reads the current on-disk YAML before every write and deep-merges the incoming doc over it using `deepMerge(base, overlay)`. Unknown fields (manually added `dev:` bindings, custom `session` entries, extra top-level keys, timer sections) are preserved. Arrays are replaced not merged so deleting a session pool via the UI still works. Frontend editors for AMF NGAP server, MME S1AP server, and SGW-C GTP-C server fixed to spread existing server entries (preserving unknown sibling keys) rather than creating bare replacement objects.
- **SMF session pool ordering** — `auto-config.ts` `execute()` now sorts SMF session pools: DNN-specific pools first, default (no-DNN) pools last. Open5GS matches pools top-to-bottom and crashes on unknown DNN if the default pool appears before a named one.

### Changed
- **Tests infrastructure** — `tests/yaml-round-trip.test.ts` updated with correct run command (via backend container). `tests/run-tests.sh` one-shot script and `tests/README.md` added.
- **`iproute2` added to backend Dockerfile** — Required for `ip tuntap`, `ip addr`, `ip link` commands used by the TUN management use case.

---

## [v1.3.5] - 2026-05-16

### Added
- **Topology — UE overflow popup panels** — Active 4G UE Sessions and Active 5G UE Sessions boxes now cap at 3 UEs displayed inline. If more than 3 UEs are active, a clickable "+ N more — click to view all" button appears at the bottom of the JointJS box. Clicking it opens a draggable floating panel (positioned absolutely over the canvas) showing all UEs with IP and IMSI. Panel is draggable by its header, auto-sizes to fit all UEs (max 400px scrollable), and has a close button. Separate panels for 4G and 5G.
- **RAN Network page — sortable UE sessions table** — IMSI, UE IP, and DNN/APN columns are now sortable. Clicking a header sorts ascending; clicking again toggles descending. Active sort column shows ↑↓ arrow indicator; inactive columns show ⇅. Sort is client-side in-memory — no API call.
- **Subscriber page — sortable columns** — IMSI, UE IPv4, and APN columns are now sortable. Sort is fully client-side (frontend `useMemo` sort) — no backend aggregation pipeline. Instant response with no page refetch. Clicking same column toggles asc/desc; clicking new column resets to asc.
- **Services page — 4G/5G group toggle buttons** — Two new toggle buttons in the services page header: blue "Start/Stop 5G" and amber "Start/Stop 4G". Each button reads the current running state and toggles accordingly. MongoDB is excluded from both groups. Backed by new optional `services` filter parameter on `POST /api/services/all/:action`.
- **Remote UPF management (UPF tab)** — New `UpfEditor.tsx` component with three sections:
  - **Local UPF** — edits `upf.yaml`, clearly labelled as the UPF on this host. Loopback warning on GTP-U address.
  - **SMF → UPF Connections** — edits `smf.yaml pfcp.client.upf` as a multi-entry list. Add/remove remote UPFs. Colour-coded local (green) vs remote (blue). Saves to `smf.yaml` on Apply Changes.
  - **Remote UPF YAML Generator** — Fill in PFCP and GTP-U addresses, session pool, DNS. Generates a ready-to-deploy `upf.yaml` for the remote machine. Copy/download buttons. "Add to SMF UPF List" button. Deployment instructions included. Auto-fills SMF real routable IP from config.
- **SMF config — DNN field on session pools** — Session pool rows now have a third `DNN (optional)` field alongside Subnet and Gateway.
- **SMF config — dual PFCP server addresses** — SMF PFCP server section now has two address fields: loopback (keep for local UPF) and optional real IP (for remote UPF to connect back to). Both are written to `smf.yaml pfcp.server[]`.
- **SBI Client defaults** — NRF URI defaults to `http://127.0.0.10:7777` and SCP URI defaults to `http://127.0.0.200:7777` when fields are empty.

### Fixed
- **Topology — MongoDB status light always red** — `mongodb` was not in the topology services list, so `statuses?.['mongodb']` was always `undefined` → always red regardless of actual state. Fixed by adding `mongodb` to the topology node list. Additionally, the topology endpoint now performs a **live** `getMongoStatus()` call (TCP ping + docker ps) on every topology load rather than relying on the polling cache.
- **Topology — MongoDB Docker detection** — `getServiceStatus()` was calling `isServiceActive()` which returns `false` without throwing when the systemd unit doesn't exist. The Docker fallback was in the `catch` block and never ran. Fixed: for `mongodb`, if `isServiceActive()` returns `false` (regardless of whether it throws), immediately call `getMongoDockerStatus()` before reporting inactive.
- **Topology — background dots removed** — `drawGrid: true` in JointJS paper config was rendering a dot grid over the canvas. Changed to `drawGrid: false`. Removed now-unused `drawGridSize` and `gridPattern` options.
- **Topology — thin grey border around map removed** — The container div had `border border-nms-border` class which drew a visible line around the entire topology canvas. Removed the border classes.
- **Log download — Docker tab greyed out** — The Docker Containers button in `LogDownloadModal` was hardcoded `disabled` with a `cursor-not-allowed` style. Removed the `disabled` attribute and made it a fully functional tab.
- **Log download — Docker containers not populated on modal open** — The download modal received `dockerContainers` as a prop from `LogsPage`, but `LogsPage` only fetched containers when the user had already clicked the Docker tab. Opening the download modal directly showed an empty container list. Fixed by adding a `useEffect` in `LogDownloadModal` that fetches containers from `/api/docker/containers` on mount, independent of the parent.
- **Log download — Docker containers not populated on main log page** — `LogsPage` only fetched containers when `logSource === 'docker'`. Changed to fetch on mount unconditionally so all containers are shown immediately.
- **Log download — all containers filtered to open5gs-nms only** — `DockerLogExecutor.getContainers()` used `--filter name=open5gs-nms`, hiding MongoDB and other containers. Removed the filter so all running containers are returned.
- **Log download — Docker logs using nsenter** — Docker log fetching was calling `executeCommand('bash', ['-c', 'docker logs ...'])` which routes through `nsenter`, causing failures. Changed to `spawn('docker', [...])` directly — the same approach used by the Unified Logs module which already works. `/var/run/docker.sock` is mounted into the container.
- **Log download — tar source directory not found** — Log files were being written to the host `/tmp` via `nsenter` but `tar` was running inside the container's `/tmp`. These are different filesystems. Fixed by using `fs.readFile`/`fs.writeFile` directly (since `/var/log/open5gs` and `/etc/open5gs` are mounted into the container) and running `tar` locally inside the container where all temp files exist.
- **SD values written with quotes in YAML** — `yaml-config-repository.ts` post-processing was enforcing `sd: "000001"` (with quotes). Open5GS config style uses unquoted SD values. The load side (`fixMccMncSdFromRawYaml`) already handles both forms on read. Fixed: post-processing now strips quotes → writes `sd: 000001` unquoted. Applies to AMF, SMF, and NSSF since all go through the same `saveRaw()` method.
- **Subscriber sort not working** — Sort was implemented as a MongoDB aggregation pipeline with `$addFields` + `$ifNull` on nested array fields. This was unreliable for missing/null values and added latency. Moved sorting entirely to the frontend: `fetchSubscribers()` always fetches in default IMSI order; `sortedSubscribers = useMemo(...)` sorts the current page in-memory using `localeCompare` with `numeric: true`. No backend changes needed per sort action.
- **403 permission denied — viewer could restart services and change configs** — `requireAdmin` middleware was missing from `service-controller` (POST routes), `config-controller` (validate/apply/sync-sd), `auto-config-controller` (preview/apply), `suci-controller` (all write routes), and `backup-controller` (all 11 write routes). Fixed by adding `requireAdmin` to every write route in every controller.
- **403 permission denied toast** — Added a 403 interceptor in the axios response interceptor that shows a `🔒 Permission denied` toast for any 403 response. Uses `id: 'forbidden'` to deduplicate.

### Changed
- **Topology — UE boxes capped at 3** — Both Active 4G UE Sessions and Active 5G UE Sessions boxes render a maximum of 3 UE cards inline. Overflow shown via the popup panel (see Added above). Box height stays fixed regardless of UE count.
- **Config page — SMF PFCP UPF field** — The single UPF address input in the SMF tab is now a read-only display showing current UPF list with a note "Manage in UPF tab". Full UPF list management moved to the UPF configuration tab.
- **Subscriber table** — Added APN and UE IPv4 columns. Removed session_count column. Sortable IMSI, APN, UE IPv4 headers.
- **MongoDB status source field** — `ServiceStatus` and frontend `ServiceStatus` type both now carry `source?: 'systemd' | 'docker' | 'direct'`. Services page shows a blue "docker" badge next to MONGODB when detected via Docker.
- **`SubscriberListItem`** — Added `ue_ipv4?: string` and `apn?: string` fields (backend entity + frontend type). These are extracted from the first session of the first slice and included in list projections.

### CHANGELOG
- v1.3.4 entries (MongoDB Docker detection, subscriber sorting, Docker container list fix, log download Docker tab fix) retroactively merged into v1.3.5 as all were part of the same development cycle.

---

## [v1.3.3] - 2026-05-05

### Added
- **Viewer role (read-only access)** — New `viewer` user role that can monitor everything but cannot make any changes. Admins can create viewer accounts and toggle existing users between admin and viewer from the User Management page.
  - Role selector on user create form (Admin / Viewer)
  - Role badges on user table (Shield = Admin, Eye = Viewer)
  - "Make Viewer / Make Admin" toggle button per user
  - Prevents demoting yourself or the last admin account
  - Amber "View-only mode" banner shown at top of every page for viewer sessions
  - All write routes on backend protected with `requireAdmin` middleware
- **403 permission denied toast** — When a viewer (or anyone) hits a protected endpoint, a `🔒 Permission denied` toast appears instead of a silent failure. Uses `id: 'forbidden'` to deduplicate multiple simultaneous 403s.
- **Subscriber CSV export** — `GET /api/subscribers/export?format=csv` streams all subscribers as a CSV file. Available to all users including viewers. Columns: `imsi, nickname, iccid, msisdn, ki, opc, amf, sst, sd, apn, type, ue_ipv4, ue_ipv6`.
- **Subscriber CSV import** — `POST /api/subscribers/import` (admin only). Accepts CSV with `{csv, mode}` where mode is `skip` (default) or `overwrite`. Returns `{imported, skipped, overwritten, errors[]}`. Import button with mode selector on Subscriber page.
- **Femtocell beta warning banner** — Red banner at top of Femtocell Provisioning tab indicating the module is under active development.
- **SUCI dual key format display** — Each key now shows two copyable formats:
  - Profile A (X25519): Raw 64-hex (Open5GS UDM) and `04`-prefixed 66-hex (SIM tools)
  - Profile B (secp256r1): Compressed 66-hex (Open5GS UDM) and uncompressed 130-hex (SIM tools)

### Fixed
- **Viewer role write access bug** — `requireAdmin` middleware was added to the `users-controller` but was missing from `service-controller`, `config-controller`, `auto-config-controller`, `suci-controller`, and `backup-controller`. Viewers could restart services and change configs. All write routes in all controllers now correctly enforce admin-only access.
- **Subscriber CSV import `ambr` validation error** — `rowToSubscriber` was missing the required top-level `ambr` field on the subscriber document. Open5GS schema requires `ambr` at both the subscriber level and the session level. Import was failing with `ambr: required` on every row.
- **Subscriber CSV import session type** — Import was hardcoding `type: 3` (IPv4v6). Now reads from the `type` CSV column and defaults to `1` (IPv4) if blank. Supports all three values: `1` = IPv4, `2` = IPv6, `3` = IPv4v6.
- **Subscriber CSV import IPv6 address** — Added `ue_ipv6` column to CSV. Import correctly builds `ue: { ipv4, ipv6 }` object with only the fields that are populated.
- **`UserRole` type** — Domain entity `UserRole` was typed as `'admin'` only, causing TypeScript to reject `'viewer'` everywhere it flowed through. Fixed to `'admin' | 'viewer'`.
- **`SafeUser` missing `createdAt`** — Frontend was casting `(u as any).createdAt` because the field was absent from the `SafeUser` interface. Added to interface and `toSafeUser()` mapper.

### Changed
- **User Management page** — Rewritten to include role management, role badges, and improved UX. Role selector on create form. Toggle button per user. Prevents self-demotion and removing last admin.
- **Subscriber page** — Export CSV button always visible (including viewer). Import CSV, Add, Edit, Delete, SIM Generator, and Auto-Assign IPs hidden for viewer role.
- **CSV format** — Added `type`, `ue_ipv4`, `ue_ipv6` columns. Removed `ul_mbps`, `dl_mbps` (not used by Open5GS). All values now round-trip correctly through export → import.

---

## [v1.3.2] - 2026-05-03

### Fixed
- **Femtocell provisioning success detection** — Replaced brittle 3-string `allOk` check with correct logic. Previous check required `[+] OK  sasConf` even when SAS was disabled, causing every non-SAS provision to report failure. Corrected string matching to include `.htm` suffixes. Added conditional sasConf check and `noFailures` fallback.
- **Femtocell output panel color** — Red/green border and icon now key off `[-] FAILED` (exact script failure marker) instead of `FAILED`. Reboot wait `[!]` warning lines no longer turn the panel red on a successful provision.
- **Femtocell error toast duration** — Extended to 8 seconds with "Check output for details" so the output panel is readable before the toast disappears.
- **Femtocell probe config regression** — A failed attempt to fix checkbox detection via a `--probe-config` subcommand introduced Python syntax errors and corrupted the inline regex strings in the probe Step 3 block (`{{name}}` double-braces and stray `]` characters broke rf-string interpolation). Rolled back both `femto-controller.ts` and `femto_provision.py` to the v1.3.1 working state. The probe correctly pulls and pre-fills all text fields; checkbox pre-fill (Admin State, Carrier Aggregation, Contiguous CC, Auto Internal Neighbors) remains a known issue for a future fix.
- **SUCI Profile A SIM provisioning key** — Removed incorrect `04` prefix from X25519 public key. X25519 keys are raw 32 bytes (64 hex) with no point-compression prefix. The `04` prefix is secp256r1 uncompressed-point notation and is invalid for X25519. Both Open5GS UDM and SIM provisioning tools (pySIM, sysmoUSIM) use the same raw 32-byte format for Profile A.

### Added
- **SUCI dual key display** — KeyCard now shows two separate copyable keys per entry:
  - **Open5GS UDM Key** — compressed/raw format for `udm.yaml` hnet block
  - **SIM Provisioning Key** — format required by pySIM/sysmoUSIM when programming eSIMs
  - Profile B (secp256r1): UDM shows compressed 66 hex, SIM tools show uncompressed 130 hex
  - Profile A (X25519): both show the same raw 64-hex value with a label clarifying they are identical
  - Each key has its own Copy button; sublabels show exact byte format and length per profile

### Changed
- **`HnetKey` frontend type** — Added `publicKeyUncompressed: string | null` field to match the backend (which already returned this value).
- **SUCI usage info** — KeyCard usage blurb now references correct `scheme` and `id` values inline for both key types.

### Known Issues
- **Femtocell probe checkboxes** — Admin State, Carrier Aggregation, Contiguous CC, and Auto Internal Neighbors always show unchecked on probe regardless of device state. Root cause: Sercomm omits the checkbox `<input>` element when unchecked (standard HTML), so the `checked`-attribute regex always returns false. Fix requires reading the `h_<field>` hidden inputs instead. Deferred.

---

## [v1.3.1] - 2026-05-02

### Fixed
- **Port conflict with FoHSS IMS HSS** — Frontend internal port changed from 8080 to 8081. FoHSS (IMS Home Subscriber Server used in VoLTE setups) also binds port 8080, causing the frontend container to fail to start. Updated `frontend/Dockerfile`, `nginx/nginx.conf`, `docker-compose.yml`, and `.env.example`.

### Improved
- **Femtocell probe** — Probe endpoint now uses Python `requests` instead of Node.js `https` module. Node TLS rejects old Sercomm self-signed certificates; Python handles them correctly.
- **Femtocell reboot wait** — `wait_for_webui_reboot` and `wait_for_webui_up` no longer call `sys.exit(1)` on timeout. Reboot wait is now best-effort — script exits 0 if all config pages saved successfully, regardless of reboot timing. Timeouts increased from 300s to 600s.

---

## [v1.3.0] - 2026-05-02

### Added
- **Femtocell Provisioning tab** (Auto Config page) — Full provisioning UI for Sercomm SCE4255W CBRS small cells
  - Auto-detects WebUI status on IP field blur
  - Automatically fetches MAC via `sc_femto` SSH and derives credentials using calc_f2 algorithm
  - Pulls and pre-fills current device config from `devComState.htm`
  - Configures radio (Band 48 dual-carrier defaults), S1/core, SAS/location, and CWMP settings
  - MME IP auto-populated from Open5GS MME config
  - Browser geolocation support for SAS lat/long (micro-degrees format)
  - Dry run and live provision with full script output displayed on completion
  - `femto_provision.py` bundled in backend Docker image at `/app/tools/`
  - Backend endpoints: `GET /api/femto/probe`, `POST /api/femto/provision`
- **Auto Config page tabs** — "Open5GS Auto Config" and "Femtocell Provisioning" tabs

### Fixed
- **Service restart logout bug** — `window.location.reload()` after service actions replaced with `fetchStatuses()`. Page reload was dropping the session cookie on HTTP connections where `secure:true` cookies are silently ignored by the browser.
- **COOKIE_SECURE env var** — Was declared in `.env.example` but never read by the application. Now properly wired through `config/index.ts` → `createLucia()` → session cookie attributes.
- **GLIBC mismatch on Ubuntu 24.04** — `nsenter` now passes bare command names instead of full paths (e.g. `systemctl` not `/usr/bin/systemctl`). Node resolves full paths before `nsenter` runs, picking up container binaries that require an older GLIBC. Bare names resolve after entering the host mount namespace, using the host's own binaries and GLIBC. Fixes `GLIBC_2.39 not found` error reported on Ubuntu 24.04 Noble.
- **pySIM bundled** — Removed `git clone` of pysim from Dockerfile. `suci-keytool.py` and `osmocom/` package now bundled directly in `backend/tools/`. Eliminates build-time dependency on `gitea.osmocom.org`.

### Changed
- **nginx** — Added `/api/femto/` location block with `proxy_buffering off` and 700s timeout, placed before `/api/` block to ensure correct routing.
- **Dockerfile** — Added `paramiko` and `requests` to pip install for `femto_provision.py`.

---

## [v1.2.8] - 2026-04-30

### Fixed
- **Session logout on service restart** — Replaced `window.location.reload()` with `fetchStatuses()` in `ServicesPage.tsx`.
- **COOKIE_SECURE** — Added `cookieSecure` field to `AppConfig`, read from `COOKIE_SECURE` env var (default `false`). Wired through to Lucia session cookie. Previously this env var was ignored.
- **GLIBC fix (Ubuntu 24.04)** — Bare command names passed to `nsenter` (initial fix; refined in v1.3.0).

---

## [v1.2.7] - 2026-04-28

### Added
- **Subscriber nickname field** — Shown in table (accent color) and edit form. Stored in MongoDB alongside Open5GS fields, invisible to core network.
- **Subscriber ICCID field** — Shown in table (monospace) and edit form. SIM Generator auto-provision saves ICCID to subscriber record.
- **pySIM JSON modal fixes** — secp256r1 (Profile B) now extracts compressed key (66 hex chars, 02/03 prefix) matching pySIM and 3GPP TS 33.501.

---

## [v1.2.6] - 2026-04-27

### Added
- **pySIM JSON generator** — One-click generation of correctly formatted `EF.SUCI_Calc_Info` JSON for pySIM-shell. Pretty and single-line formats. Accessible from SUCI Key Management page.
- **Full backup download** — Single `.tar.gz` containing all 16 NF config YAMLs + MongoDB dump. Disaster recovery from a single file.
- **Full backup restore** — Upload `.tar.gz` to restore entire system from scratch.
- **MongoDB service tracking** — MongoDB added as tracked service (`mongod` unit). Status circle on topology page. First in restart order since all NFs depend on it.
- **Open5GS internal API integration** — Active sessions and interface status now use Open5GS AMF/MME/SMF APIs directly instead of `tshark`/`conntrack`/`netstat`.
- **UE-to-radio mapping** — RAN Network page shows which eNodeB/gNodeB each UE is connected to.
- **THIRD_PARTY_NOTICES.md** — License notices for pysim (GPL-2.0), Open5GS (AGPL-3.0), JointJS (MPL-2.0), pyosmocom, pycryptodomex, and npm dependencies.

### Fixed
- **tar directory name bug** — Full backup was failing due to inconsistent directory naming between `mkdir` and `tar` steps.

---

## [v1.2.5] - 2026-04-25

### Added
- **SUCI Key Management** — Generate X25519 (Profile A) and secp256r1 (Profile B) home network keypairs. Automatic UDM config update. Multiple PKI IDs supported. Rename PKI ID without destroying keys.
- **SIM Generator** — Generate test SIM credentials with country-based MCC selection (65+ countries). Auto-provision generated SIMs to Open5GS.
- **Topology page improvements** — Dynamic height for 4G Radio Network Status box. `scaleContentToFit` on load. `ResizeObserver` for window resize.
- **MME security algorithms** — Interactive EIA/EEA editor matching AMF NAS security editor pattern.

---

## [v1.2.0] - 2026-04-20

### Added
- **Auto Config page** — One-click Open5GS network configuration. Supports multiple PLMNs for 4G (MME) and 5G (AMF). NAT/iptables configuration. YAML diff preview before applying.
- **Backup & Restore** — Config file backups, MongoDB backups, restore-to-defaults. Scheduled backups.
- **Audit log** — Tracks all configuration changes and service actions with timestamps.
- **User management** — Add/remove admin users, change passwords.
- **Metrics page** — Prometheus + Grafana integration. Auto-updates prometheus.yml when NFs are configured.

---

## [v1.0.0] - 2026-04-10

### Initial Release
- Dashboard with topology view (4G EPC + 5G SA)
- Subscriber management (CRUD via MongoDB)
- Configuration editor for all 16 Open5GS NF YAML files
- Service management (start/stop/restart via systemctl)
- Real-time log streaming
- WebSocket-based live updates
- Session authentication (SQLite + Lucia)
- Docker Compose deployment
