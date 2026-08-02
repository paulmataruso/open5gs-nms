# VectorCore ePDG Integration Plan

**Status: proposed, not yet implemented.** Written 2026-08-01 after a live
investigation (see `PROJECT_STATE.md` Known Issues §9) found that the
project's current VoWiFi ePDG stack (`osmo-epdg` + `strongswan-epdg`) has a
real, reproducible bug: it creates two separate GTP-C PDN sessions per UE
(one for APN `internet`, one for APN `ims`) that both get assigned the
*same* virtual IP, causing UPF to hold two conflicting forwarding rules for
that address. This is why no real phone has ever completed VoWiFi
registration on this project.

This document evaluates replacing that stack with
[`vectorcore-ePDG`](https://github.com/vectorcore-mobile/vectorcore-ePDG), a
from-scratch Go implementation, and lays out a full implementation plan:
backend controller, config generation, systemd/host integration, and a
frontend UI, following this project's established module conventions (IMS,
SMS, MMS, VoWiFi).

This plan was written without further user input, per explicit instruction.
Every place a judgment call was required is called out as **DECISION** (a
choice made and reasoning given) or **OPEN QUESTION** (a real unknown that
needs a human or a live test to resolve, not something I could responsibly
guess). Read those sections before starting implementation — several are
load-bearing.

---

## 1. Why this is worth doing (and the honest risk profile)

### What's wrong today

Confirmed live on 2026-07-31 (full detail in `PROJECT_STATE.md` §9): a real
Pixel 7 completes the IKEv2/EAP-AKA handshake and gets a tunnel every time,
but SIP registration through it almost never completes, because:

```
[smf] UE IMSI[...003] APN[internet] IPv4[10.45.0.75]   (23:37:55.503)
[smf] UE IMSI[...003] APN[ims]      IPv4[10.45.0.75]   (23:37:56.365)  <- same IP, 1s later
```

Two UPF PFCP sessions (different F-SEIDs) end up with the same source IP.
Routing for that IP becomes non-deterministic. The session churns
(`Removed Session` / recreate every 20-40s) and never stabilizes.

### Why VectorCore ePDG plausibly avoids this class of bug

Not a guarantee — a reasoned, evidence-based hypothesis that still needs a
live test to confirm (see §7). The reasoning:

- In the current stack, `strongswan-epdg`'s C plugin negotiates a virtual IP
  with the UE via IKEv2 CFG_REQUEST/CFG_REPLY *before* any GTP-C session
  exists, then hands that pre-picked IP to `osmo-epdg`'s GTP-C client
  (`epdg_gtpc_s2b.erl`), which passes it to SMF as a Requested-IP hint for
  *every* APN the UE attaches to on that IKE_SA. If SMF honors the hint
  for both APN attaches, both sessions get the same address — this matches
  exactly what was observed.
- VectorCore ePDG's README describes the S2b Create Session Response's PAA
  (PDN Address Allocation) as the source of the address delivered to the UE
  via CFG_REPLY — i.e. the IKEv2 config reply is driven *by* the GTP-C
  session result, not the other way around. If implemented that way, each
  APN attach gets whatever fresh address SMF's own pool allocator hands
  back for *that* GTP-C session, and the collision class disappears
  structurally rather than by coincidence.
- The project also explicitly documents `apn_idr_test.go` and
  `multi_bearer_log_test.go` in its test suite, and states re-attach to an
  already-active IMSI+APN is treated as "implicit detach + fresh attach per
  3GPP TS 23.402" — i.e., APN-scoped session identity is a first-class,
  tested concept in this codebase, not an incidental side effect.

**OPEN QUESTION (the single most important one in this whole plan)**:
none of the above is proof. The only way to know for certain is to repeat
the exact live test done on 2026-07-31 (real phone, `journalctl -f` across
CSCFs, direct SMF/UPF log inspection) against VectorCore ePDG once it's
installed. Do not consider this plan "validated" until that test has been
run and both APN sessions are confirmed to get *different* IPs.

### Other real, independent advantages (true regardless of the IP-collision question)

- **Single Go binary, single systemd unit** instead of two vendored builds
  (Erlang `osmo-epdg` + C `strongswan-epdg`, two separate `git clone`s, two
  separate build toolchains — see `vowifi-build.ts`). Go is already a
  guaranteed toolchain on this project's hosts (used for the MMS MM1
  MSISDN-injection proxy — see CLAUDE.md's MMS row).
- **No out-of-tree kernel module.** The current stack's `gtp_u_kmod`
  (Erlang NIF wrapping a custom kernel module) is a real host-compatibility
  risk across kernel versions. VectorCore's dataplane is XDP/TC eBPF,
  native to any Linux kernel ≥ 5.15 (this host runs 6.8.0). No module to
  rebuild per-kernel.
- **A real, documented, read-only admin API** (`/api/v1`, OpenAPI +
  Stoplight docs UI at `/docs`) exposing per-subscriber IKE/IPsec/S2b/bearer
  detail and BPF dataplane counters. This project already has a proxy
  pattern for exactly this shape of integration (`mmsApi.getAdmin` proxying
  VectorCore MMSC's own admin API in `mms-controller.ts`/`mms.ts`) — this
  can be copied near-verbatim, and gives a far richer live-status UI than
  the current VoWiFi page's `activeIkeSas` count.
- **The project's own example config file names Open5GS by name**:
  `pgw_discovery.dns_enabled` comment reads *"Disable for cores without DNS
  discovery (e.g. Open5GS)"* — direct evidence the vendor has already
  considered Open5GS as a target PGW, which meaningfully de-risks the PGW
  interop question (see §7 build config).
- **Same vendor as the already-integrated MMSC.** This project already
  vendors and trusts VectorCore's MMSC (`mms-controller.ts`, `ENABLE_MMS_MODULE`)
  and has already worked through one real VectorCore bug (the MM1 logging
  level / X-MSISDN header fix, see memory `mms-mm1-msisdn-header-injection-fix`).
  Some working familiarity with how this vendor documents and ships things
  already exists.

### Real, honest risks — do not gloss over these

- **Apache 2.0 for the ePDG, but AGPLv3 for the companion AAA server.**
  `vectorcore-ePDG` itself is Apache 2.0 (permissive, no concerns).
  `vectorcore-aaa` is **AGPLv3**, inherited from its `osmo-epdg` lineage
  (its `COPYING` file is the unmodified GNU AGPLv3 text). AGPLv3's network-use
  clause is a real licensing consideration if this project is ever
  distributed/hosted as a service rather than run privately — flag this to
  whoever owns that decision before shipping a build that bundles it. This
  project already vendors AGPL/GPL code (`osmo-epdg` itself, strongSwan),
  so this is not a new category of risk, just worth naming explicitly since
  it's a new binary being added, not a modification of an existing one.
- **Small, young project.** `vectorcore-ePDG`: 5 stars, created
  2026-06-13, most recent push 2026-07-28 (days before this plan was
  written). `vectorcore-aaa`: 0 stars, created 2026-05-20, last push
  2026-06-17. Both are real, maintained, well-documented, and have
  meaningful test suites (fuzz tests on IKEv2 payload parsing, Diameter AVP
  handling, GTP-U parsing) — but this is nowhere near the years of
  production telecom deployment behind `strongSwan`/`osmo-epdg`. Treat this
  as a beta-quality dependency, same trust tier as this project's own
  "alpha/beta" module labels (VoWiFi is already labeled "alpha,
  experimental" — that label should carry over, not be removed, even if
  this integration succeeds).
- **XDP on a `dummy` interface is unverified.** Every other core NF in this
  project (AMF, UPF, SMF, the *existing* ePDG) binds to a `dummy-*` NOARP
  virtual interface (see CLAUDE.md's `nsenter`/dummy-interface pattern).
  VectorCore's BPF dataplane requires an `xdp_interface` to attach XDP
  (downlink decap) and TC (uplink encap) programs to. XDP "generic" mode
  is SKB-based and documented as working on "any NIC," which *should*
  include dummy devices, but this project has never attached XDP to a
  dummy interface before now. **This must be verified as step one of
  implementation** (§7), before any deeper integration work, because if it
  doesn't work, the whole architecture needs a fallback (see §7's fallback
  note).
- **The admin API has zero authentication.** Per the vendor's own docs:
  "anyone who can reach `listen_address:listen_port` can read subscriber
  IMSIs, UE IPs, and SPIs." Must bind to `127.0.0.1` only, with this
  project's Node backend as the sole client (proxied through authenticated
  NMS endpoints), exactly like the MMS admin-proxy pattern already does for
  VectorCore MMSC's equally-unauthenticated admin API.
- **A second new PDN-address-allocation surface to test.** Even setting
  aside the specific bug this migration targets, swapping the entire ePDG
  stack is swapping the single most complex piece of the VoWiFi chain.
  Budget real live-phone test time, not just a config-generates-cleanly
  check.

---

## 2. DECISION: ship this as a selectable alternate backend, not a hard replacement

Mirrors the existing "SMS Delivery Mode" pattern (`ims`/`sgs` toggle in
`ims-controller.ts`/`sms-controller.ts`) rather than ripping out
`osmo-epdg`/`strongswan-epdg` outright.

**Reasoning**: VoWiFi has never worked end-to-end on this project regardless
of backend, so there is no working baseline to "protect" in the sense the
SMS toggle protects a known-good IMS path — but there *is* real, working,
hard-won infrastructure already in place (BIND9 DNS discovery, host
dummy-interface conventions, the install/configure/status lifecycle,
existing patches to `osmo-epdg`'s SWx layer) that a hard rip-and-replace
would throw away before the new stack is proven. A selector:

- Lets both stacks be installed side-by-side (mutually exclusive at
  runtime — only one bound to the shared VoWiFi virtual IP/port set at a
  time) so a regression on the new stack doesn't strand a user without a
  fallback to the old (currently non-functional, but actively being
  investigated separately) stack.
- Matches the project's own established convention for "two ways to do the
  same real thing, pick one" (SMS delivery mode; MMS's opt-in module flag).
- Gives a clean A/B path for the live-phone retest in §7's validation step:
  flip the toggle, re-run the same test, compare SMF/UPF logs directly
  against the existing 2026-07-31 baseline captured in §9.

If the VectorCore backend proves itself over real testing and the old stack
remains broken with no forthcoming fix, a later session can promote it to
the sole/default backend and deprecate `osmo-epdg`/`strongswan-epdg` — that
is an explicit *non-goal* of this plan, left for after real validation data
exists.

**New `.env` flag**: `ENABLE_VOWIFI_VECTORCORE_BACKEND` (default `false`,
opt-in) — separate from the existing `ENABLE_VOWIFI_MODULE` flag, which
continues to gate the VoWiFi page/feature as a whole. This lets an operator
build with VoWiFi enabled but the new backend still hidden, matching how
`ENABLE_MMS_MODULE` is a second, independent flag layered under a feature
that itself depends on IMS being enabled.

---

## 3. Component & architecture mapping

| Role | Current | VectorCore alternative |
|---|---|---|
| IKEv2 (SWu) | `strongswan-epdg` (charon, C, patched fork) | `vectorcore-ePDG` (native Go IKEv2 stack) |
| EAP-AKA proxy (SWm) | `osmo-epdg`'s built-in AAA glue (Erlang) | `vectorcore-aaa` (Erlang, forked from the same osmo-epdg AAA lineage) |
| SWx to HSS | `osmo-epdg` → `open5gs-hssd` at `127.0.0.8:3868` (already live, already proven working — confirmed by tonight's successful EAP-AKA) | `vectorcore-aaa` → same `open5gs-hssd:3868` endpoint. High confidence of drop-in compatibility since `vectorcore-aaa` is a direct fork of the exact Erlang SWx client code already proven against this exact HSS. |
| S2b GTPv2-C (PDN session) | `osmo-epdg`'s `epdg_gtpc_s2b.erl` → SMF at `127.0.0.4:2123` | `vectorcore-ePDG`'s native Go S2b client → same SMF endpoint |
| GTP-U dataplane | `gtp_u_kmod` (custom out-of-tree kernel module, Erlang NIF) | `vectorcore-ePDG`'s BPF/XDP+TC dataplane, kernel-native |
| PCO/APCO (DNS, P-CSCF delivery) | `strongswan-epdg` C plugin | `vectorcore-ePDG` native (`pco.request_pcscf_v4`, etc.) |
| ePDG DNS discovery zone (phone → ePDG) | `mnc001.mcc001.pub.3gppnetwork.org` zone, BIND9, unchanged | **Reused as-is** — no reason to change the discovery mechanism, only which binary answers on the resolved IP |
| Admin/status visibility | `swanctl`-derived `activeIkeSas` count only | Full read-only REST API (`/api/v1/clients`, `/sessions`, `/stats`, `/stats/bpf`) |

**DECISION**: reuse the exact same virtual IP (`10.0.1.180` on the existing
`dummy-epdg` interface) and the exact same DNS zone/record for both
backends, since only one backend is ever active at a time (§2). This avoids
touching BIND9 config or the DNS Migration Wizard's zone inventory at all —
switching backends is purely a host-service-lifecycle operation, invisible
to DNS. `writeListenOn`/`bind-controller.ts` are **not** touched by this
work (per CLAUDE.md rule 4 — no module should write BIND config directly
anyway; this plan doesn't need to).

**OPEN QUESTION**: whether `vectorcore-ePDG`'s GTP-U dataplane can bind
`local_gtpu`/`local_gtpc` to the same `10.0.1.180` dummy IP the existing
stack uses, or whether XDP's interface-level attachment (§1's risk item)
requires a differently-shaped interface. This is the first thing to test
(§7 step 1) before writing any config-generation code, because it may
change the IP/interface plan above.

---

## 4. New components to vendor and build

Following the exact pattern already established in `vowifi-build.ts`
(`git clone --branch <pinned tag> --depth 1`, apply idempotent patches,
compile, install to a runtime dir, verify binaries exist before returning
success):

### 4.1 `vectorcore-ePDG`

```
git clone --branch <PINNED_TAG> --depth 1 https://github.com/vectorcore-mobile/vectorcore-ePDG
cd vectorcore-ePDG
apt install -y clang llvm libbpf-dev   # BPF build deps, idempotent (matches existing apt-get patterns)
make generate   # compiles BPF C programs, requires clang/llvm/libbpf-dev
make            # builds bin/epdg (runs `make generate` first internally, but explicit is fine/idempotent)
install -m 755 bin/epdg /opt/vectorcore/epdg/bin/epdg
```

**DECISION**: pin to a specific release tag/commit SHA at implementation
time (mirroring `OSMO_EPDG_TAG`'s pattern — `VECTORCORE_EPDG_TAG` constant),
not `main`, for the same reason the existing code pins `osmo-epdg` to
`0.1.2` — reproducible builds, controlled upgrade path, staleness detection
(§6). At the time of writing there are no tagged releases visible via the
public API in a quick check; if none exist by implementation time, pin to
the exact commit SHA of `main` instead and treat any future move to a real
tag as a version bump, same as the existing `OSMO_EPDG_TAG` bump precedent
(`vowifi-osmo-epdg-0.1.2-version-bump-plan.md`).

Go toolchain requirement (1.22+) is already satisfied — CLAUDE.md
explicitly documents Go as "already a guaranteed toolchain on this
project's hosts" via the MMS MM1 proxy precedent. `clang`/`llvm`/
`libbpf-dev` are new apt packages this project has not installed before;
add them to the streaming-install apt-get line the same way `rtpengine`'s
PPA requirement was handled for IMS on Ubuntu 22.04 (see
`ims-install-script-ubuntu2204-fixes` memory) — i.e., verify availability
on both Ubuntu 22.04 and whatever the current baseline OS is before
shipping, don't assume.

### 4.2 `vectorcore-aaa`

```
git clone --branch <PINNED_TAG> --depth 1 https://github.com/vectorcore-mobile/vectorcore-aaa
cd vectorcore-aaa
apt install -y erlang rebar3   # already an existing apt dependency for osmo-epdg's own build — no new package
make clean && make build
install -m 755 _build/default/bin/vectorcore-aaa /opt/vectorcore/aaa/bin/vectorcore-aaa
```

No new Erlang toolchain dependency — `erlang`/`rebar3` are already
installed for the existing `osmo-epdg` build (`vowifi-build.ts` line ~87).

**Existing-patch review needed before first build**: this project already
carries at least one hand-verified patch against `osmo-epdg`'s AAA/SWx
handling (the "SWx callback never read the HSS-provided static IP" fix
referenced in `vowifi-build.ts` around line 124). Since `vectorcore-aaa` is
a fork of that exact lineage, **check whether the same bug (and the same
fix) is already present or already fixed upstream in `vectorcore-aaa`**
before assuming it needs re-patching — do not blindly re-apply a diff
written against a different fork without first diffing the actual source.

### 4.3 Runtime layout (matches vendor's own documented convention exactly — no adaptation needed)

```
/opt/vectorcore/epdg/bin/epdg
/opt/vectorcore/aaa/bin/vectorcore-aaa
/etc/vectorcore/epdg/epdg.yaml         (generated by this project, see §5)
/etc/vectorcore/epdg/{epdg.crt,epdg.key,ca.crt}   (generated once, see §5.3)
/etc/vectorcore/aaa/config.yaml         (generated by this project, see §5)
/var/log/vectorcore/epdg/epdg.log
/var/log/vectorcore/aaa/
```

This maps cleanly onto the existing `/etc/open5gs-nms/.vowifi-state.json`
state-tracking pattern — just add `vectorcore*`-prefixed keys alongside the
existing `epdgIp`/`s6bLocalIp`/`gsupPort` fields, don't create a parallel
state file.

---

## 5. Config generation

### 5.1 `vectorcore-aaa` config

Not fully documented in the README fetched for this plan (it references
`config/aaa.config`, an Erlang-native config format, rather than the YAML
shown for the ePDG) — **first real implementation task**: pull
`config/aaa.config`'s actual example content from the repo (same technique
used in this research pass — `curl` the raw file) and map its SWx-facing
fields onto this project's existing PLMN/HSS constants
(`epc.mnc001.mcc001.3gppnetwork.org`, `127.0.0.8:3868`) the same way
`smscMainCfg()`/`icscfDiameterXml()` map PLMN constants into Kamailio
templates today. Do not guess at this format without reading the real file
first — Erlang config syntax has sharp edges (this project has already been
burned once this general area, see the mcc/mnc YAML-1.1-octal corruption
bug class in `plmn-migration-wizard` memory — a different language/format,
but the lesson "read the real serialization, don't hand-assume" applies
directly).

### 5.2 `vectorcore-ePDG`'s `epdg.yaml` — concrete field mapping

Based on the real schema fetched for this plan:

| VectorCore field | Value in this project | Source |
|---|---|---|
| `epdg.name` | `epdg.epc.mnc001.mcc001.3gppnetwork.org` | Same FQDN the existing DNS discovery zone already serves |
| `epdg.realm` | `epc.mnc001.mcc001.3gppnetwork.org` | Existing PLMN constant |
| `epdg.mcc` / `epdg.mnc` / `epdg.mnc_length` | `001` / `01` / `2` | Existing PLMN constant |
| `ikev2.cert_file`/`key_file`/`ca_file` | New self-signed cert, generated once during Install (see §5.3) | N/A — new artifact |
| `swm.local_addr` | `10.0.1.180` (existing dummy-epdg IP) | Reused from current VoWiFi config |
| `swm.peer_addr` / `peer_port` | `127.0.0.1` (or wherever `vectorcore-aaa` binds) / `3868` | New — `vectorcore-aaa`'s own listen address, not the HSS directly (ePDG talks SWm to the AAA, not SWx to the HSS directly) |
| `swm.proto` | `sctp` (matches existing `dia_swx_proto`) | Already proven working on this host |
| `swm.origin_host` / `origin_realm` | `epdg.epc.mnc001.mcc001.3gppnetwork.org` / `epc.mnc001.mcc001.3gppnetwork.org` | Existing PLMN constant |
| `swm.destination_realm` | `epc.mnc001.mcc001.3gppnetwork.org` | Existing PLMN constant |
| `gtp.local_gtpc` / `local_gtpu` | `10.0.1.180` (pending §1's XDP-on-dummy-interface verification — see fallback note below) | Reused |
| `gtp.pgw_gtpc` | `127.0.0.4` (SMF's existing GTP-C listener — confirmed live via `ss -ulnp` during tonight's investigation) | Existing, already proven reachable |
| `gtp.mtu` | `1400` (matches `ogstun`'s existing MTU) — **but see §7's note on whether VoWiFi traffic should even route via `ogstun` going forward** | Existing |
| `pgw_discovery.dns_enabled` | `false` | The vendor's own example config explicitly calls out disabling this for Open5GS — **follow the vendor's own guidance literally, do not second-guess it** |
| `apn.default` | `ims` | Matches the vendor's own example; this project's VoWiFi use case is IMS-only (no general "internet" access is expected to route through the ePDG — see §7's note on whether to suppress the `internet` APN attach entirely, same open question that applies to the current stack) |
| `pco.request_pcscf_v4` | `true` | P-CSCF delivery is the entire point of this integration |
| `pco.request_dns_v4` | `true` | Matches current behavior (phone receives `8.8.8.8`/`8.8.4.4` today) |
| `bpf.xdp_interface` | **Unresolved — depends on §1/§7's XDP verification** | N/A |
| `api.enabled` | `true` | Needed for the admin-proxy UI (§9) |
| `api.listen_address` | `127.0.0.1` | Per vendor's own security guidance — no auth on this API |
| `api.listen_port` | `8080` (or any free local port — check for collision with existing services before hardcoding) | New |

### 5.3 Certificates

New requirement this project hasn't had before: `strongswan-epdg` did not
require the ePDG to present an X.509 cert to the UE the same way
(`ikev2.cert_file` is a hard requirement — "the binary will not start
without it"). **DECISION**: generate a self-signed CA + ePDG cert during
Install, following the exact procedure documented in the vendor's own
README (already copy-pasteable `openssl` commands), using the same
`nginx/setup-sas-cert.sh` self-signed-cert pattern this project already
uses for `sas.crt`/`acs.crt` — idempotent, regenerate only if missing,
`CN`/SAN set to the ePDG FQDN. **OPEN QUESTION**: real UEs will not trust a
self-signed CA by default for IKEv2 server authentication — this may work
fine for lab/dev testing (same tier as this project's existing
self-signed SAS/ACS certs, which real Sercomm/Baicells radios already
accept in this deployment's specific configuration) but should be flagged
to the user as a real limitation before assuming a random consumer phone
will accept it without an explicit trust step. This is a materially
different trust model than the current `strongswan-epdg` stack, which this
plan should not silently paper over.

---

## 6. Backend implementation (this repo)

New file: `backend/src/interfaces/rest/vowifi-vectorcore-controller.ts`,
mirroring the shape of every other optional-module controller (per
CLAUDE.md's "every `*-controller.ts` file that manages an optional module
follows this same shape" rule):

- `POST /api/vowifi/vectorcore/install` — streamed apt-get (clang/llvm/
  libbpf-dev) + the two `git clone`/build steps from §4, chunked
  transfer-encoding response (needs adding to `nginx.conf`'s long-timeout
  regex location per CLAUDE.md rule 5 — `^/api/(...)vowifi/vectorcore(...)`
  needs to join the existing list).
- `POST /api/vowifi/vectorcore/configure` — writes `epdg.yaml` +
  `aaa.config` from templates (§5), generates certs if missing (§5.3),
  writes/updates `.vowifi-state.json` with `vectorcoreConfiguredWithVersion`
  etc., following the exact `configuredWithVersion`/`configStale` pattern
  already used by IMS and MMS.
- `POST /api/vowifi/vectorcore/start` / `/stop` / `/restart` — `systemctl`
  via the standard `nsenter` `IHostExecutor` pattern, two new units
  (`vowifi-vectorcore-epdg.service`, `vowifi-vectorcore-aaa.service`).
- `POST /api/vowifi/vectorcore/activate` — the actual backend-switch
  action: stops `vowifi-charon`/`vowifi-osmo-epdg` if running, starts the
  two new VectorCore units. **Must be mutually exclusive** — never let both
  backends bind port 500/4500 on the same IP simultaneously (systemd
  `Conflicts=`/`After=` directives between the four units, enforced at the
  unit-file level, not just left to the controller's own logic, so a manual
  `systemctl start` can't accidentally double-bind either).
- `GET /api/vowifi/vectorcore/status` — mirrors the existing
  `/api/vowifi/status` shape (`installedOnDisk`, `builtWithVectorcoreTag`,
  `buildStale`, `configured`, `running`, `services: {...}`,
  `activeBackend: 'osmo-epdg' | 'vectorcore'`).
- `GET /api/vowifi/vectorcore/admin/*` — thin authenticated proxy into the
  real `/api/v1/*` admin API on `127.0.0.1:8080`, **copied directly from
  `mms-controller.ts`'s existing `getAdmin` proxy pattern** (same
  reasoning: the upstream API has no auth of its own, this project's own
  session auth is the only gate). Map `/api/vowifi/vectorcore/admin/clients`
  → `/api/v1/clients`, etc. — don't reinvent, just repoint the existing
  pattern at a new upstream base URL.

**DECISION**: keep this as a *separate* controller file rather than folding
it into the existing `vowifi-controller.ts`. The existing file already
manages a full independent lifecycle (install/configure/start/stop for
`osmo-epdg`+`strongswan-epdg`); cramming a second, parallel lifecycle into
the same file would make it unreadable. A thin shared
`vowifi-shared.ts` (or similar) can hold genuinely shared pieces — the DNS
zone functions (`pubEpdgDomain`/`pubEpdgZoneFile`, unchanged, reused by
both backends per §3) and the `.vowifi-state.json` read/write helpers.

---

## 7. Validation plan — do not skip any of this

This is the part of the plan that actually matters most, given §1's central
open question.

**Step 0 (before writing any integration code)**: on a disposable/test host
or a spare interface on the dev host, manually confirm XDP "generic" mode
attaches successfully to a `dummy` interface (`ip link add dummy-test type
dummy && ip link set dummy-test up`, then attempt to load a minimal XDP
program against it — even a no-op `xdp-loader`/`bpftool` test is enough to
answer yes/no). This gates the entire `bpf.xdp_interface` question in §5.2
and should happen before any config-generation code is written, not after.
**Fallback if XDP-on-dummy doesn't work**: `vectorcore-ePDG` may need a real
routable interface for its GTP-U path even though every other NF in this
project uses dummy interfaces — in that case, plan B is binding
`gtp.local_gtpu`/`bpf.xdp_interface` to the host's real LAN-facing
interface (`ens20`, per tonight's investigation) with a dedicated port,
rather than the shared dummy-interface mesh. This is a real architecture
fork in the plan depending on step 0's answer — don't commit to §3's IP
reuse decision until this is answered.

**Step 1**: build and install both new components per §4, configure per
§5, start them, and confirm — via the same technique already proven
tonight — that the IKEv2/EAP-AKA handshake completes with a real phone (or,
if no phone is available at implementation time, a synthetic IKEv2 client;
`strongSwan`'s own `charon` in initiator mode, run from a second host/netns,
is a reasonable synthetic substitute for this specific layer since it's
just standards-compliant IKEv2, not the SIP layer).

**Step 2 — the actual bug-fix confirmation**: with a real phone (this
step cannot be meaningfully faked), repeat the *exact* observation method
used on 2026-07-31:
```
journalctl -u open5gs-smfd -u open5gs-upfd --since <attach-time> | grep -iE "IMSI\[...\]|F-SEID"
```
Confirm the `internet` and `ims` (or whatever APN set the phone actually
requests) PDN sessions get **different** IPv4 addresses. If they still
collide, the bug is not ePDG-side at all — it would point at SMF's own PAA
pool allocator (Open5GS core, shared by every NF), which is a much bigger,
riskier fix than anything in this plan, and should stop the VectorCore
integration from being declared a fix until that's separately triaged.

**Step 3**: confirm SIP REGISTER actually completes end-to-end (200 OK,
contact visible in S-CSCF usrloc) — the original user-facing symptom this
whole investigation started from. IKE + distinct IPs alone are necessary
but not sufficient; don't declare victory before this step.

**Step 4**: real audio/call test, matching the bar already established for
direct-IMS and PSTN-gateway VoWiFi work elsewhere in this project (memory:
`ims-ue-to-ue-calling-investigation`, `pstn-rtpengine-b2bua-dual-dialog-fix`)
— a registered-but-untested UE is not the same as a working feature.

---

## 8. Frontend implementation

Add a new sub-tab to the existing `VoWiFiPage.tsx` (do not create a
separate top-level nav entry — matches the existing MMS-as-a-tab-not-a-page
precedent) — e.g. "ePDG Backend" tab, alongside whatever the current
page's tab structure is:

- A backend selector (radio/segmented control: "osmo-epdg (current)" vs
  "VectorCore (experimental)"), disabled/hidden entirely unless
  `ENABLE_VOWIFI_VECTORCORE_BACKEND` is set at build time (same
  `.env`-gated conditional-render pattern as every other optional module).
- Install / Configure / Start / Stop / Restart buttons for the VectorCore
  stack, identical control layout to the existing VoWiFi page's controls
  for the current stack — same component, parameterized by backend, not a
  visually distinct new design (per CLAUDE.md's UI layout convention:
  consistency over novelty).
- A staleness banner matching the `configStale`/`installStale` pattern
  already used by IMS/MMS.
- **A live session/status panel backed by the new admin-proxy endpoints**
  (§6) — this is a genuine net-new capability the current stack can't
  offer at all: a real table of attached subscribers (IMSI, UE IP, APN,
  IKE/CHILD SA state) sourced from `/api/vowifi/vectorcore/admin/clients`,
  and the BPF/GTP-U/IPsec counters from `/stats/bpf`, `/stats/gtpu`,
  `/stats/ipsec`. This is a materially better debugging surface than
  anything currently available for VoWiFi and worth building even if the
  backend swap alone doesn't ship — consider building this panel first as
  a way to *observe* the existing bug more easily on the current stack too,
  if a quicker win is wanted before the full backend swap lands.

---

## 9. CHANGELOG / versioning

Bump `backend/package.json`/`frontend/package.json` and add a
`CHANGELOG.md` entry only once real code lands — this document itself is a
plan, not a shipped change, and per this project's own convention
("Only commit when explicitly asked," "don't assume 'the fix works' means
'commit it'") should not be treated as done until implemented and tested
per §7.

---

## 10. Phased effort estimate

| Phase | Work | Rough effort |
|---|---|---|
| 0 | XDP-on-dummy-interface feasibility check (§7 step 0) | 1-2 hours |
| 1 | `vectorcore-aaa` config format research (pull real `config/aaa.config`, map PLMN fields) | 1 hour |
| 2 | `vowifi-vectorcore-controller.ts` — install/configure/start/stop/status, systemd units, nginx timeout regex update | 3-5 hours |
| 3 | Cert generation flow (§5.3) | 1 hour |
| 4 | Admin-proxy endpoints (§6, copied from MMS pattern) | 1-2 hours |
| 5 | Frontend tab (§8), including the new live-status panel | 3-4 hours |
| 6 | Validation (§7 steps 1-4), real phone required | Unbounded — depends entirely on live-test outcomes; budget at least one full focused session, possibly several if step 2's bug-collision re-check fails and points back at SMF |

Total *implementation* effort before real-phone validation: roughly one
full working session (8-10 hours). Validation could be much faster (a
couple of hours if everything just works) or could reopen a much bigger
investigation (if §7 step 2 shows the collision persists and the fault is
actually in SMF's own PAA allocator, not the ePDG stack).

---

## 11. Summary of assumptions made without user input (per explicit instruction)

Listed together here for a fast one-pass review:

1. Ship as a selectable alternate backend, not a replacement (§2).
2. Reuse the existing DNS zone/FQDN/virtual IP for both backends,
   mutually exclusive at runtime (§3).
3. Pin to a specific tag/commit for both new repos, same as the existing
   `OSMO_EPDG_TAG` convention (§4.1).
4. New `.env` flag `ENABLE_VOWIFI_VECTORCORE_BACKEND`, independent of the
   existing `ENABLE_VOWIFI_MODULE` (§2).
5. `apn.default: ims`, `pgw_discovery.dns_enabled: false` — followed the
   vendor's own documented guidance for Open5GS cores literally, did not
   second-guess it (§5.2).
6. Self-signed cert generation using the same pattern as the existing
   nginx SAS/ACS certs, flagged as a real UE-trust limitation, not silently
   assumed to "just work" on a real consumer phone (§5.3).
7. Separate controller file rather than extending `vowifi-controller.ts`
   (§6).
8. New tab on the existing VoWiFi page, not a new top-level nav entry (§8).
9. The whole plan is explicitly contingent on §7 step 2's live
   re-verification — if the IP-collision bug turns out to be SMF-side
   rather than ePDG-side, this entire integration would not fix the
   original reported problem, and that must be checked early, not assumed.
