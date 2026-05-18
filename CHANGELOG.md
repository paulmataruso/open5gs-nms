# Changelog

All notable changes to open5gs-nms are documented here.

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
