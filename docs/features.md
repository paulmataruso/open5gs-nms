# Feature Documentation

Detailed documentation for all Open5GS NMS features.

---

## Table of Contents

1. [Configuration Management](#configuration-management)
2. [SEPP (Security Edge Protection Proxy)](#sepp-security-edge-protection-proxy)
3. [DNS/FQDN Migration Wizard](#dnsfqdn-migration-wizard)
4. [Network Topology Visualization](#network-topology-visualization)
5. [Subscriber Management](#subscriber-management)
6. [eSIM Generator (Simlessly API)](#esim-generator-simlessly-api)
7. [SIM Generator](#sim-generator)
8. [SUCI Key Management](#suci-key-management)
9. [Service Management](#service-management)
10. [Auto-Configuration Wizard](#auto-configuration-wizard)
11. [Real-Time Logging](#real-time-logging)
12. [Backup & Restore](#backup--restore)
13. [Audit Trail](#audit-trail)
14. [IMS / VoLTE](#ims--volte)
15. [VoWiFi (ePDG)](#vowifi-epdg)
16. [SMS over SGs](#sms-over-sgs)
17. [UE Validation](#ue-validation)

---

## Configuration Management

Manage all 17 Open5GS network function configurations through a unified interface.

### Supported Network Functions

**5G Core (12 NFs):**
- NRF - NF Repository Function
- SCP - Service Communication Proxy
- AMF - Access and Mobility Management Function
- SMF - Session Management Function
- UPF - User Plane Function
- AUSF - Authentication Server Function
- UDM - Unified Data Management
- UDR - Unified Data Repository
- PCF - Policy Control Function
- NSSF - Network Slice Selection Function
- BSF - Binding Support Function
- SEPP - Security Edge Protection Proxy (roaming/N32 — see [dedicated section](#sepp-security-edge-protection-proxy) below)

**4G EPC (5 NFs):**
- MME - Mobility Management Entity
- HSS - Home Subscriber Server
- PCRF - Policy and Charging Rules Function
- SGW-C - Serving Gateway Control Plane
- SGW-U - Serving Gateway User Plane

### Editor Modes

**Form Mode (Default):**
- Structured input fields for every configuration parameter
- 150+ contextual tooltips explaining each field
- Real-time validation with error highlighting
- Organized into logical sections

**Text Mode:**
- Monaco-based YAML editor
- Syntax highlighting
- Line numbers and folding
- Direct YAML editing for advanced users

### Safe Apply Workflow

When you click "Apply Configuration":

1. **Validation** - Zod schemas validate all inputs
2. **Cross-Service Checks** - Verify NRF URIs, PFCP addresses, PLMN IDs
3. **Automatic Backup** - Creates timestamped backup in `/etc/open5gs/backups/`
4. **Write Configs** - Updates YAML files (preserves comments in text mode)
5. **Ordered Restart** - Services restart in dependency order:
   - NRF first (all services depend on it)
   - Then SCP, UDR, UDM, AUSF, PCF, NSSF, BSF
   - Then AMF, SMF, UPF
   - Finally MME, HSS, PCRF, SGW-C, SGW-U
6. **Verification** - Checks each service is active after restart
7. **Auto-Rollback** - Restores backup if any service fails to start

### Features

- **YAML Preservation** - Comments and formatting maintained
- **Mutex Locking** - Only one apply operation at a time
- **Diff Preview** - See exactly what changed
- **Audit Logging** - All changes logged with timestamps
- **Rollback Capability** - Restore any previous backup

---

## SEPP (Security Edge Protection Proxy)

Configure and run a real SEPP for 5G inter-PLMN roaming (N32 interface) directly from the WebUI — previously this was entirely unmanaged, requiring manual edits to `/etc/open5gs/sepp1.yaml`.

### Home SEPP Configuration

A Config tab like every other NF, covering:
- **SBI** — server address/port, SCP client URI
- **N32 identity** — our sender FQDN, scheme (HTTP/HTTPS), N32-c (control) and N32-f (forwarding) address/port pairs
- **TLS** — an on/off toggle for mutual TLS on N32 (independent of whether other local NFs use TLS, which they typically don't in a lab deployment)
- **Visited-peer connection** — receiver FQDN, N32-c/N32-f URI and resolve-IP for the one configured visited-network peer

### TLS / Certificate Generation

When TLS is enabled:
- **Generate Certs** — creates a self-signed keypair for the home SEPP's identity (`openssl req -x509`) — the standard simplified trust model for a lab/test roaming setup, not a real GSMA-IPX-backed PKI. The public cert is displayed for copying.
- **Peer certificate** — a paste box for the visited operator's public cert, saved as the local trust anchor for verifying their connection.

### Generate Visited PLMN Config

A separate export panel builds a complete, downloadable `sepp.yaml` for the visited-network operator's side — cross-referencing our already-configured home SEPP values (FQDN, N32 addresses) and appending our public cert content when TLS is enabled, so a real roaming partner has everything needed in one file.

### Lifecycle

SEPP is a full 17th core NF: included in the standard bulk "Apply Configuration" restart flow (backed up, written, restarted, verified, rolled back on failure — same as any other NF), not a separately-lifecycled optional module like IMS/SMS/VoWiFi.

---

## DNS/FQDN Migration Wizard

Converts the core network from hardcoded IP addressing to 3GPP-standard FQDN/DNS addressing (`<nf>.5gc.mnc<mnc>.mcc<mcc>.3gppnetwork.org` for 5GC SBI, `<nf>.epc.mnc<mnc>.mcc<mcc>.3gppnetwork.org` for EPC Diameter) — matching how carrier-grade Open5GS deployments and the official Open5GS roaming tutorial address NFs, instead of loopback/private IPs.

### Phasing

Run independently or together, always with an automatic backup first:

- **Phase A — DNS zones.** Generates and verifies both zones via the BIND9 module.
- **Phase B — EPC/Diameter mesh.** Rewrites MME/HSS/PCRF/SMF freeDiameter `.conf` files to use FQDN-based `Identity`/`ConnectPeer` (dropping hardcoded `ConnectTo` IPs in favor of DNS resolution).
- **Phase C — 5GC SBI mesh.** Rewrites every 5GC NF's `client.nrf`/`client.scp` URIs and `sbi.server[].advertise` field to FQDNs, then restarts all of them together in dependency order.

### Scope

Deliberately excludes bearer-plane addresses (GTP-C/GTP-U/S1AP/PFCP on SGWC/SGWU/UPF/MME) — Open5GS's YAML schema doesn't support hostnames there. SEPP's local SBI client (to our own SCP/NRF) is included; its N32 peer connection to a visited PLMN's own SEPP is not, since that belongs to a different operator's infrastructure and isn't something local DNS resolves.

### Operational note — SEPP + Phase A/C ordering

`open5gs-seppd` does strict, synchronous DNS resolution of its own `advertise` FQDN at startup and aborts fatally if the record doesn't exist yet — unlike every other NF, which tolerates an unresolvable advertise value fine and starts up normally regardless. **Always run Phase A (DNS zones) immediately before or alongside Phase C for SEPP** — if the DNS zone doesn't yet contain SEPP's record when Phase C restarts it, `open5gs-seppd` will crash-loop until Phase A is (re)run.

### Rollback

A fresh backup is taken automatically before Phase B or C — rollback stays available for as long as that backup exists.

---

## Network Topology Visualization

Interactive real-time visualization of your Open5GS network.

### Display Elements

**Nodes (20 total):**
- All 16 Open5GS network functions
- RAN elements (eNodeB for 4G, gNodeB for 5G)
- External systems (MongoDB, Internet)

**Connections:**
- SBI interfaces (pink) between 5G NFs
- Control plane interfaces (green) for 4G
- User plane interfaces (yellow) for data
- Database connections (dashed)

**Status Indicators:**
- Green dot = Service active
- Red dot = Service inactive
- Animated connections = Both endpoints active

### Real-Time Information

**Interface Status:**
- S1-MME (eNodeB ↔ MME control)
- S1-U (eNodeB ↔ SGW-U data)
- N2 (gNodeB ↔ AMF control)
- N3 (gNodeB ↔ UPF data)

**Active UE Sessions:**
- IP addresses assigned to UEs
- IMSI correlation from MongoDB
- Real-time session count

**Connected eNodeBs:**
- List of eNodeB IP addresses
- Connection status
- Hover for details

### Layout

Professional manual-routed layout with:
- 90-degree orthogonal connectors
- No diagonal lines or T-junctions
- Color-coded interface labels
- Logical grouping (Control Plane, SBI, User Plane)

---

## Subscriber Management

Complete CRUD operations for Open5GS subscriber database.

### Operations

**Create Subscriber:**
- Enter IMSI (15 digits)
- Generate or enter K and OPc keys
- Configure AMBR (Aggregate Maximum Bit Rate)
- Set up network slices
- Define PDU sessions

**Edit Subscriber:**
- Modify any field
- Add/remove slices
- Add/remove sessions
- Update QoS profiles

**Delete Subscriber:**
- Remove from MongoDB
- Confirmation required

**Search:**
- By IMSI (partial match)
- By MSISDN

### Subscriber Schema

Matches Open5GS MongoDB schema exactly:

```
Subscriber:
  - IMSI (15 digits)
  - MSISDN (optional)
  - Security: K, OPc, AMF, SQN
  - AMBR: Downlink/Uplink with units
  - Slices: SST, SD, default indicator
    - Sessions: Name, Type, QoS, AMBR
  - Access restrictions
  - Subscriber status
```

### Features

- **Pagination** - 50 subscribers per page
- **MongoDB Native** - Direct database access
- **Schema Validation** - Zod validation before insert
- **Bulk Import** - CSV import (planned)

### Subscriber Groups

Organize subscribers into named, colored groups (e.g. "Field trial A", "Test devices") for easier browsing of large deployments. Grouped subscribers render clustered under a collapsible group header; ungrouped subscribers list separately below. Purely organizational — backed by its own MongoDB collection, independent of and never touching actual subscriber/HSS data.

### Framed Routing

Per-session support for 3GPP Framed Routing (TS 23.501 §5.6.14) — lets a UE act as a gateway for an IP subnet behind it (e.g. an IoT gateway or fixed-wireless CPE with its own LAN), routed through that UE's single PDU session, instead of requiring a dedicated address per downstream device.

- **Configuration** — each session has editable IPv4/IPv6 framed-route fields (comma-separated CIDR list), alongside the existing AMBR/QoS/UE-address fields
- **Apply static route on host** — a per-session checkbox that auto-manages the local `ip route` needed for the subnet to actually reach the UE's tunnel, resolving the correct `ogstun*` device from the session's DNN automatically. Idempotent — safe across repeated saves, and cleaned up on delete
- **You still need an upstream route** — a local route alone isn't enough for the rest of your network to reach the subnet; either advertise it via dynamic routing (e.g. an EIGRP `network` statement — not automated by this app) or add a manual static route on your core/edge router pointing at **this Open5GS host's own IP**, never the UE's IP. The checkbox's hint text includes a worked example
- **Overlap/duplicate warnings** — on save, new framed routes are checked against every other subscriber's framed routes and the core UE pool subnets, surfaced as a non-blocking warning toast (an operator may be intentionally staging a route, so the save still succeeds)
- **Framed Routes Registry** — a modal (Addressing dropdown, toolbar) listing every configured subnet across all subscribers with its owner, APN, and static-route status
- **CSV import/export** — a `framed_routes` column (pipe-separated CIDRs) round-trips through the existing subscriber CSV import/export flow

---

## eSIM Generator (Simlessly API)

Generates real eSIM activation codes through the [Simlessly](https://docs.simlessly.com) RSP (Remote SIM Provisioning) platform's Single Generate AC API, directly from Open5GS subscriber data.

### Launch points

- **Per-row** — a "Generate eSIM" button on each row of the Subscribers page, pre-fills the modal with that subscriber's IMSI, K, OPc, MSISDN, and ICCID.
- **Toolbar** — a page-level "Generate eSIM" button opens the same modal blank, with an inline subscriber search/picker, or fully manual entry for an eSIM not tied to any Open5GS subscriber.

### Form fields

Core required fields are always visible: ICCID, IMSI, KI, and Config Name (the name of a profile template you've already created on the Simlessly platform's own UI — this app does not create or list Simlessly profile configs).

Everything else — OPC, MSISDN, HPLMN/EHPLMN/OPLMN/FPLMN lists, SPN, PNN, IMPI/IMPU, PIN1/PIN2/PUK1/PUK2/ADM1, SMSP, and the "Return AC Link" toggle — lives behind a collapsed "Advanced" section. Encryption mode is always plaintext (Simlessly's own default when the field is omitted).

### Generating

- **Generate via Simlessly API** — signs and sends a real request to Simlessly (`POST /api/v2/ac/generate`); on success shows the returned Activation Code, and (if "Return AC Link" was checked) the AC link both as a clickable URL and an embedded QR code image. Requires `SIMLESSLY_ACCESS_KEY`/`SIMLESSLY_SECRET_KEY` to be configured — see [Configuration](configuration.md). Every attempt (success or failure) is audit logged. Admin-only, since it creates a real, likely billable resource on your Simlessly account.
- **Copy JSON** — the exact request body is also always shown, pretty-printed and single-line, with copy-to-clipboard, for manual use in other tools regardless of whether you call the live API.

### Not yet supported

Batch generation, live lookup of your Simlessly profile config names, and full profile lifecycle management (query/delete/expire, webhook status notifications) are not implemented — Simlessly's API supports these, but this integration currently covers Single Generate AC only.

---

## SIM Generator

Generate test SIM credentials with auto-provisioning capability.

### Features

**Country-Based MCC Selection:**
- 65+ countries with correct MCC codes
- United States CBRS (MCC 315)
- Test Network (MCC 999)
- Custom MCC entry option

**Generation Options:**
- Number of SIMs to generate (1-100)
- Starting IMSI
- MNC (operator code)
- AMBR configuration

**Credential Generation:**
- Sequential IMSI generation
- Random 128-bit K keys
- Random 128-bit OPc keys
- Default QoS profiles

**Auto-Provisioning:**
- Checkbox to automatically add to database
- Creates subscribers with "internet" APN
- IPv4v6 session type
- 1 Gbps up/down AMBR
- SST 1, QoS 9

### Use Cases

- **Testing** - Generate test SIMs quickly
- **Lab Environment** - Provision multiple UEs
- **eSIM Provisioning** - Generate credentials for Simlessly
- **Development** - Populate database for testing

---

## SUCI Key Management

Manage home network public/private keypairs for 5G privacy.

### SUCI Overview

SUCI (Subscription Concealed Identifier) encrypts SUPI (IMSI) over the air to protect subscriber privacy in 5G networks.

### Supported Profiles

**Profile A (Recommended):**
- Algorithm: X25519 / curve25519
- Key type: Elliptic Curve Diffie-Hellman
- Use case: Most 5G deployments

**Profile B:**
- Algorithm: secp256r1 / NIST P-256
- Key type: Elliptic Curve Cryptography
- Use case: Specific regulatory requirements

### Operations

**Generate Key:**
1. Select Profile (A or B)
2. Choose PKI value (0-255)
3. Set Routing Indicator (default "0000")
4. System generates keypair via OpenSSL
5. Private key stored securely: `/etc/open5gs/hnet/{pki}.key`
6. Public key displayed in hex format
7. UDM config automatically updated

**Regenerate Key:**
- Generates new keypair with same PKI
- Overwrites previous key
- Requires typed confirmation

**Delete Key:**
- Removes from UDM config
- Optionally deletes key file
- Cannot be undone

### eSIM Provisioning Integration

Public keys can be exported for eSIM provisioning services:
- Simlessly
- Other eSIM platforms supporting SUCI

Required information:
- Profile (A or B)
- Home Network Public Key (hex)
- PKI value
- Routing Indicator

---

## Service Management

Control Open5GS services directly from the UI.

### Service Operations

**Individual Service Control:**
- Start - Activate a stopped service
- Stop - Deactivate a running service
- Restart - Stop then start a service

**Bulk Operations:**
- Start All - Activate all 16 services
- Stop All - Deactivate all services
- Restart All - Restart in dependency order

### Status Display

Each service card shows:
- Service name (e.g., "NRF", "AMF")
- Current status (Active/Inactive/Failed)
- Uptime (for active services)
- Memory usage
- Process ID (PID)

### Real-Time Updates

Service status updates automatically via WebSocket:
- 5-second polling interval
- Instant UI updates
- No page refresh needed

### Integration

Direct systemd integration:
- Uses systemctl commands on host
- Respects service dependencies
- Handles service failures gracefully

---

## Auto-Configuration Wizard

One-click setup for basic Open5GS deployments.

### Configuration Options

**4G/5G PLMN:**
- MCC (Mobile Country Code)
- MNC (Mobile Network Code)

**Control Plane IPs:**
- S1-MME address (MME ↔ eNodeB)
- AMF NGAP address (AMF ↔ gNodeB)

**User Plane IPs:**
- SGW-U GTP-U address
- UPF GTP-U address

**Session Pools:**
- IPv4 subnet and gateway
- IPv6 subnet and gateway

**Network Settings:**
- DNS servers
- Network name (full and short)

### Optional NAT Configuration

Configure iptables for UE internet access:
- Enable IP forwarding (IPv4/IPv6)
- MASQUERADE rules for session pool
- Allow traffic on tunnel interface (ogstun)
- Preview exact commands before execution

### Preview Mode

Before applying:
- Shows list of affected services
- Displays YAML diff for each file
- Summarizes major changes
- Preview NAT commands

### Generated Configuration

Creates complete configuration for:
- All 16 network functions
- Correct NRF registration URIs
- PFCP client-server matching
- TAI lists
- PLMN support lists
- Default security algorithms

---

## Real-Time Logging

Stream logs from Open5GS services, Docker containers, GenieACS, and FRR in real-time, plus a classified "Major Events" view and forwarding to an external syslog server.

### Log Sources

**Open5GS Services:**
- Stream logs from any of the 16 Open5GS network functions
- Reads from `/var/log/open5gs/*.log` files
- Uses `tail -f` for real-time streaming
- Switching to this source auto-selects nothing by default (you pick which NFs to watch)

**Docker Containers:**
- Stream logs from NMS Docker containers (backend, frontend, nginx)
- Uses `docker logs -f --timestamps` for real-time streaming
- Automatic container discovery
- A "SAS Logs" quick-select jumps to Docker mode, selects the backend container, and filters to just SAS protocol lines

**GenieACS:**
- Streams the `genieacs-cwmp-access` and `genieacs-nbi-access` logs
- Selecting this source auto-selects both files
- Optional radio filter dropdown narrows to a single device's TR-069 traffic by serial number

**FRR:**
- Streams `/var/log/frr/frr.log` — all daemons (eigrpd/zebra/mgmtd/staticd) share this one file, so it's a single pseudo-service
- Selecting this source auto-selects it
- Log verbosity (emergencies…debugging) is controlled from the L3 Routing page, not here — see [FRR Log Level](#frr-log-level) below

### Features

**Log Source Toggle:**
- Switch between "Open5GS Services" and "Docker Containers"
- Separate service/container selection for each source
- Seamless switching without reconnection

**Service/Container Selection:**
- Dropdown to select any of 16 services (Open5GS mode)
- Automatic container list (Docker mode)
- Multi-select capability
- Switch between services without stopping stream

**Log Display:**
- Timestamped entries
- Monospace font for readability
- Color-coded service badges:
  - Blue/Green/Purple/Pink for Open5GS services
  - Cyan for Docker containers
- Stream indicator ([stdout] or [stderr] for Docker logs)

**Controls:**
- Auto-scroll toggle (pause/resume)
- Clear logs button
- Max lines selector (100/500/1000/2000)
- Pause streaming without disconnecting

### Docker Logging Features

**Verbose Terminal Output:**
- Enhanced logging when running `docker compose up`
- Timestamps on all log entries
- Increased log rotation (50MB per file, 5 files)
- Container labels for identification

**Container Discovery:**
- Automatically detects all NMS containers
- Filters by `open5gs-nms` prefix
- Real-time container list updates

**Log Format:**
- ISO 8601 timestamps (e.g., `2026-04-14T14:30:45.123456789Z`)
- Stream indicator (stdout/stderr)
- Container name prefix

### Technical Details

Uses WebSocket for log streaming:
- Backend runs `journalctl -f` (Open5GS) or `docker logs -f` (Docker)
- Streams output line-by-line
- Efficient (only sends new lines)
- Survives page refresh
- Source-aware message routing

**WebSocket Protocol:**
```javascript
// Subscribe to logs
{
  type: 'subscribe_logs',
  source: 'open5gs' | 'docker' | 'genieacs' | 'frr',
  services: ['nrf', 'amf'], // or container names / genieacs log names / ['frr']
  filter: 'sas',            // optional server-side content filter
  // Major Events mode (source is still 'open5gs'):
  majorEventsOnly: true,
  imsis: ['999700000053555'],
  radioIps: ['10.0.2.101'],
  eventTypes: ['ue_attach', 'pdu_session_up'],
}

// Receive log entry
{
  type: 'log_entry',
  source: 'open5gs' | 'docker' | 'genieacs' | 'frr',
  log: {
    timestamp: '2026-04-14T14:30:45.123Z',
    service: 'nrf', // or container / genieacs / 'frr'
    message: '[info] NRF started',
    // present only when majorEventsOnly is set:
    event: { type: 'ue_attach', imsi: '999700000053555' }
  }
}
```

### Major Events View

A separate "Events" tab (alongside "Live Logs" and "Audit Log") that classifies each open5gs log line into one of 8 event types instead of showing raw DEBUG output:

- `radio_connect` / `radio_disconnect` — eNodeB/gNodeB S1AP/NGAP association up/down
- `ue_attach` / `ue_detach` — 4G attach/detach
- `ue_register` / `ue_deregister` — 5G registration/deregistration
- `pdu_session_up` / `pdu_session_down` — PDU session establishment/teardown

**Filters** (combine as AND-across, OR-within): Event Types, Radios (sourced from radios actually seen connecting/disconnecting in the last 3 days), IMSIs (from the subscriber list). IMSI is normalized across the five different in-line conventions open5gs logs use across NFs (bare, `imsi-`-prefixed, `IMSI[...]`, etc.) so filtering works regardless of which NF logged it.

**Known limitation:** radio IP can only be correlated to radio-connect/disconnect events — PDU session and attach/register events don't carry the originating radio's IP in the raw log line, so those are filtered by IMSI only, not cross-correlated to a specific radio.

**Log Context Viewer:** clicking any event opens a modal showing the raw log lines immediately surrounding it (the DEBUG detail the classifier filtered out), with zoom in/out controls (or +/- keys) to show fewer or more lines on either side.

### FRR Log Level

The L3 Routing page has a dropdown for FRR's 8 syslog-style severities (`emergencies`, `alerts`, `critical`, `errors`, `warnings`, `notifications`, `informational`, `debugging`). Changing it writes both the `log syslog` and `log file` directives in the generated `frr.conf` and reloads via `vtysh -b` — this does not restart the FRR service or flap any routing neighbor, it only changes log verbosity.

### FRR Source Build

The L3 Routing page's "Reinstall (Source)" tab migrates FRR from the Ubuntu apt package (8.4.4, has long-standing `eigrpd` assertion-crash bugs) to a from-source build (10.6.1+, built against libyang), with automatic backup, build, config-restore, and rollback — a prerequisite for the crash-guard patch below.

### eigrpd Crash-Guard Patch

A hand-built patch on top of the from-source FRR build (see "FRR Source Build" above) that stops a long-standing, upstream-unfixed EIGRP bug ([FRRouting/frr#943](https://github.com/FRRouting/frr/issues/943)) from crashing the entire `eigrpd` process — and withdrawing every EIGRP-learned route — when it fires. See **[docs/frr-eigrpd-crash-guard-patch.md](frr-eigrpd-crash-guard-patch.md)** for the full root-cause writeup, code, and reapplication steps.

### Syslog Forwarding

Forwards all Open5GS NF logs, GenieACS access logs, and the FRR log (19 files total) to a remote syslog server (e.g. Graylog), via rsyslog running on the host.

- **Detect / Install** — checks whether rsyslog is installed and running; installs it with one click if not
- **Configure** — enter a target host, port, and protocol (UDP or TCP); writes a dedicated, fully NMS-owned drop-in file (`/etc/rsyslog.d/71-open5gs-nms-forward.conf`) rather than editing your existing `rsyslog.conf` — safe to use even if you already have rsyslog configured for something else
- **Validation before apply** — the generated config is syntax-checked with `rsyslogd -N1` before rsyslog is ever restarted, so a bad config can't take down your host's logging
- **Automatic permission fixes** — rsyslog normally can't read logs outside `/var/log` (AppArmor) or files it doesn't own (like `frr.log`, owned by the `frr` user); both are fixed automatically the first time you configure a target, via the OS's own sanctioned mechanisms (AppArmor local-override file, adding the `syslog` user to the `frr` group)
- **Disable** — removes the drop-in file and restarts rsyslog; nothing else about your rsyslog setup is touched

---

## Backup & Restore

Two backup mechanisms live on the same page: a legacy config-only/MongoDB-only pair
(kept for compatibility with older workflows) and a **Full Backup**, the recommended
way to capture everything needed to restore this deployment onto a brand new host.

### Full Backup (recommended — every module)

One `.tar.gz` archive, one click, covering every optional module this project ships —
audited 2026-08-25 specifically to make sure nothing was missing for a genuine
new-host restore. Eight independently selectable categories:

| Category | Contents |
|---|---|
| Subscribers & SAS | `mongodump --db open5gs` — subscribers (APNs/IPs/security keys), SAS grants/CBSDs, subscriber groups, APN profiles, RF Planning projects, TWAMP targets/history, users, audit log |
| Core NF Configs | All 17 core NF YAML files (`/etc/open5gs/*.yaml`, including `sepp1.yaml`) |
| SUCI Keys | 5G-AKA home-network private/public keys (`/etc/open5gs/hnet`) — irreplaceable, not regenerable |
| SecGW Certificates | Security Gateway's own CA and every issued per-radio IPsec certificate/key — irreplaceable, not regenerable by re-running Configure |
| Optional Module Configs | IMS/VoLTE, SMS (SGs + VectorCore), MMS, PSTN Gateway, VoWiFi, TWAMP, FRR source-build state, chrony, syslog forwarding — each module's own NMS-side settings file |
| L3 / IP Network Config | FRR (EIGRP) config and host interface addressing (netplan) |
| DNS / BIND | `named.conf` + every FQDN zone file |
| GenieACS (Radio Provisioning) | GenieACS's own separate MongoDB database — device inventory, presets, provisioning scripts, TR-069 session history |

Deliberately excluded: PyHSS's own MariaDB (IMS reinstall + Sync Subscribers rebuilds
it from the restored `open5gs` database instead of restoring a second database engine)
and Asterisk's installed package itself (same reasoning — `pstn_extensions` rides
along in the Subscribers dump, and `.pstn-config.json` in Optional Module Configs is
enough for Configure to regenerate its dialplan/trunk settings after a fresh PSTN
Install). Also excluded: idempotency/patch-applied marker files (restoring those onto
a different host could wrongly skip a patch that host's own files still need) and
migration-wizard progress state (DNS/PLMN/FRR migration — describes an in-progress
one-time transition, not standing config).

On restore, each category is independently selectable (`Inspect` shows exactly what's
in an archive and how many items per category before you commit to anything). L3/IP
Network, DNS, and GenieACS default OFF on restore — the first two because a restore
commonly happens onto a host whose physical network topology differs from the one the
backup was taken on, and silently overwriting `frr.conf`/netplan/BIND could break
connectivity to the box entirely; GenieACS because it's a full separate-database
overwrite of live radio provisioning state. Everything else, including SecGW
certificates, defaults ON.

### Legacy Backup Types

**Configuration Backups:**
- All 17 configurable NF YAML files, plus `sepp2.yaml` (the visited-PLMN template file — not independently editable via the UI, but swept up in every full backup/restore cycle)
- Stored in `/etc/open5gs/backups/config/YYYY-MM-DD-HHMM/`
- Includes exact file permissions

**MongoDB Backups:**
- `open5gs` database only (subscribers, SAS, groups, APN profiles, RF Planning, TWAMP, users, audit log)
- Stored in `/etc/open5gs/backups/mongodb/YYYY-MM-DD-HHMM/`
- Uses mongodump/mongorestore

### Automatic Backups

Created automatically before:
- Every configuration apply operation
- Restore to defaults
- Major system changes

### Manual Backups

Click "Create Backup" button to:
- Backup all configs immediately
- Backup MongoDB database
- Generate timestamped archive

### Restore Operations

**Selective Restore:**
- Restore configs only
- Restore MongoDB only
- Restore both

**Restore Process:**
1. Select backup from list
2. Choose what to restore
3. Preview changes (diff view)
4. Confirm restore
5. Services automatically restarted
6. Verification checks

### Retention Policy

- Backups kept indefinitely by default
- Manual cleanup available
- Automated cleanup (planned)

---

## Audit Trail

Complete logging of all system actions.

### Logged Events

**Configuration Changes:**
- Config loads
- Config applies (with diff)
- Config rollbacks
- Validation failures

**Service Management:**
- Service starts/stops/restarts
- Bulk operations
- Service failures

**Subscriber Operations:**
- Creates
- Updates
- Deletes

**System Operations:**
- Backup creations
- Restore operations
- SUCI key generations
- Auto-config executions

### Log Format

```json
{
  "timestamp": "2026-03-23T14:30:45.123Z",
  "action": "config_apply",
  "user": "admin",
  "details": "Applied configuration to 5 NFs",
  "diffSummary": "amf: Updated TAI list...",
  "restartResult": {
    "success": true,
    "services": ["nrf", "amf", "smf"],
    "errors": []
  },
  "success": true
}
```

### Storage

- File-based logging: `/var/log/open5gs-nms/audit/`
- JSON lines format
- Daily log rotation
- Indefinite retention

### Viewing Audit Logs

- Audit page in UI (planned)
- Direct file access via shell
- Log aggregation tools (Elasticsearch, Splunk)

---

## IMS / VoLTE

*(Beta)* Full IMS core integration for voice-over-LTE and SMS-over-IP. **Confirmed
working end-to-end with real, unmodified iPhone hardware on PLMN 001-01 (2026-07-26)**,
including real-to-real calls between two registered iPhones with proper dedicated
voice bearers, not just calls to/from the built-in test-number bot or a softphone.

### Components

- **P-CSCF / I-CSCF / S-CSCF** — Kamailio 5.8.8, built with IMS, TLS, MySQL, and extra modules
- **PyHSS** — Python-based Diameter HSS ([nickvsnetworking/pyhss](https://github.com/nickvsnetworking/pyhss)). Installed automatically by the NMS's one-click Install step (cloned from GitHub, Python deps installed via pip) — no separate manual install required
- **BIND9** — DNS server for the IMS domain zone (`ims.mnc<MNC>.mcc<MCC>.3gppnetwork.org`)
- **RTPEngine** — media relay
- **MariaDB** — backing database for PyHSS and the S/I-CSCF
- **PCRF Rx interface** — P-CSCF speaks Diameter Rx to the real open5gs PCRF (`ims_qos`/`cdp`/`cdp_avp` Kamailio modules) so a real call actually gets a dedicated QCI=1 (Conversational Voice/GBR) EPS bearer via Gx — this is what makes a real phone's own VoLTE stack agree to ring, not just complete SIP signaling

### Workflow

1. **Install** — one-click install of Kamailio (incl. its IMS/Diameter modules), MariaDB, BIND9, RTPEngine, Redis, and PyHSS
2. **Configure** — wires the P-CSCF address into SMF's PCO and per-session DNS, writes Cx (I/S-CSCF↔PyHSS) and Rx (P-CSCF↔PCRF) Diameter peer XML, generates the IMS DNS zone. Re-running Configure at any point is safe and picks up every fix shipped for this module — it's a full rewrite of every IMS config file, not incremental, and always restarts the affected services
3. **Sync Subscribers** — pushes IMPI/IMPU identities for existing subscribers into PyHSS's `ims_hss_db` (via its REST API)
4. **Enable/Disable, Start/Stop/Restart** — full lifecycle control from the UI

### Known upstream bugs found and fixed

Three real bugs were found in upstream PyHSS itself (not this project's own
code) during live testing, all of which produced symptoms that looked like
either intermittent network flakiness or a client-side phone bug:

- **Cx UAA/LIA crash on a missing identity AVP.** If a request was missing
  its expected identity AVP, an uncaught exception inside the exception
  handler itself (a variable referenced before it was ever assigned) crashed
  the response mid-build, producing a Diameter answer with neither a
  Result-Code nor an Experimental-Result-Code — indistinguishable from a
  "genuinely intermittent" HSS failure.
- **Subscriber SIP identity corrupted to `sip:<msisdn>@None`.** The iFC
  template used a transient, deregister-cleared database field to build a
  subscriber's *permanent* identity domain; a deregister/re-register race
  could bake the literal text "None" into that identity, which then got
  cached by S-CSCF until the next re-register. This looked exactly like a
  client-side phone bug (previously worked around by toggling Airplane
  Mode) — it wasn't.

All three are patched automatically as part of the one-click **Install**
step (idempotent — safe to re-run against an already-patched or a freshly
cloned PyHSS, and self-verifying rather than silently no-op-ing if upstream
PyHSS ever changes shape enough to break the patch). Existing deployments
just need to click Install again to pick these up; no separate migration
step exists or is needed.

### Current Status

Confirmed working end-to-end on real hardware: real SIP REGISTER (full AKA, not just
Early-IMS/softphone auth), real INVITE→180 Ringing→200 OK call setup, and — critically
— a real dedicated QCI=1 voice bearer actually gets created via the Rx/Gx chain for
each call, matching what a real commercial VoLTE network does. Verified both
directions (either phone calling the other) and both call directions against the
built-in [IMS Test Number bot](#ue-validation) (a real SIP UAS for on-demand testing
without needing two physical phones).

**Real-radio caveat, not a software limitation:** whether a real UE-to-UE call
actually rings depends on the serving eNB supporting a dedicated QCI=1 bearer —
confirmed live that one specific eNB model rejected it outright (S1AP cause
`not-supported-QCI-value`), while switching to a different radio on the same core
succeeded immediately. If a UE-to-UE call won't ring, check the eNB's own S1AP
`E-RABSetupResponse` before suspecting a core-network config issue.

**Known limitation, Android specifically:** Android's telephony framework has
historically suppressed VoLTE/SIP REGISTER entirely on non-carrier-provisioned test
PLMNs — the phone connects to the IMS APN and gets an IP, but the framework never lets
it send SIP traffic. This is a device/carrier-policy limitation, not confirmed to be
resolved, and hasn't been re-verified against the fixes above. iPhone is confirmed
working; Android real-phone VoLTE calling is unverified.

---

## 2G GSM (Osmocom)

> **Alpha.** Real GSM radio access on real nanoBTS hardware, layered on top of
> the osmo-hlr/osmo-msc/osmo-stp trio the SMS-over-SGs module already runs.
> `ENABLE_GSM_MODULE` defaults to **disabled** (opt-in) — misconfiguring a
> live radio (and, for a real BTS, actual spectrum transmission) is a bigger
> blast radius than a broken lab feature; check the module's own Setup tab
> for a real spectrum-authorization acknowledgment before adding hardware.

### What It Does

Adds osmo-bsc/osmo-mgw (and, optionally, osmo-pcu/osmo-sgsn/osmo-ggsn for
GPRS/EDGE) on top of the same osmo-hlr/osmo-msc/osmo-stp core the SMS module
already runs — one shared CS core, two independent front ends (SGs-only vs.
full radio access). **Stable**: CS attach/location-update/ciphering, GPRS/
EDGE data, and 2G↔4G SMS delivery (via a SMPP bridge into the separate
VectorCore SMSC module). **Alpha**: real 2G-to-2G voice calling.

Real voice calling has a genuine, confirmed upstream limitation: osmo-msc's
own built-in/internal call handler can drive signaling (paging, ringing,
answering) but never implements the `MNCC_RTP_CREATE` primitive needed to
actually bridge the two call legs' audio — every call in Internal mode
(osmo-msc's default) hangs with no audio and eventually times out, regardless
of anything in this project's own code. Getting real audio requires External
MNCC mode, routed through **osmo-sip-connector** (a clean, unpatched build of
the real upstream daemon) to a SIP peer that can complete the loop:

1. Subscriber A calls subscriber B. osmo-msc, in External mode, hands the
   call to osmo-sip-connector over a Unix socket instead of routing it
   internally.
2. osmo-sip-connector — a dumb, single-peer MNCC↔SIP signaling relay with no
   dial-plan logic of its own — sends a SIP INVITE (destination = B's
   MSISDN) to its one configured "remote" peer.
3. That peer is **Asterisk-2G**: a second, fully isolated Asterisk instance
   (own config tree at `/etc/asterisk-2g`, own systemd unit, own loopback IP
   `127.0.1.7` — shares only the underlying apt package with the completely
   separate Asterisk instance the [PSTN Gateway](#pstn-gateway) module owns,
   never its config/service/lifecycle). Its one-line dialplan recognizes the
   dialed number as a local subscriber and re-originates the call back out
   through the same trunk.
4. osmo-sip-connector receives that second INVITE and hands it to osmo-msc as
   a mobile-terminated setup toward B — osmo-msc does its own normal
   MSISDN→subscriber/HLR resolution and pages B exactly as it would for any
   real call.
5. RTP flows directly between osmo-mgw and Asterisk-2G — osmo-sip-connector
   never touches media/codecs at all, so Asterisk-2G's endpoint is configured
   for plain GSM Full Rate only, matching exactly what the real BTS/BSC/MSC
   chain negotiates (confirmed live: `chan_mode=SPEECH_V1, chan_type=FR`).

One button (GSM page → **2G Voice** tab, gated on `ENABLE_ASTERISK_2G_MODULE`,
defaults **disabled**) installs Asterisk-2G, configures it, points the SIP
tab's remote peer at it, and switches MNCC to External — all four steps in
one action, since this module's only job is being that one specific peer
(unlike the SIP tab's own remote field in general, which stays a fully manual,
never-auto-written setting for anything else, on purpose — see
`gsm-controller.ts`'s own `/sip/configure`). Internal vs. External MNCC mode
is otherwise an explicit, persisted operator choice on the SIP tab (never
flipped automatically by any other action) — see `POST /api/gsm/sip/mncc-mode`.

**Per-BTS admin lock/unlock** (RAN page, 2G GSM section — one "Block"/"Unblock"
button per BTS, gated behind a confirm modal on Block since it's a real,
live-impact action): commands osmo-bsc's own OML Administrative State
(`change-adm-state locked/unlocked`, entered via `bts <N> oml class bts
instance 0 0 0`) — a genuine command to the radio itself over Abis, not a
host-side traffic filter, so locking drops every camped UE immediately and
takes the cell off the air until unlocked. Live-verified 2026-09-13 against
this project's own running osmo-bsc. This has no persisted equivalent in
`osmo-bsc.cfg` itself (confirmed by inspecting the real `bts <N>` config
node's full command list) — osmo-bsc silently forgets the lock on its own
restart, so the lock state is tracked in this module's own state file and
`reapplyBtsLocks()` replays it over VTY every time osmo-bsc comes back up
(config regen after any BTS add/edit/remove, or any of this module's own
Start/Restart actions) so it never silently reverts to unlocked.

**Per-UE GPRS/EDGE data-session IP** (RAN page, 2G GSM section — a "Data IP"
column in the UE list, all three layouts): reads live active PDP contexts
straight from osmo-ggsn's own VTY (`show pdp-context ggsn ggsn0`, port
4260) — osmo-ggsn is the real address allocator; osmo-sgsn only relays the
GTP-C signaling around it. `parsePdpContexts()`'s exact field layout came
from reading osmo-ggsn 1.9.0's own source (`ggsn/ggsn_vty.c`'s
`show_one_pdp_v4only()`, pulled via `apt-get source osmo-ggsn`), not the VTY
reference PDF — that turned out to be an auto-generated command-syntax tree
with no actual sample output to verify a parser against. A UE with no active
data session (CS-only, or GPRS/EDGE not enabled) just shows `—`, same as
before this existed.

### Components

- **Backend**: `gsm-controller.ts` — osmo-bsc/osmo-mgw/GPRS lifecycle, BTS
  management (discovery, add/edit real or virtual radios, admin lock/unlock),
  live PDP-context lookup (`osmoVtyCommand()`, generalized from the
  osmo-bsc-only `bscVtyCommand()` so any daemon's VTY can reuse the same
  connection script), the SIP tab's osmo-sip-connector lifecycle + MNCC mode
  endpoint. `osmo-sip-connector-build.ts` — clean upstream source build (tag
  pinned to match this host's installed `libosmocore-dev`), no custom
  patches. `asterisk-2g-controller.ts` — the isolated second Asterisk
  instance's full install/configure/status/start/stop/restart/uninstall
  lifecycle. `sms-controller.ts` owns the shared osmo-hlr/osmo-msc/osmo-stp
  config via an ownership-based VTY-config merge (never a blind full-file
  regeneration — see its own module comments).
- **Frontend**: `GsmPage.tsx` — Setup / BTS-Radios / SIP / 2G Voice / Config
  Files tabs, all following this project's standard centered-pill-tab layout.
  `RANPage.tsx`'s 2G GSM section — per-BTS admin lock/unlock button and
  per-UE Data IP column (all three layout variants), separate from the
  module's own management page since this is where an operator monitoring
  live traffic actually looks to act on it.

### Real bugs found and fixed getting this working end-to-end

- **osmo-bsc and osmo-stp collided on the same example SS7 point-code**
  (`0.23.1`, a conventional "the MSC" placeholder copied from Osmocom's own
  docs) — OML/RSL/SIGTRAN all showed fully healthy while zero real signaling
  (location update, call, SMS) ever completed between BSC and MSC. Fixed by
  giving osmo-stp its own distinct point-code.
- **A5 cipher mismatch**: `osmo-bsc.cfg` allowed only `a5 0` (no encryption)
  while `osmo-msc.cfg` required real ciphering — every real attach was
  rejected outright with a clear cipher-negotiation error once found.
- **`osmo-msc`/`osmo-bsc`'s `mgw endpoint-domain` were set to their own
  component names** (`msc`/`bsc`) instead of `mgw` — osmo-mgw itself has no
  explicit domain override and defaults to expecting literally `mgw`, so
  every real call's MGCP CRCX was silently rejected. Invisible until an
  actual voice call was attempted, since attach/SMS/GPRS never touch MGW.
- **A leftover `mncc external <path>`** from an earlier, fully-reverted
  2G↔IMS voice-interop attempt was silently routing every 2G call — including
  a plain call between two local subscribers — out to a socket with nothing
  useful listening, with no operator-visible cause. This is what motivated
  making MNCC mode an explicit, visible operator control instead of an
  accidental config value.
- **Asterisk-2G's own `asterisk.conf` `[directories]` overrides were silently
  no-ops** with the `(!)` template marker present (copied verbatim from the
  real stock config) — Asterisk kept checking the *stock* instance's control
  socket path instead of its own, failing every launch. The stock instance
  never surfaced this because its own override values happen to be identical
  to Asterisk's compiled-in defaults. A second, related bug in the same area:
  `astdatadir`/`astagidir` were pointed at this instance's own empty runtime
  directory instead of the real, shared, package-installed `/usr/share/
  asterisk` — Asterisk's Stasis subsystem needs real documentation files
  there and refused to start without them ("Stasis initialization failed").

---

## 3G UMTS (OsmoHNBGW)

> **Alpha.** Home NodeB Gateway — bridges a 3G femtocell's Iuh interface to
> the existing 2G-era osmo-msc (IuCS, voice/SMS) and osmo-sgsn (IuPS, data)
> over the already-running osmo-stp. `ENABLE_HNBGW_MODULE` defaults
> **disabled** (opt-in), same posture as the 2G module.

### What It Does

```
UE (3G phone) --Uu--> HNB --Iuh(HNBAP/RUA)--> OsmoHNBGW --Iu-CS/Iu-PS(SCCP/M3UA)--> OsmoSTP
                                                   |                                    |
                                               MGCP (own dedicated MGW)          routes by point-code
                                                                                to osmo-msc (IuCS) /
                                                                                osmo-sgsn (IuPS)
```

`osmo-hnbgw` is not an apt package on this host (Ubuntu's `universe` repo only
has the supporting libraries — `libosmo-hnbap`/`libosmo-ranap`/`libosmo-rua`/
`libosmo-sabp`/`libosmo-sigtran`) — it's built from source, same situation
`osmo-sip-connector-build.ts` already solved for 2G voice. **Tag `1.3.0`**,
not `1.9.0` — osmo-hnbgw's own version numbering is independent of the rest
of this host's Osmocom stack, and `1.9.0` needs a newer `libosmocore` than
what's installed; confirmed live by checking every tag's `configure.ac`
dependency floor back to `1.2.0` and then actually building `1.3.0` from
scratch (clean, zero errors, correct `--version` output).

**No changes needed on the existing 2G-era daemons' SIGTRAN side.** This
host's `osmo-stp.cfg` already has dynamic ASP registration enabled
(`accept-asp-connections dynamic-permitted`), and `osmo-msc.cfg`'s existing
SCCP/M3UA link (the same one A-interface traffic already uses) carries IuCS
too by default. Both confirmed **live**, not just from documentation: a real
`osmo-hnbgw` process registered a new ASP with the real STP (`AS Inactive` →
`AS Active`, no `osmo-stp.cfg` edits), and MSC's own `journalctl` showed
`Rx DAVA() for 0.23.5/0` — its M3UA stack seeing the new point-code become
reachable, with zero `osmo-msc.cfg` edits and no disruption to its real
A-interface traffic.

**`osmo-sgsn.cfg` does need new content** — a `cs7 instance`/point-code block
for IuPS, since that file has no SIGTRAN config at all today (2G's GPRS/EDGE
only ever needed Gb). Added via ownership-merge (`vty-config-ownership.ts`'s
`upsertVtyDirectives()`), never a blind overwrite — and as a prerequisite,
`gsm-controller.ts`'s own `osmo-sgsn.cfg` writer was converted from a full-
template regenerate to the same ownership-merge pattern first, so a 2G-side
GPRS/EDGE reconfigure can never silently wipe this module's IuPS block.
Verified with a real round-trip test against the live file before either
change shipped.

A **third, fully isolated OsmoMGW instance** (own config, own systemd unit,
own loopback `127.0.1.8`) handles this module's RTP relay — same "give each
purpose its own instance" precedent as Asterisk-2G, reusing the
already-installed `osmo-mgw` binary rather than sharing the 2G-era instance.

**No new subscriber provisioning.** OsmoHLR's `auc_3g` table — already
populated by the 2G module's "Enable 2G/3G Auth" subscriber checkbox
(`gsmEnabled`, via `sms-controller.ts`'s `sync-subscribers`) — serves both 2G
and full 3G UMTS AKA from the exact same MILENAGE k/opc row, confirmed via
OsmoHLR's own manual. 3G deliberately reuses this flag rather than adding a
parallel one, to avoid two code paths racing the same database write.

**OsmoHNodeB — a software test HNB**, direct parallel to the 2G module's
virtual BTS. Also source-built (tag `0.1.0`, same version-floor-then-real-
build verification as HNBGW), deployable from the "Virtual HNB" tab. Needs
its own dedicated GTP-U bind (`127.0.1.9`) — its default (`0.0.0.0`, the
fixed 3GPP port 2152) collides fatally with Open5GS's own UPF on this host,
found live (the daemon exits outright rather than degrading gracefully).
With that fixed, a real end-to-end test — both real binaries, both real
configs — produced a complete HNBAP registration confirmed from both sides
(`Iuh connected to HNBGW` / `Accepting HNB-REGISTER-REQ`) and a correctly
populated `show hnb all`, all before the real hardware was ever touched.

**Real hardware target: an ip.access nano3G** (same vendor family as this
project's existing 2G nanoBTS). Unlike 2G's Abis/OML model, **Iuh/HNBAP has
no remote-provisioning push** — there's no equivalent of `ipaccess-config
-o` to repoint a unit at this gateway. A real HNB is pointed at OsmoHNBGW's
Iuh IP:port via its own local/web config (out of band from this NMS), then
self-registers. The RAN page's "3G UMTS" section and the module's own
"Virtual HNB" tab both just read/display whatever OsmoHNBGW's own `show hnb
all` reports — a passive list, not an active discover-then-push flow like
2G's BTS tab. **Real RANAP-level call/attach signaling has not yet been
exercised** — only HNBAP registration; that's the next thing to prove, with
either the virtual HNB or the real nano3G.

### Components

- **Backend**: `hnbgw-controller.ts` — install/configure/status/start/stop/
  restart/uninstall lifecycle, the dedicated MGW instance, the virtual-HNB
  deploy/remove endpoints, config file viewer. `osmo-hnbgw-build.ts` /
  `osmo-hnodeb-build.ts` — source builds, same pattern as
  `osmo-sip-connector-build.ts`. `gsm-controller.ts`'s `osmo-sgsn.cfg` writer
  (ownership-merge, shared with this module's own IuPS directive).
- **Frontend**: `HnbPage.tsx` — Setup / Virtual HNB / Config Files tabs,
  following this project's standard centered-pill-tab layout. RAN page's
  "3G UMTS" section (`Umts3GSection`) — deliberately lighter-weight than the
  2G section (no per-UE data source exists yet on the backend, so it shows
  registered HNBs only, not a per-radio UE breakdown).

### Real bugs found and fixed getting this far

- **`plmn <mcc> <mnc>` doesn't exist in tag `1.3.0`'s `hnbgw` VTY node at
  all** — copied from the official manual's own example config, which turned
  out to be from a newer osmo-hnbgw release. A config with it fails to parse
  outright and the daemon refuses to start ("There is no such command").
  Confirmed via the real binary's own `--vty-ref-xml`; fixed by removing it
  (PLMN appears to come from the HNB's own HNBAP registration in this
  version instead) — found via a real live-start test, not by inspection.
- **Same version-mismatch class, same fix method**: the MGW client directive
  shape was also wrong — `1.3.0` uses the older flat `mgcp` node
  (`mgw remote-ip`/`mgw remote-port`/`mgw reset-endpoint NAME`), not the
  newer numbered `mgw <n>` sub-node the manual shows. The manual's own text
  even warns this changed in a later version.
- **OsmoHNodeB's GTP-U bind collides fatally with Open5GS's own UPF** — both
  default to `0.0.0.0:2152` (fixed port); osmo-hnodeb treats the bind
  failure as fatal and exits, so the virtual HNB could never even reach the
  Iuh-connect step. Fixed with a dedicated `gtp / local-ip 127.0.1.9`.

---

## PSTN Gateway

> **Beta.** This module has **no public SIP trunk connectivity** — no provider
> integration (Twilio, Telnyx, or similar) and no inbound DID handling exist yet.
> It only wires an **internal** extension→subscriber test path through Asterisk. A
> real trunk-provider integration is a separate, not-yet-built phase. The nav
> sidebar and the module's own page both carry a permanent "Beta" badge, and
> `ENABLE_PSTN_MODULE` defaults to **disabled** (opt-in) — unlike every other
> optional module in this project, which defaults enabled — since this is the
> first module where a bug or misconfiguration could eventually cause real-world
> billing on a linked trunk account once one exists.

### What It Does

Kamailio's S-CSCF already ships with BGCF/MGCF-style PSTN breakout routing (a
`dispatcher` group that catches any dialed number that isn't a currently-registered
subscriber) — inherited from the classic Kamailio IMS reference config this
project's templates were built from, but never previously populated or exercised.
This module wires **Asterisk** into that dispatcher as the gateway:

1. A subscriber dials an extension (any digit string, any length — real dialers
   don't prefix a "+" for in-network numbers, so this doesn't use E.164 matching).
2. S-CSCF checks its own registrar first; since nothing is registered under that
   exact extension, it routes to the PSTN dispatcher instead.
3. The dispatcher forwards the INVITE to Asterisk over its trunk transport.
4. Asterisk looks up the extension in a new extension→subscriber mapping table
   and originates a fresh INVITE back into the core to the mapped subscriber's
   real identity — the same Cx-LIR + S-CSCF termination flow that delivers every
   other call.
5. The mapped subscriber's phone rings, with real AMR-WB/EVS↔G.711 transcoding
   through Asterisk on the way — the exact same signaling/media path a live SIP
   trunk would use, just without one connected yet.

### Components

- **Backend**: `pstn-controller.ts` — Install/Configure/Start/Stop/Restart/
  Enable/Disable/Uninstall lifecycle, mirroring the SMS/VoWiFi module pattern.
  Extension→subscriber mappings live in their own MongoDB collection, decoupled
  from the core `Subscriber` entity.
- **Frontend**: `PstnGatewayPage.tsx` — Overview/architecture explainer, service
  status, extension management, install/configure controls.
- **Asterisk**: the actual media/signaling gateway — PJSIP trunk to
  Kamailio, AMR-WB/AMR-NB/G.711 codec support (confirmed built into Ubuntu's
  stock `asterisk-modules` package, no third-party patch needed), a dedicated
  PJSIP transport advertising a real, UE-reachable media address
  (`external_media_address`) instead of its own loopback bind address.

### Real bugs found and fixed getting this working end-to-end

- **rtpengine only ever saw half of each of Asterisk's two split dialogs.** A
  direct real-UE-to-UE call is one shared SIP dialog/Call-ID all the way through
  P-CSCF, so rtpengine naturally gets both the offer and answer it needs from the
  existing routing logic. Asterisk is a real B2BUA — every PSTN Gateway call is
  actually **two separate dialogs** with different Call-IDs (caller↔Asterisk,
  Asterisk↔callee), and each one independently needs its own complete offer+
  answer pair processed by rtpengine to build a working relay. This was the
  deepest, last-found layer of a long one-way/no-audio investigation — confirmed
  via packet capture and a direct bit-level RTP payload decode (real AMR-WB
  frames extracted from the wire and decoded with a real decoder) that every
  other layer (signaling, codec negotiation, delivery timing) was already
  correct.
- **Asterisk's own `bridge_native_rtp` technology** silently broke one leg's
  audio during live bridging (a same-codec frame-forwarding optimization,
  unrelated to `direct_media`) — fixed with `bridge technology suspend
  native_rtp`, re-applied on every Asterisk (re)start since it's a per-process
  runtime toggle, not a persistent config setting.
- **I-CSCF had zero in-dialog request handling** — any PRACK/UPDATE/in-dialog BYE
  routed back through it (which only happens for Asterisk-originated legs; real
  UE-to-UE calls never transit I-CSCF at all) got hard-rejected with a 406. Fixed
  with `has_totag()` + `loose_route()` + `t_relay()`.
- **Asterisk advertised its raw loopback address** in its own SDP instead of a
  UE-reachable one — fixed via `external_media_address` + `rtp_symmetric` on its
  PJSIP transport.
- Real-phone testing (Pixel 7 + iPhone) found 3 S-CSCF routing bugs: real
  dialers never prefix extensions with "+" (fixed by checking the registrar
  directly instead of E.164 pattern-matching), `enum_query()` hard-errors on
  non-E.164 input instead of failing gracefully (fixed by only attempting ENUM
  for genuinely E.164-looking numbers), and the Request-URI's domain needed
  normalizing to the core's own IMS domain before subscriber/iFC matching, for
  calls Asterisk originates back into the core.

### Current Status

Beta — confirmed working end-to-end on real hardware (iPhone↔iPhone,
iPhone↔Android extension-to-extension calling with full-duplex audio). No public
SIP trunk provider integration and no inbound DID handling — see the beta warning
above. Explicit non-goals for this phase: no emergency-calling routing, no
multi-operator IMS-to-IMS interconnect peering (I-CSCF's separate `PEERING`
logic), no TDM/ISUP/PRI hardware gateway.

---

## VoWiFi (ePDG)

*(Alpha — highly experimental, not production-ready)* Voice/data over Wi-Fi via an evolved Packet Data Gateway (ePDG), for handsets on an untrusted (Wi-Fi) access network.

> ⚠️ **This module is more experimental than IMS/VoLTE.** It was proven working end-to-end against a test IKEv2/EAP-AKA emulator (real SWx/S6b/GTP-C signaling, a real subscriber, a real static-IP assignment, EAP-AKA authentication succeeding), but a real handset has not been confirmed working. Two real bugs in upstream osmo-epdg were found and patched during testing. Do not rely on this for a production voice deployment.

### Components

- **osmo-epdg** — the ePDG itself, handling IKEv2/EAP-AKA with the UE and SWx/S6b Diameter with the HSS/AAA
- **strongSwan** — IKEv2/IPsec implementation osmo-epdg is built on
- **`gtp0` kernel module** — GTP-C tunnel to the SMF/UPF for the resulting PDN connection

### Known upstream bugs found and fixed

Two real bugs in upstream osmo-epdg were discovered and patched while getting a real tunnel working: it silently dropped the HSS-assigned static IP, and it hardcoded an oversized GTP hash-table size that a real Linux kernel's GTP driver rejects (previously misdiagnosed as random "GTP kernel-module flakiness" — it was actually deterministic). The `gtp0` kernel module is reloaded on every service start as defense-in-depth, with a manual "Reload GTP Module" button available if a tunnel ever gets stuck.

### Current Status

Server-side signaling is verified end-to-end against a test emulator (real SWx/S6b/GTP-C, real subscriber, real static IP, successful EAP-AKA). Real-phone VoWiFi is not yet confirmed — see the alpha warning above. DNS discovery for real phones (`epdg.epc.mnc<mnc>.mcc<mcc>.pub.3gppnetwork.org`) and a full fwmark/nftables policy-routing scheme (to prevent a UE-to-UE shortcut through the Wi-Fi network) are known, deferred gaps — not yet implemented.

---

## SMS over SGs

*(Beta)* Circuit-switched-domain SMS delivery — no IMS/VoLTE deployment required.

### Components

- **OsmoSTP** — SS7/M3UA/SUA signaling transfer point
- **OsmoHLR** — subscriber database (MSISDN↔IMSI mapping), separate from Open5GS's own subscriber DB
- **OsmoMSC** — connects to the Open5GS MME via the **SGs interface**, handling SMS delivery for CS-fallback

### Workflow

1. **Install** — one-click install of `osmo-stp`, `osmo-hlr`, `osmo-msc`, `sqlite3`
2. **Configure** — set the OsmoMSC SGs bind IP, OsmoHLR GSUP bind IP, and optional MME-side SGs IP; writes the `sgsap:` block into `mme.yaml` and restarts the MME
3. **Sync Subscribers** — provisions MSISDN for existing subscribers into OsmoHLR
4. **Config Files tab** — Monaco-editor-based raw editor for all three Osmocom `.cfg` files, with per-file Save and Save & Restart
5. **Enable/Disable, Start/Stop/Restart** — full lifecycle control, plus a live service-status card for all three daemons

Requires the UE to perform a **combined EPS/IMSI attach** (not EPS-only) so the MME establishes the SGs association needed for CS-fallback SMS.

---

## UE Validation

*(Beta)* Simulated 4G/5G test UEs for validating your core network without a physical radio.

### What It Does

Spins up a containerized test UE — **srsRAN** for 4G (eNB+UE in one container, built from a local Dockerfile) or **UERANSIM** for 5G (`free5gc/ueransim` image) — that attaches to your live Open5GS core exactly like a real device would, then runs through: attach, PDU session establishment, an idle period, a ping to trigger paging, and confirms the UE actually wakes up and responds.

### Features

- Live log tailing (gNB/eNB and UE logs) during the run
- Raw log download for offline analysis
- Session state persists across an NMS backend restart — a running validation session is reconciled and resumed automatically rather than becoming orphaned

### Current Status

- **4G:** fully verified end-to-end, including idle-mode paging and wake (attach → idle → page → wake → bidirectional ping)
- **5G:** connected-state reachability fully verified; idle-mode paging is **unconfirmed** — UERANSIM's simulated gNB may not implement an inactivity timer the same way a real eNB does

---

## Summary

Open5GS NMS provides a complete management solution for Open5GS deployments with:
- ✅ Safe, validated configuration management for all 17 core NFs, including SEPP
- ✅ 5G inter-PLMN roaming (SEPP/N32) and a DNS/FQDN migration path for carrier-grade addressing
- ✅ Real-time network visualization
- ✅ Comprehensive subscriber management, including per-session Framed Routing
- ✅ Powerful automation tools
- ✅ Production-ready safety features
- ✅ Voice (IMS/VoLTE — confirmed on real iPhone hardware; VoWiFi — alpha) and SMS (SGs) modules, all optional
- ✅ End-to-end validation via simulated test UEs, no physical radio required

## SNMP Monitoring

Install and manage a read-only Net-SNMP agent from the NMS. The module exports host health, 4G/5G UE and radio counts, Open5GS service health, `ogstun` counters, and standard `IF-MIB` interface data for PRTG and other SNMP managers. The generated Open5GS MIB can be downloaded directly from the page.

See [SNMP monitoring](snmp-monitoring.md) for installation, OIDs, PRTG usage, and security guidance.

---

For detailed usage instructions, see **[INSTALL.md](../INSTALL.md)** and other documentation.
