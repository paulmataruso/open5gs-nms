# Changelog

All notable changes to open5gs-nms are documented here.

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
