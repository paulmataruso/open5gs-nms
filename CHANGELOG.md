# Open5GS NMS - Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — 2026-04-22

### Added

#### RAN Network Page — 5G Section
- New **5G NR** section on the RAN Network page with N2 and N3 interface cards, mirroring the existing 4G EPC layout
- **N2 Interface card** — shows connected gNodeB IPs (SCTP port 38412, AMF-bound, sourced from `netstat`)
- **N3 Interface card** — shows connected gNodeB transport IPs (GTP-U port 2152, UPF-bound, sourced from `tshark`)
- Section headers with generation badges (`4G EPC` purple / `5G NR` teal) and divider lines
- Refactored into a reusable `InterfaceCard` component — all four cards (S1-MME, S1-U, N2, N3) share the same component
- **Generation column** added to the Active UE Sessions table — each session shows a `4G` or `5G` badge; header shows separate 4G/5G session counts

#### 5G Active UE Session Detection (tshark-based)
- `getActive5GUEs()` — fully replaced placeholder with real tshark-based detection:
  1. Read UPF GTP-U IP from `upf.yaml` and verify it exists on a host interface
  2. Auto-detect the network interface that owns that IP (`ip -4 addr show`)
  3. Run `tshark -i <iface> -f "udp port 2152 and (host <upf-ip>)" -c 100 -a duration:3` (bounded: 100 packets or 3 seconds)
  4. Parse `ip.src` — second comma-separated value is the inner GTP UE IP
  5. For each unique UE IP, look up IMSI in MongoDB subscriber database
  6. Only return UEs with positive correlation (IP in tshark AND IMSI in database)
- `getActive4GUEs()` — conntrack-based (unchanged), but now deduplicates against the 5G list: any IMSI already detected via tshark is excluded so the same subscriber never appears in both boxes
- `tshark` added to the backend Dockerfile runtime dependencies
- `tshark` added to `INSTALL.md` system prerequisites

#### N3 Interface Status (tshark-based)
- `checkN3()` replaced conntrack approach with tshark — captures GTP-U traffic on the UPF interface, extracts outer source IPs (first element of `ip.src`) as the gNodeB transport addresses
- Interface auto-detected from UPF GTP-U IP — no hardcoded interface names
- No longer filters out dual-mode radios from N3 card (a radio that does both 4G S1-U and 5G N3 is a genuine N3 connection and should appear in both cards)

#### S1-U Interface Status Fix
- `checkS1U()` now filters conntrack to `dst=<sgwu-ip>` — only traffic destined for the SGW-U is 4G S1-U
- SGW-U IP read from `sgwu.yaml` and verified against host interfaces (same pattern as all other IP verification)
- Host IPs excluded from results — eliminates internal core-to-core traffic (e.g. UPF→SGW-U on the same server) appearing as fake eNodeBs

#### Configuration Editor Improvements
- **AMF PLMN Support** — multi-slice S-NSSAI per PLMN: each PLMN block now has Add/Remove slice buttons; each slice has SST + optional SD side-by-side with left-border accent; explanatory note added
- **SMF Info block** — new "SMF Info (Slice Selection)" section: add/remove info entries, slices within entries (SST + SD), and DNNs within slices; empty state shown when no `info` block exists with instructions
- **NSSF NSI Clients** — full rewrite: flat list of URI+SST+SD entries (matching Open5GS docs), add/remove entries, SD live preview showing quoted output, proper empty state
- **SD quoting** — `yaml-config-repository.ts` post-processing now correctly enforces `sd: "000001"` (double-quoted) for all NFs; MCC/MNC remain unquoted. Load path also handles reading back quoted SD values
- `fixMccMncFromRawYaml` renamed to `fixMccMncSdFromRawYaml` and updated to match both bare and quoted SD patterns on read

#### Auto-Config NAT Persistence
- `auto-config.ts` NAT configuration now persists across reboots:
  - IP forwarding written to `/etc/sysctl.d/99-open5gs-nat.conf` (read by kernel on boot) instead of ephemeral `sysctl -w`
  - `netfilter-persistent save` called after setting iptables rules — saves to `/etc/iptables/rules.v4` and `rules.v6` which `iptables-persistent` restores on boot

### Fixed

- **S1-U showing 5G core IPs** — old conntrack command had no IP binding, picked up all UDP/2152 traffic including internal UPF↔SGW-U traffic; now filtered to SGW-U destination only, with host IPs excluded
- **N3 showing inactive** — old conntrack approach incorrectly filtered out gNodeB IPs that also appeared in S1-U results; tshark now used exclusively for N3 with no dual-mode filtering on the interface card
- **4G/5G UE session deduplication** — same IMSI can no longer appear in both Active 4G and Active 5G session boxes; tshark (5G) takes priority, conntrack (4G) subtracts any already-claimed IMSIs
- **SD values** — YAML output now correctly writes `sd: "000001"` with quotes; loading correctly strips quotes when reading back
- **NSSF NSI SST-only entries** — old editor only showed SST, no SD field; now full URI+SST+SD per entry with add/remove

### Changed

- **RAN Network page** — restructured into labelled 4G/5G sections; `InterfaceCard` reusable component; Active UE Sessions table gains Generation column
- **`getActive4GUEs()`** — now a true 4G-only result by subtracting 5G-confirmed IMSIs
- **`checkS1U()`** — bound to SGW-U verified IP, host IPs excluded
- **`checkN3()`** — replaced conntrack with tshark; no dual-mode filtering on interface card level
- **`yaml-config-repository.ts`** — full rewrite to clean ASCII, split SD/MCC/MNC post-processing, SD always quoted on write

---

## [1.2.1] - 2026-04-20

### Fixed — MME SGs-AP Configuration

#### Root Cause
The `MmeEditor.tsx` component was broken in two ways that caused the MME to fail to start after applying config via the NMS:

1. **Wrong `map` structure** — The editor was building `map` as an array (`map: [{ tai, lai }]`) but Open5GS MME expects `map` as a plain object (`map: { tai, lai }`). This produced invalid YAML that the MME config parser rejected at startup with a fatal assertion failure.

2. **Broken JSX** — The component file had import statements and code fragments tangled inside JSX return blocks, with a dangling IIFE `{(() => { ); })()}` that would crash the React render entirely. The SGs-AP section was completely non-functional.

#### Changes

**`frontend/src/components/config/editors/MmeEditor.tsx`** — Full rewrite of the SGs-AP section:
- `map` is now always a plain object `{ tai: {...}, lai: {...} }` matching Open5GS YAML spec
- Added `defaultMap()` factory function returning the correct shape
- Replaced broken `updateMappingField` with clean `updateMapField` helper
- Added `hasRealMap` / `mapVal()` logic: TAI/LAI fields show grey placeholder text when no data has been saved yet, white text only when real values exist
- Added inline yellow warning banner when a hostname (FQDN) is entered as the MSC/VLR address, explaining that Open5GS MME calls `getaddrinfo()` at startup and will abort with a fatal error if DNS cannot resolve the hostname at that moment

**`backend/src/domain/entities/mme-config.ts`** — Added missing `sgsap` field to the `MmeConfig` TypeScript interface with correct shape (`map` as object, not array)

**`frontend/src/data/tooltips/mme.ts`** — Updated `sgsap_server_address` tooltip to document the DNS-at-startup behaviour and recommend using IP addresses

#### Behaviour Notes
- Using an IP address (real or placeholder like `1.1.1.1`) for the MSC/VLR address: MME starts successfully, logs a warning if the address is unreachable — this is normal and expected
- Using an unresolvable hostname: MME aborts at startup — this is Open5GS behaviour, not an NMS bug. The UI now warns the user before they apply

---

## [1.2.0] - 2026-04-18

### Added — Authentication

#### Web UI Login
- **Session-based authentication** — All pages and API endpoints now require login
- **Login page** — Clean login form matching NMS dark theme, accessible at the root URL when unauthenticated
- **Persistent sessions** — Sessions survive page refresh and browser restarts (24-hour default lifetime, configurable)
- **Auto-logout on session expiry** — Page redirects to login when a session expires mid-use
- **Logout button** — User avatar and logout button added to the bottom of the sidebar

#### Backend Auth Infrastructure
- **Lucia v3 session management** — HttpOnly cookie-based sessions with rolling expiry
- **SQLite user/session database** — Separate from Open5GS MongoDB; stored at `/app/data/auth.db` in the container, persisted via Docker volume `./data:/app/data`
- **bcrypt password hashing** — Cost factor 10 via `oslo/password`
- **Timing-safe login** — bcrypt verify runs even on missing usernames to prevent user enumeration
- **Rate limiting on login** — 10 attempts per 15 minutes per IP (uses existing `express-rate-limit` dependency)
- **First-run admin seeding** — On first startup with no users, admin account is created automatically (see [First Login](#first-login))

#### New API Endpoints
- `POST /api/auth/login` — Authenticate and receive session cookie (public, rate-limited)
- `POST /api/auth/logout` — Invalidate session and clear cookie (requires session)
- `GET /api/auth/me` — Return current user info (requires session)
- `GET /api/health` — Remains public (used by Docker healthcheck)

#### New Environment Variables
- `AUTH_DB_PATH` — Path to SQLite auth database inside container (default: `/app/data/auth.db`)
- `SESSION_MAX_AGE` — Session lifetime in seconds (default: `86400` = 24 hours)
- `FIRST_RUN_PASSWORD` — Set initial admin password on first deploy; if empty, a random password is printed to container logs
- `COOKIE_SECURE` — Set to `true` only when serving over HTTPS; default `false` (plain HTTP deployments work out of the box)

### Changed
- `docker-compose.yml` — Added `./data:/app/data` volume mount for auth database persistence
- `backend/Dockerfile` — Added `python3`, `make`, `g++` to builder stage for `better-sqlite3` native compilation; switched to `npm prune` pattern to carry compiled binary to runtime stage
- All existing API routes now require a valid session cookie

### Security
- Session cookies are `HttpOnly` (not accessible to JavaScript)
- `SameSite=lax` prevents CSRF on cross-site navigations
- `Secure` flag controlled by `COOKIE_SECURE` env var — must be `true` when behind HTTPS
- Login endpoint rate-limited to prevent brute force
- Generic error message on failed login (never reveals which field was wrong)
- Auth data kept entirely separate from Open5GS MongoDB

### Removed
- "No authentication" warning from README security section (auth is now implemented)

---

## [1.1.0] - 2026-04-14

### Added - Docker Container Logging

#### Docker Log Streaming
- **Docker Container Log Viewing** - View logs from NMS Docker containers in real-time
  - New "Log Source" toggle in Unified Logs page (Open5GS | Docker)
  - Stream logs from all 3 NMS containers (backend, frontend, nginx)
  - Real-time log streaming via WebSocket with same features as Open5GS logs
  - Automatic container discovery and listing

#### Enhanced Logging Configuration
- **Verbose Docker Logging** - Enhanced terminal output when running `docker compose up`
  - Increased log rotation limits (50MB per file, 5 rotation files)
  - Timestamped log entries for better debugging
  - Container labels for log identification

#### Backend Enhancements
- **Docker Log Executor** - New infrastructure layer for Docker command execution
  - Stream logs from containers using `docker logs -f --timestamps`
  - Parse Docker log format (ISO 8601 timestamps)
  - List NMS containers dynamically

- **Docker Log Streaming Use Case** - Application layer orchestration
  - Get recent logs from multiple containers
  - Unified log entry format across Open5GS and Docker sources
  - Clean Architecture implementation with dependency injection

- **WebSocket Log Handler Enhancement** - Extended to support multiple log sources
  - Source parameter ('open5gs' | 'docker') in WebSocket messages
  - Dual stream support (can stream both Open5GS and Docker simultaneously)
  - Backward compatible with existing Open5GS log streaming

- **REST API** - New Docker endpoints
  - `GET /api/docker/containers` - List all NMS containers
  - `GET /api/docker/logs/:container` - Get recent logs from specific container

#### Frontend Enhancements
- **Enhanced Logs Page UI**
  - New "Log Source" selector with Open5GS and Docker options
  - Dynamic service/container list based on selected source
  - Color-coded log badges (cyan for Docker containers)
  - Adaptive button labels ("All Containers" vs "All Services")
  - Loading indicator when fetching container list

- **useLogStream Hook Enhancement**
  - New `source` parameter to specify log source
  - Automatic subscription management for different sources
  - Seamless switching between Open5GS and Docker logs

#### Infrastructure
- **Docker Socket Mount** - Backend container now mounts Docker socket (read-only)
  - Enables Docker CLI commands from within backend container
  - Maintains security with read-only access

### Technical Details
- Clean Architecture implementation across all new code
- Follows existing TypeScript coding patterns and conventions
- Full type safety with interfaces for domain layer
- Dependency injection for all use cases
- Comprehensive error handling and logging
- Non-breaking changes (backward compatible with v1.0)

---

## [1.0.0] - 2026-03-23

### Added - Initial Public Release

#### Core Features
- **Complete Network Function Management** - Configure all 16 Open5GS network functions (5G Core + 4G EPC)
  - 5G Core: NRF, SCP, AMF, SMF, UPF, AUSF, UDM, UDR, PCF, NSSF, BSF
  - 4G EPC: MME, HSS, PCRF, SGW-C, SGW-U

- **Visual Network Topology** - Interactive JointJS-based topology visualization
  - Real-time service status indicators
  - Manual waypoint routing for professional diagrams
  - Interface status display (S1-MME, S1-U)
  - Active UE session monitoring

- **Configuration Management**
  - Dual editor modes: Form-based with tooltips + Monaco YAML editor
  - Real-time validation with Zod schemas
  - Cross-service dependency checking
  - Safe apply workflow with automatic backups
  - Ordered service restart respecting dependencies
  - Automatic rollback on failure

- **Subscriber Management**
  - Full CRUD operations via MongoDB
  - SIM Generator with country-based MCC selection (65+ countries)
  - Auto-provision generated SIMs to database
  - Sequential and random IMSI generation
  - Pagination and search functionality

- **SUCI/5G Privacy Key Management**
  - Generate home network public/private keypairs
  - Support for Profile A (X25519) and Profile B (secp256r1)
  - Public key display and export for eSIM provisioning
  - Automatic UDM configuration updates

- **Service Management**
  - Real-time systemd service monitoring via WebSocket
  - Start/stop/restart individual services
  - Bulk operations (start all, stop all, restart all)
  - Service health indicators and dependency awareness

- **Real-Time Monitoring**
  - Live service logs via WebSocket streaming
  - Per-service log filtering
  - Real-time service status updates
  - Active UE sessions with IP-to-IMSI correlation

- **Auto-Configuration Wizard**
  - One-click network setup for 4G and 5G
  - Preview YAML changes before applying
  - Optional NAT configuration with iptables
  - Smart defaults from current Open5GS configuration

- **Backup & Restore**
  - Automatic timestamped backups before every change
  - Configuration file backups (all 16 YAML files)
  - MongoDB subscriber database backups
  - Selective restore with diff preview
  - Restore to factory defaults

- **Comprehensive Tooltip System**
  - 150+ tooltips covering all configuration fields
  - Contextual help for every input field
  - Technical documentation integrated into UI

- **Audit Logging**
  - Complete audit trail of all system actions
  - Configuration changes logged with diffs
  - Service management actions tracked
  - Subscriber modifications logged
  - File-based JSON logging

#### Architecture & Technology

**Frontend:**
- React 18.2 with TypeScript 5.3
- Vite 5.0 build tooling
- TailwindCSS 3.4 for styling
- Zustand 4.4 for state management
- JointJS 3.7 for topology visualization
- Monaco Editor 4.6 for YAML editing
- Axios for HTTP client

**Backend:**
- Node.js 20 LTS with TypeScript 5.3
- Express 4.18 REST API
- Clean Architecture pattern (Domain → Application → Infrastructure → Interface)
- Zod 3.22 for runtime validation
- MongoDB Native Driver 6.3
- WebSocket (ws) 8.16 for real-time updates
- Pino 8.17 for structured logging
- async-mutex for safe concurrent operations

**Infrastructure:**
- Docker multi-stage builds
- Docker Compose orchestration
- nginx reverse proxy
- Host network mode for systemd integration
- Privileged container for service management

### Fixed
- Number type conversion for MCC/MNC fields
- Service status check retry logic (5 attempts for MME)
- YAML comment preservation in text editor
- Cross-service validation improvements
- DNS resolution issues in Docker builds

### Security
- Helmet middleware for HTTP security headers
- CORS configuration
- Rate limiting (100 req/15min per IP)
- Input validation with Zod schemas
- Mutex-locked configuration applies
- Automatic rollback on failures

---

## Release Information

**Tested Platform:** Ubuntu 24.04 LTS  
**Supported Open5GS Version:** 2.7.0+  
**License:** MIT  
**Docker Required:** Engine 24.0+, Compose v2.20+

---

## Upgrade Notes

This is the initial public release. Future upgrade instructions will be provided here.

---

## Known Limitations

- No multi-user management UI (add/remove users) — admin account only in v1.2
- No password change UI — requires recreating the auth database
- No HTTPS/WSS — nginx SSL termination recommended for internet-exposed deployments (set `COOKIE_SECURE=true`)
- Single-host deployment only
- js-yaml strips YAML comments on write operations
- Requires privileged Docker container for systemctl access

---

## Future Roadmap

See [GitHub Issues](https://github.com/YOUR_ORG/open5gs-nms/issues) for planned features and enhancements.

**High Priority:**
- Multi-user management UI (add/remove users, change passwords)
- Role-based access control (RBAC)
- HTTPS/WSS support
- Enhanced backup scheduling
- Multi-host deployment support
- Supporting open5gs running on docker

**Medium Priority:**
- Prometheus metrics integration
- Git-based configuration versioning
- Osmocom-CNI Module

**Long Term:**
- Create new webUI module to configure all components of the Osmocom-CNI stack
- Be able to manage 5G roaming via GUI(Add, deploy H-PLMN and V-PLMN)
- Manage via webUI the ".3gppnetwork.org" DNS components.
- Enable and configure Sg interface towards external MSC for SMS over Sg via webUI
- Enable easy Static IP for UE without NAT. Most likely via OSPF/BGP BIRD/FRR/etc


---

[1.0.0]: https://github.com/YOUR_ORG/open5gs-nms/releases/tag/v1.0.0
