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
15. [2G GSM (Osmocom)](#2g-gsm-osmocom)
16. [3G UMTS (OsmoHNBGW)](#3g-umts-osmohnbgw)
17. [PSTN / Voice Gateway](#pstn--voice-gateway)
18. [VoWiFi (ePDG)](#vowifi-epdg)
19. [SMS over SGs](#sms-over-sgs)
20. [MMS](#mms)
21. [UE Validation](#ue-validation)
22. [Security Gateway (SecGW)](#security-gateway-secgw)
23. [RF Planning](#rf-planning)
24. [IP Plan Tool](#ip-plan-tool)
25. [RAN Kill Switches (Dashboard)](#ran-kill-switches-dashboard)
26. [SigScale OCS (Online Charging, Diameter Gy + Ro)](#sigscale-ocs-online-charging-diameter-gy--ro)
27. [Charging Plans](#charging-plans)
28. [Call History (CDR)](#call-history-cdr)
29. [Traffic History](#traffic-history)
30. [UE Signal Monitoring](#ue-signal-monitoring)
31. [SNMP Monitoring](#snmp-monitoring)

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
- A "SAS Logs" quick-select jumps to Docker mode and filters to SAS lines. The SAS protocol itself now runs in the `sasbench` container, so its wire log lives in SASBench's own Messages page rather than the backend's log stream.

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
new-host restore, and extended twice since (2026-09-24, 2026-09-29) as real gaps were
found. Twelve independently selectable categories:

| Category | Contents |
|---|---|
| Subscribers | `mongodump --db open5gs` — subscribers (APNs/IPs/security keys), subscriber groups, APN profiles, RF Planning projects, TWAMP targets/history, users, audit log. SAS data is **not** here: SASBench keeps its own SQLite database in the `sas-data` Docker volume, backed up separately. |
| Core NF Configs | All 17 core NF YAML files (`/etc/open5gs/*.yaml`, including `sepp1.yaml`) |
| SUCI Keys | 5G-AKA home-network private/public keys (`/etc/open5gs/hnet`) — irreplaceable, not regenerable |
| SecGW Certificates | Security Gateway's own CA and every issued per-radio IPsec certificate/key — irreplaceable, not regenerable by re-running Configure |
| Optional Module Configs | IMS/VoLTE, SMS (SGs + VectorCore), MMS, PSTN Gateway, VoWiFi, TWAMP, FRR source-build state, chrony, syslog forwarding — each module's own NMS-side settings file |
| L3 / IP Network Config | FRR (EIGRP) config and host interface addressing (netplan) and the dummy-interface set |
| DNS / BIND | `named.conf` + every FQDN zone file |
| GenieACS (Radio Provisioning) | GenieACS's own separate MongoDB database — device inventory, presets, provisioning scripts, TR-069 session history |
| NMS Login (Users) | This NMS's own admin/viewer accounts (Lucia + SQLite) — isolated from the `open5gs` database, so a restore without it comes back up with no real user accounts. Also carries UE Signal Monitoring's AES-256-GCM-encrypted radio credentials + decryption key, and the RAN Kill Switches' active block list |
| UI Module Toggles | The repo `.env`'s `ENABLE_*` flags controlling which optional module pages appear in the frontend nav (needs a frontend rebuild to take visible effect), plus a small allowlist of outbound-API credentials (eSIM's Simlessly keys, GenieACS UI's JWT secret/port) |
| SigScale OCS Data | OCS's own Mnesia database — every rating plan/offer, registered Diameter client, and subscriber's real prepaid balance/bucket |
| Radio Config Backups | Per-radio point-in-time config snapshots saved after every successful GenieACS provisioning change — history only, not the radio's current config (already covered by the GenieACS category) |

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

Restoring onto a genuinely new machine is a two-step process: `backup-restore/
bootstrap-fresh-host.sh` first (base packages — Docker, MongoDB, Open5GS itself),
then a Full Restore with "This is a fresh host" checked, which installs real
packages/binaries for every optional module the backup used before writing any of
its config, then restarts everything so the restored config actually takes effect
end-to-end — not just files copied into place. Restoring back onto the same host the
backup came from doesn't need either step.

### Legacy Backup Types

**Configuration Backups:**
- All 17 configurable NF YAML files, plus `sepp2.yaml` (the visited-PLMN template file — not independently editable via the UI, but swept up in every full backup/restore cycle)
- Stored in `/etc/open5gs/backups/config/YYYY-MM-DD-HHMM/`
- Includes exact file permissions

**MongoDB Backups:**
- `open5gs` database only (subscribers, groups, APN profiles, RF Planning, TWAMP, users, audit log). SAS state lives in SASBench's own `sas-data` volume, not in Mongo.
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

*(Stable)* Full IMS core integration for voice-over-LTE and SMS-over-IP. **Confirmed
working end-to-end with real, unmodified iPhone and Android hardware on PLMN
001-01**, including real-to-real calls between two registered phones with proper
dedicated voice bearers, not just calls to/from the built-in test-number bot or a
softphone.

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

Both iPhone and Android are confirmed working for real-phone VoLTE calling,
including calls between the two.

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
   separate Asterisk instance the [PSTN / Voice Gateway](#pstn--voice-gateway) module owns,
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
- **`osmo-sip-connector`'s `MNCC_SETUP_COMPL_IND` had a hardcoded 5s
  timeout** that a real over-the-air CONNECT↔CONNECT-ACK round trip could
  legitimately exceed under normal GSM scheduling, tearing down a call both
  legs had just marked connected. Widened to 15s for just that call site,
  then to 30s (2026-09-26) after a real mixed-RAN test session reproduced
  the same failure 3 times even at 15s — still a stopgap, not a confirmed
  root cause. Every other `start_cmd_timer()` caller stays at the original
  5s. Baked into the module's own build pipeline so a reinstall picks it up
  too.
- **Asterisk-2G's dialplan had no real route to the external PSTN
  trunk** — a 2G subscriber dialing a genuine external number fell into a
  catch-all built only for "dial another known subscriber's raw MSISDN,"
  looping the call back into `osmo-msc` as an unrecognized-subscriber
  request instead of ever reaching PSTN. Fixed by routing anything that
  isn't a known subscriber's own MSISDN out through the PSTN Gateway's
  trunk instead.
- **Still open, not yet resolved by either fix above**: a real,
  intermittent 2G radio-link reliability problem (`Timer T200 expired` →
  `Radio Link Failure`) on the BTS's own real hardware, affecting either 2G
  UE under test unpredictably — occasionally severe enough that a call
  connects with no audio, or drops mid-setup. `radio-link-timeout` was
  raised from 32 to 64 (osmo-bsc's real configurable max) as a mitigation,
  not a fix. If this resurfaces, it is not necessarily this project's code —
  check the BTS's own hardware/RF condition first.

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

## PSTN / Voice Gateway

> **Stable.** Internal short-code/MSISDN dialing and Cross-RAN Calling (bridging
> 4G/5G and 2G short codes across this module's own Asterisk instance and
> Asterisk-2G) are both confirmed stable. The external SIP trunk + inbound DID
> mapping mechanism has been tested with real external calling and confirmed
> working, including a real inbound call routed all the way to a 2G subscriber
> with full audio. `ENABLE_PSTN_MODULE` defaults to **disabled** (opt-in) —
> unlike most optional modules in this project, which default enabled — since
> this is the module where a bug or misconfiguration could eventually cause
> real-world billing once a commercial trunk provider account is linked.

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

Stable — confirmed working end-to-end on real hardware (iPhone↔iPhone,
iPhone↔Android extension-to-extension calling with full-duplex audio), plus a
built and live-verified external trunk + inbound DID mapping mechanism (real
provider connectivity deliberately not configured — see the note above) and
Cross-RAN Calling to 2G with real over-the-air calls confirmed in both
directions. Explicit non-goals: no emergency-calling routing, no
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

## MMS

> **Beta.** Real end-to-end MMS confirmed working on a real UE. Lives as a
> second tab on the SMS/MMS page, not a separate nav entry.
> `ENABLE_MMS_MODULE` defaults **disabled** (opt-in).

### Components

- **VectorCore MMSC** — the real MM1 (UE↔MMSC) message-relay backend
- **`mm1-msisdn-proxy.go`** — a small, compiled-Go reverse proxy this
  project builds and runs in front of VectorCore's public MM1 port, its own
  dedicated `vectorcore-mm1-proxy` systemd unit

### Why the proxy exists

Real phones send MMS PDUs with no usable `From` field — VectorCore expects
a GGSN/PGW-style `X-MSISDN` HTTP header to identify the sender instead. The
proxy resolves the sending subscriber's MSISDN from their Framed-Routing UE
IP and injects that header before forwarding to VectorCore's real `:8002`.

### Real bugs found getting this working

- VectorCore logs its entire MM1 request path at `Debug` level while
  shipping configured at `Info` — looked exactly like requests weren't
  reaching the app at all until the log level was corrected
- Real phones' missing `From` field (see proxy rationale above) — without
  the injected `X-MSISDN` header, VectorCore has no way to attribute an
  inbound MMS to a sender

### Workflow

1. **Install** — installs VectorCore MMSC and builds/deploys the MSISDN
   proxy from the same already-guaranteed Go toolchain this project uses
   elsewhere (deliberately not Node, which isn't a documented prerequisite)
2. **Configure** — wires the proxy's target MM1 IP/port and Framed-Routing
   lookup
3. Full lifecycle control (Start/Stop/Restart) for both VectorCore and the
   proxy's own systemd unit

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

## Security Gateway (SecGW)

> **Alpha.** Real IPsec tunnels are confirmed live in production for both
> supported radio vendors simultaneously, but the module is still early —
> `ENABLE_SECGW_MODULE` defaults to **disabled** (opt-in), unlike most
> optional modules in this project.

### What It Does

Terminates IPsec (strongSwan/`ipsec`) tunnels between this host and each
attached radio, so S1AP/GTP-U traffic to the core network functions rides
inside an authenticated, encrypted ESP tunnel instead of plaintext. Each
radio gets its own dedicated pool address / traffic selector — never a
shared CIDR, because shared selectors collide on a single kernel XFRM
policy slot, and whichever radio negotiates last silently steals it from
the others (they still show `ESTABLISHED` in `swanctl`, but with no real
traffic path — a real production outage this project hit before fixing
it).

Baicells and Nokia radios are configured through **fundamentally
different IPsec models**, and the module has to know which one it's
talking to:

- **Baicells** negotiates its tunnel address dynamically via IKEv2
  Configuration Payload (CP) — the gateway hands out a pool address per
  radio at negotiation time (`allocatePoolAddress()`).
- **Nokia AirScale has no CP support at all** (confirmed by reading the
  radio's own IPsec configuration page directly) — it only offers static
  tunnel endpoints and traffic selectors as one or more standalone
  "Protect" policies. For Nokia, `remote_ts`/`remote_addrs`/the IKE
  identity all have to be the radio's own real IP address, never the
  pool/CP mechanism. If a Nokia radio needs to reach anything beyond the
  auto-derived core-NF pair (for example the BIND DNS server), that's
  added via `extraLocalCidrs` as a real additional "Protect" policy on the
  radio's own side, matched by widening this gateway's `local_ts` — the
  radio's "Bypass" IPsec action isn't reliably usable for this.

### Components

- **Backend**: `secgw-controller.ts` — Install/Configure/Start/Stop
  lifecycle, per-radio pool/traffic-selector allocation, vendor-specific
  config generation. `secgw-build.ts` — strongSwan install/build plumbing.
- **Frontend**: `SecGWPage.tsx` — tunnel status, per-radio configuration.
- **strongSwan (`ipsec`/`swanctl`)** — the actual IPsec daemon doing tunnel
  negotiation and ESP encryption/decryption.

### Real bugs found and fixed getting this working end-to-end

- **Shared traffic-selector CIDR caused a real multi-radio outage.** Every
  radio was originally configured with the same pool CIDR as its traffic
  selector. The kernel only keeps one XFRM policy per selector, so the
  *last* radio to negotiate silently won that policy slot — every other
  radio's tunnel showed `ESTABLISHED` in `swanctl` (looking completely
  healthy) while carrying zero real traffic. Fixed by giving every radio
  its own unique single-address pool/traffic-selector via
  `allocatePoolAddress()`.
- **Nokia's lack of IKEv2 Configuration Payload support wasn't discovered
  from documentation — it was confirmed live** by reading the radio's own
  IPsec page directly, after an approach built for Baicells' CP-based
  model didn't work for Nokia. The fix (`resolveRemoteTs()`) branches
  vendor behavior explicitly rather than trying to find one configuration
  shape that works for both.

### Current Status

Alpha — real IPsec tunnels confirmed live simultaneously for 3 Baicells
eNBs (CP/virtual-IP based) and 1 Nokia AirScale (static endpoints, no CP),
with real S1AP/GTP-U traffic verified flowing through the tunnel via
packet capture (ESP wrapper + a decrypted SCTP heartbeat to the MME).
`ENABLE_SECGW_MODULE` defaults disabled — opt-in only.

---

## RF Planning

> **Alpha, actively being built out.** This is Phase 1 of a planned
> multi-phase tool — expect incomplete phases and possible breaking
> changes between releases. `ENABLE_RF_PLANNING_MODULE` defaults to
> **disabled** (opt-in).

### What It Does

A deterministic LTE link-budget and site-geometry planning engine — the
first phase of a longer-term goal to build a full, practically useful RF
planning tool (in the spirit of commercial tools like Atoll or iBwave,
including eventual PDF report export), not just a set of standalone
calculators. Phase 1 focuses on the deterministic math itself
(link-budget and geometry calculations); later phases are planned but not
yet built.

### Components

- **Backend**: `rf-planning-controller.ts`, `rf-planning-projects-controller.ts`,
  `rf-planning-reports-controller.ts`.
- **Frontend**: `RfPlanningPage.tsx`.

### Design Notes

This phase's design was reviewed before implementation began, and two
real errors were found and fixed in the original specification itself
during that review — caught before any code was written, not after.
Because this module is still under active, phased construction, treat
anything not explicitly confirmed elsewhere in this documentation as
subject to change.

### Current Status

Alpha — Phase 1 (the deterministic engine) only. `ENABLE_RF_PLANNING_MODULE`
defaults disabled. Do not assume feature parity with a commercial RF
planning tool yet; later phases are planned, not built.

---

## IP Plan Tool

> **Beta.** A bulk IP-address planning/apply tool, not a source of truth — it
> never overwrites a module's own IP unless you explicitly run it, and it always
> shows you a proposed plan to review before anything is applied. SEPP's three
> address fields and the DNS/BIND9 listen address are plan-only by design —
> applying either live goes through their own dedicated pages, since a SEPP
> address change's only real apply path is a full 17-NF core restart.

### What It Does

Re-addressing a deployment after standing it up used to mean visiting every
module's own page one at a time and manually re-typing the same new subnet
into each one. This tool turns that into one guided flow:

1. **Propose** — click "Propose IP Plan," either accept the auto-detected
   primary interface's subnet or type a different one, and the tool reads
   every module's own *current* live state (never a cached/stale value) and
   proposes a non-colliding address for anything that's still pointing at a
   gap (a loopback default, or never configured at all). A module that's
   already pointing at a real, live address proposes no change and starts
   unchecked — nothing gets touched unless you actually check its row.
2. **Review** — the plan table shows current vs. proposed side by side, a
   checkbox per row, and — for anything capable of applying live — a plain-
   English restart-cost hint (a single core-17 field restarts only the NF
   whose file actually changed; IMS is the heaviest, 14+ sequential service
   restarts).
3. **Apply** — click "Apply Plan." Checked rows that are live-apply-capable
   get pushed to their real module's own configure function immediately
   (restarting only what that module's own logic decides needs restarting);
   everything else — including SEPP and BIND9's listen address, always — is
   just saved to a small planning registry for that module's own page to
   pre-fill from later.

### Components

- **Backend**: `ip-plan-controller.ts` (routes), `ip-plan-apply-usecase.ts`
  (the actual per-module dispatch — an async job, same polling pattern as the
  module-wide "Fix All" action, since a full batch touching IMS can run
  minutes long), `ip-suggest.ts` (non-colliding address suggestion within a
  subnet), `main-interface.ts` (detects the host's own primary interface/CIDR
  for the subnet pre-fill).
- **Frontend**: `IpPlanTab.tsx`, a tab on the Auto-Configuration Wizard page —
  idle view (current values only) → proposed view (editable, checkboxed,
  restart-cost hints) → live per-row apply-result badges while a run is in
  progress.

### Live-apply coverage

| Applies live (opt-in per row) | Plan-only, always |
|---|---|
| Core-17: MME S1-MME, SGW-U S1-U, AMF NGAP, UPF N3, SMF/SGW-C/local-UPF PFCP (batched into one Auto-Configuration apply per run) | SEPP: SBI, N32-C, N32-F |
| Security Gateway | BIND9/DNS listen address |
| VoWiFi ePDG | |
| 2G GSM (osmo-bsc/MGW, osmo-sgsn Gb) | |
| IMS (P-CSCF, RTPEngine) | |
| PSTN Gateway's external trunk | |
| MMS MM1 proxy | |

IMS is always applied before PSTN/MMS within the same batch, since both of
those depend on IMS already being configured — if IMS's own step fails
partway through a batch, PSTN/MMS entries in that same run are marked failed
outright rather than attempted against a half-applied IMS.

### Design history

The first version of this tool worked the opposite way: it silently wrote
back to a shared registry after every module's own independent Configure
action, and every module's page silently read from that registry on load.
That's an ambient background-sync mechanism with no single moment an operator
actually decided to change anything — corrected after direct user feedback
that the tool should only ever act on an explicit "Propose → Apply" click,
never as a side effect of using some other page normally. The rewrite deleted
the old bulk-save endpoint and its frontend client method outright, rather
than leaving them in place unused — a deliberate choice so any accidentally-
still-present call site would fail to compile instead of silently doing
nothing.

### Current Status

Beta — confirmed working end-to-end, including a real live Propose → Apply run.
Known edge case: an MME/AMF interface currently bound by interface name
(`dev:`) rather than a static address reads as "not configured" and applying
a plan there converts it to address-binding — a real behavior change beyond
just the IP itself, not specially called out in the UI yet.

---

## RAN Kill Switches (Dashboard)

> **Beta.** Real, disruptive actions on live radios — not a simulation. The
> 2G button in particular has genuinely different real-world impact than the
> other three (see below); read the confirmation dialog before clicking any
> of them on a system with real attached traffic.

### What It Does

Five buttons on the main Dashboard header let an operator take radios
offline from the NMS side without touching any radio's own configuration:
**Block RAN** (all four generations at once), and **Block 2G** / **Block
3G** / **Block 4G** / **Block 5G** individually. Each one bulk-blocks every
currently connected/registered radio of that generation with one click, and
each button flashes red for as long as anything of that generation is
currently blocked — clicking a flashing button unblocks everything of that
generation instead of re-blocking.

The four generations are **not** the same mechanism underneath:

- **4G and 5G** sever the radio's own control-plane and user-plane paths to
  the core (S1-MME+S1-U, or N2+N3) via a dedicated nftables table on this
  host only — the radio itself is never touched, never rebooted, never
  reconfigured, and can be restored instantly.
- **3G** severs the HNB's Iuh path to HNBGW the same way (nftables, host
  only) — just one port, since a femtocell's actual voice/data traffic never
  touches the HNB directly (it's Iu-CS/Iu-PS from HNBGW onward).
- **2G is a real, different kind of action**: it administratively locks the
  BTS at osmo-bsc itself (the same mechanism as the RAN page's own per-BTS
  Block button) — every camped UE drops immediately and the cell stops
  broadcasting until unlocked. This is a real device-level action, not a
  host-only network rule, and the UI deliberately makes it look and read
  differently from the other three so an operator never mistakes one for
  the other.

### Components

- **Backend**: `radio-block-controller.ts`/`radio-block-service.ts` (4G, one
  of the original per-radio block mechanisms this project shipped),
  `gnb-block-controller.ts`/`gnb-block-service.ts` (5G, an exact structural
  mirror), `hnb-block-controller.ts`/`hnb-block-service.ts` (3G, built new —
  see below), `gsm-controller.ts`'s `blockBtsByIdx`/`/bts/block-all` (2G,
  reuses the real osmo-bsc admin-lock).
- **Frontend**: `DashboardPage.tsx` (the five buttons + confirm dialogs),
  `RANPage.tsx` (the same flash-red treatment on every individual per-radio
  Block/Unblock button, not just the aggregate Dashboard ones).

### Real bugs found and fixed getting this working end-to-end

- **3G had no blocking mechanism of any kind before this feature.** Built
  from scratch, mirroring the 4G/5G nftables pattern exactly — with one real
  difference: 3G's Iuh port is operator-configurable in this project (unlike
  S1-MME/N2's fixed 3GPP port numbers), so the port is read live rather than
  hardcoded, and encoded into each nftables rule's own tracking comment — a
  port change while a block is active is detected as "the old rule is no
  longer correct" by the existing reconcile loop, instead of silently
  leaving a stale rule in place that blocks nothing while still looking
  active.
- **The 2G BTS Block/Unblock feature had never actually worked, since the
  day it was first built** — only discovered because this feature finally
  gave it its first-ever real UI trigger and someone actually clicked it.
  The command it sent (`change-adm-state locked` at a low-level NM
  pseudo-node) was accepted with zero error of any kind, anywhere — but
  osmo-bsc runs a background reconciliation loop that silently re-unlocks
  that exact class of object on its own, with no way to tell it to stop from
  that command. Root-caused by reading osmo-bsc's own real source code
  (not guessed) and fixed with a completely different, correct command
  (`rf_locked`, which does have the guard the other one lacked) that lives
  in a different part of osmo-bsc's VTY entirely.

### Current Status

Beta. 4G/5G blocking reuses long-proven mechanisms. 3G's new nftables
service has not yet been exercised against real 3G hardware traffic (the 3G
module itself is still alpha). The 2G fix has been rebuilt, redeployed, and
confirmed clean on the radio's own live state, but not yet independently
confirmed by clicking the button through a real UI action end-to-end.

---

## SigScale OCS (Online Charging, Diameter Gy + Ro)

> **Beta.** Real-time prepaid credit-control charging for 4G/EPC sessions only —
> 5G NR sessions are never charged by this integration, since Open5GS's SMF has
> no Nchf (5G online-charging) client upstream at all. Voice/airtime charging
> (Ro) is a separate toggle, defaulting **off**, same risk class as data (Gy) —
> both touch an always-on core NF's live Diameter peer list. `ENABLE_OCS_MODULE`
> defaults **disabled** (opt-in).

### What It Does

Open5GS's SMF has shipped a native Diameter Gy client since v2.4.7, but it sat
completely dormant in this deployment until this module wired it to something.
SigScale OCS (Erlang/OTP, a real third-party Online Charging System, installed
as an apt package from a pinned Google-Cloud-hosted `.deb`, not source-built)
is that something:

1. **Configure** writes OCS's own `sys.config`, registers SMF as a trusted
   Diameter client via `ocs:add_client/6` (RPC'd into the real running Erlang
   node — Mnesia only works there, not on a throwaway node), upserts a Gy
   `ConnectPeer` line into `smf.conf`, restarts `open5gs-smfd`, and verifies a
   real `STATE_OPEN` Gy connection from SMF's own log.
2. With Gy connected, every 4G/EPC PDN session SMF creates is now subject to
   real prepaid credit-control — a subscriber with an exhausted balance is
   genuinely cut off, not just logged.
3. **Voice/airtime charging (Ro)**, a separate later addition, completes a
   dormant `#!ifdef WITH_RO` block `kamailio_scscf.cfg` already carried. It
   shares OCS's existing Gy listener (same Diameter Application-Id 4,
   Credit-Control) and is toggled independently via `setVoiceChargingEnabled()`.

No rating-plan/balance/subscriber CRUD lives in this NMS — the Setup tab links
out to OCS's own Polymer web GUI and REST API docs instead, matching this
project's "link out, don't reimplement" convention for full third-party apps.
(The **Charging Plans** feature, documented separately below, is a deliberately
simplified GUI layer on top of this.)

### Components

- **Backend**: `ocs-controller.ts` — Install/Configure lifecycle, the Gy
  `ConnectPeer` upsert (`upsertSmfGyPeer()`/`removeSmfGyPeer()`), the
  `ocs:add_client/6` RPC registration, the Ro toggle.
- **Frontend**: `OcsPage.tsx` — status, install/configure controls, links out
  to OCS's own admin UI.
- **SigScale OCS**: the real charging engine — Erlang/OTP, its own Mnesia
  database, its own Diameter (Gy/Ro) and HTTP (REST/Polymer GUI) listeners.

### Real bugs found and fixed getting this working end-to-end

- **`smf.conf` now carries three independently-owned `ConnectPeer` lines** (Gx
  from Open5GS core itself, S6b from VoWiFi, Gy from this module) — each
  module's upsert function is regex-scoped to strip only its own naming prefix
  (`ocs.*` for this one), never the whole file, and each keeps its own
  separate one-time backup file so a second module's first write can't
  silently clobber the first module's original.
- **Port conflict**: OCS's default HTTP port 8080 collided with PyHSS's own
  API service — moved to 8093 after confirming 8090–8092 were also taken by
  other modules.
- **Wildcard-bind conflict**: OCS's default `0.0.0.0:3868` Diameter bind can
  silently lose to another NF's dedicated-IP freeDiameter listener while the
  Erlang `diameter` application still reports its own supervisor "up" — gave
  OCS its own dedicated loopback, `127.0.1.10`.
- **OCS is not accept-by-default for Diameter peers** — it rejects an
  unrecognized peer with `3010/DIAMETER_UNKNOWN_PEER` until explicitly
  registered via `ocs:add_client/6`, which needs Mnesia and so must run as an
  RPC into the real node, not a throwaway one.
- **Origin-Host/Origin-Realm mismatch**: OCS's defaults derive from the host's
  own hostname/DNS search domain, not anything PLMN-related — freeDiameter
  rejects the CEA outright until `sys.config`'s diameter options set these
  explicitly to a real, deployment-specific identity.
- **cdp (Kamailio's own Diameter stack, used for Ro) behaves differently from
  freeDiameter (used for Gy) in two ways that cost real debugging time**: (1)
  cdp resolves a configured Peer FQDN via a real synchronous DNS lookup at
  connect time — freeDiameter takes an IP directly and never needed this, so
  it never surfaced the gap; any Peer FQDN not already covered by this
  project's own IMS BIND zone needs an `/etc/hosts` entry too, or cdp fails
  outright. (2) cdp does **not** bind its outbound Diameter connection to the
  peer's own configured listen address the way freeDiameter does — registering
  S-CSCF's real configured IP as OCS's trusted client produced a real
  `3010/DIAMETER_UNKNOWN_PEER` rejection, because the connection actually
  arrived from `127.0.0.1`. Fixed with a dedicated `OCS_CLIENT_SOURCE_IP`
  constant, always registered instead of the peer's nominal IP.
- **Five separate real bugs inside the compiled `ims_charging.so` module
  itself**, found getting a real Ro call to complete, all confirmed via OCS's
  own `erlang.log` rather than guessed: duplicate Origin-Host/Realm AVPs, two
  AVPs that don't belong in a CCR at all (Accounting-Record-Type/Number,
  Vendor-Specific-Application-Id), a missing mandatory Auth-Application-Id,
  and a subscriber-identity format (`sip:` URI vs `tel:` URI) OCS's own lookup
  didn't recognize. All five are now real unified-diff source patches baked
  into the module's build pipeline — the same `apt-get source` → `patch` →
  build → ABI-verify → deploy pipeline already used for this project's other
  patched Kamailio modules — not just hand-patched on one host.

### Current Status

Beta. Gy (data charging) end-to-end confirmed live. Ro (voice/airtime
charging) end-to-end confirmed live with a real completed call. 4G/EPC only —
explicitly, permanently out of scope for 5G NR, since Open5GS's SMF has no 5G
online-charging client to wire up at all.

---

## Charging Plans

> **Beta**, voice half confirmed working end-to-end. A deliberately simplified
> GUI layer over SigScale OCS's own full rating-plan vocabulary, built after
> explicit user feedback that the SigScale GUI itself was too complex for
> day-to-day plan management. Requires SigScale OCS installed and configured
> first; the voice-cap half additionally depends on the Ro toggle above.

### What It Does

One GUI "Plan" — a name, a data cap in GB, a voice cap in minutes — maps to
one OCS bundle offer, referencing a data sub-offer and a voice sub-offer under
the hood. Plans are managed in their own Mongo collection, mirroring this
project's existing Subscriber Groups CRUD/assignment shape. Subscribers can be
assigned to a plan two ways: a bulk-select toolbar action on the Subscribers
page, or a per-row "Set plan" control in the Plan column (added after the
bulk-only flow proved hard to discover in practice).

An "Unlimited" plan is auto-provisioned on every OCS Configure — not a
dedicated no-cap code path, but a deliberately huge finite cap (1,000,000 GB /
1,000,000 minutes), specifically to avoid exercising an untested interaction
with the still-open rating-engine bug described below. Any cap at or above
100,000 (GB or minutes) renders as "Unlimited" in the UI rather than the raw
number.

### Components

- **Backend**: `charging-plans-controller.ts` — plan CRUD, subscriber
  assignment, the default-Unlimited-plan provisioning.
- **Backend**: `ocs-reservation-guard.ts` — the mitigation for the rating-
  engine bug below.
- **Frontend**: `ChargingPlansPage.tsx`.

### Real bugs found and fixed getting this working end-to-end

- **A subscriber's data and voice usage could silently draw from two
  unrelated pools.** Found while chasing a usage readout stuck at 0 despite a
  confirmed real charge having happened: the assignment code linked a
  subscriber's IMSI and MSISDN to OCS *separately* — Gy (data) keys off IMSI,
  Ro (voice) keys off MSISDN, so linking them independently landed the same
  subscriber on two disconnected OCS products with two disconnected buckets.
  Fixed to link every identity for one subscriber to a single shared product,
  atomically (a second, related bug in the fix's own "already linked"
  short-circuit was also found and fixed).
- **A real, still-unresolved bug lives inside OCS's own rating engine**
  (`ocs_rating:charge2`, a `function_clause` crash specifically on session
  termination) that periodically leaks stuck Gy/Ro reservations across
  multiple subscribers. This is **not fixed** — no exact-version source is
  obtainable for the installed OCS release, and the compiled `.beam` has
  neither debug info nor an exported `charge2` function to probe directly.
  What exists instead is a mitigation: `OcsReservationGuard` runs
  continuously in the background (on by default), sweeps every 30 minutes,
  and clears any reservation entry older than 2 hours via a
  balance-preserving write that never touches the actual remaining balance.
  It keeps the symptom from requiring manual intervention; it does not fix
  the underlying engine bug. Filing this as an upstream SigScale issue is the
  recommended next step, not yet done as of this writing.

### Current Status

Beta. Voice-cap half confirmed working end-to-end. The reservation-leak
mitigation is running and effective as a workaround, but the root cause in
OCS's own rating engine remains genuinely unresolved — don't represent this
charging path as fully hardened without that caveat.

---

## Call History (CDR)

> **Beta.** Unified call detail records across PSTN, 2G, and 4G/5G IMS calls,
> built in three independently-risk-staged phases. Phase 1 is stable and
> verified against a real dataset; Phase 2's code is deployed but not yet
> confirmed against a real end-to-end test call; Phase 3 is confirmed working
> against multiple real test calls.

### What It Does

Rather than introduce a new primary datastore, this feature syncs call
records from each existing system's own real source of truth into one shared
`nms_cdr` Mongo collection (retention-configurable, defaulting to a 180-day
TTL):

- **Phase 1 — PSTN Gateway.** Tails Asterisk's own CSV CDR output. Stable,
  verified against a real 76+-row dataset.
- **Phase 2 — Asterisk-2G.** Same CSV-tailing approach, applied to the
  second, isolated Asterisk instance the 2G module owns. A real bug was found
  and fixed here: the controller never created the `cdr-csv/` subdirectory
  Asterisk's own `cdr_csv` module needs to write into, so it silently
  recorded nothing at all. The fix is deployed, but a real end-to-end test
  call confirming it actually writes records now has not yet been done.
- **Phase 3 — direct 4G/5G IMS-to-IMS calls.** The one call path with no
  B2BUA CDR of its own to tail, so this uses Kamailio's own `acc` module
  instead — basic flag-based accounting, deliberately not `acc`'s newer
  `cdr_enable` mode (which depends on a `dialog` module this deployment
  doesn't load). Gated behind both a compile-time build flag and an
  independent runtime toggle ("Direct IMS Call Recording" on the Call
  History page's own Settings panel).

### Components

- **Backend**: `cdr-store.ts`, `cdr-sync-monitor.ts`, `cdr-controller.ts`.
- **Frontend**: `CallHistoryPage.tsx`.

### Real bugs found and fixed getting this working end-to-end

- **Phase 2's missing `cdr-csv/` directory**, described above — silent
  data loss with no error surfaced anywhere.
- **A static IMS Kamailio template only reaches the live host through a full
  IMS Install/Configure — a lightweight toggle setter like the one this
  feature uses does not redeploy it.** Wiring Phase 3 exposed this directly:
  the live host's Kamailio config copy was a full day stale, missing both an
  unrelated same-day fix and this feature's own new `WITH_CDR` blocks.
  Flipping the runtime toggle restarted the Kamailio service and reported
  success, but the actually-running config still had no `acc` module loaded
  at all — only the small generated include file had been rewritten, not the
  static template it's included from. If a static IMS template is edited and
  needs to go live without a full re-Configure, it has to be redeployed to
  its real host path manually first.

### Current Status

Phase 1 (PSTN): stable, live-verified. Phase 3 (direct IMS): confirmed fully
working end-to-end against 3 real test calls, including a call that fell to
voicemail and a PSTN-Gateway-routed call correctly captured as its real two
separate B2BUA-split dialogs. Phase 2 (Asterisk-2G): code deployed, real
end-to-end confirmation still outstanding — don't represent this phase as
verified until that happens. `missed_calls` (busy/rejected call) tracking is
implemented per Kamailio's documented, stable module behavior, but has not
yet been empirically verified against a real busy call. Note: a voicemail
pickup is indistinguishable from a normal human answer at the SIP/`acc`
level (both are ordinary 2xx-terminated INVITE transactions) — this is
documented behavior in the UI's own info banner, not a bug.

---

## Traffic History

### What It Does

Shows aggregate and per-subscriber network traffic history (throughput
over time) across 2G, 4G, and 5G together — a radio filter and a RAN-type
filter narrow either view to one specific cell or one generation.
Deliberately **does not maintain its own time-series store** — this
project already runs a Prometheus + Grafana monitoring stack for every
core network function's own metrics, so Traffic History is built as a
consumer of that existing time-series database rather than a second one.

An earlier version of this feature *did* build its own MongoDB-backed
time-series store for this data. It was replaced once it became clear
Prometheus was already deployed and already doing exactly this job — a
real design correction, not a bug fix, and a useful precedent for any
future feature that might be tempted to stand up its own metrics
storage.

Per-subscriber byte counters for 4G/5G are collected by a dedicated
nftables accounting table (`subscriber-ip-accounting.ts`) — one counter
rule pair (upload/download) per subscriber UE IP, in its own `inet
open5gs_nms_acct` table so it never collides with any other nftables-based
feature in this project. 2G data traffic (GPRS/EDGE) doesn't go through
Open5GS's own UPF at all — a completely separate GGSN implementation
(osmo-ggsn) handles it, so its own counters come from osmo-sgsn's VTY
instead and are exposed under a separate metric family. Both families,
plus each core NF's own GTP counters, are exposed via a `/metrics`
endpoint (`prometheus-metrics.ts`) that the existing Prometheus instance
scrapes like any other target. The frontend's filter parameters are
translated directly into a PromQL `query_range` call, and Prometheus's own
`rate()` computes throughput (Mbps) — no rate/delta math is duplicated on
this project's own side. Aggregate (network-wide) throughput can't be
sliced by radio — a real 3GPP architectural fact, not a gap: 4G/5G share
one GTP tunnel endpoint per APN/DNN with no per-cell dimension, and this
is reflected honestly (the combination is rejected, not silently ignored)
rather than pretending to support it.

### Components

- **Backend**: `subscriber-ip-accounting.ts` (4G/5G nftables byte
  counters), `radio-info-metrics.ts` (shared per-subscriber
  radio/generation lookup used by the filters), `prometheus-metrics.ts`
  (the `/metrics` endpoint Prometheus scrapes), `traffic-history-
  controller.ts` (thin PromQL `query_range` proxy).
- **Frontend**: `TrafficHistoryPage.tsx`.
- **Prometheus** (already-deployed monitoring stack, shared with every
  core NF's own metrics) is the actual time-series store — not a new one.
- **Grafana**: `traffic-history.json`, auto-provisioned alongside the
  other dashboards.

### Design Notes

Retention is whatever Prometheus's own `--storage.tsdb.retention.time` is
configured to — shared with every other NF's metrics, not independently
configurable per this feature. If a UE's IP gets reassigned to a
different subscriber, the accounting layer deletes and recreates that
IP's counter rule pair (rather than relabeling it in place), so the
counter resets to zero instead of the new subscriber silently inheriting
the previous owner's byte count.

### Current Status

Stable.

---

## TWAMP (Backhaul Link Quality)

### What It Does

Monitors backhaul link quality — round-trip time, jitter, packet loss,
and one-way delay — to CBRS radios and any other TWAMP-capable device,
using the real RFC 5357 Two-Way Active Measurement Protocol rather than a
plain ping. Client and reflector run independently: the client side polls
operator-added targets on their own schedule, while the reflector side is
an always-on service answering inbound tests from other TWAMP-capable
devices, unrelated to the client's own polling.

One-way delay figures depend on both endpoints' clocks being synchronized
(TWAMP itself has no clock-sync mechanism) — without it, forward/reverse
delay numbers can show artifacts like a negative delay on an otherwise
healthy, low-latency link. Round-trip time and loss are unaffected by
clock skew and remain reliable regardless.

### Components

- **Backend**: `twamp-runner.ts`/`twamp-client.go` (test execution, a thin
  Go wrapper around a vendored, patched TWAMP library), `twamp-monitor.ts`
  (per-target polling and in-memory cache), `twamp-history.ts` (retention-
  configurable history), `twamp-metrics.ts` (the Prometheus exporter),
  `twamp-controller.ts`. The reflector runs as its own always-on systemd
  service (`twamp-server.service`), independent of the client.
- **Frontend**: `TwampPage.tsx`.
- **Grafana**: `twamp.json`, auto-provisioned alongside the other
  dashboards.

### Current Status

Stable. Opt-in (`ENABLE_TWAMP_MODULE`, defaults disabled).

---

## UE Signal Monitoring

> **Community-contributed** (PR #32). **Baicells-native connector only**
> at this time — other radio vendors need a generic JSON connector, which
> requires the radio to already expose its own metrics in that shape, so
> this is not a drop-in solution for every vendor.

### What It Does

Per-UE radio signal and link-quality monitoring — RSRP, RSRQ, SINR, BLER,
MCS, CQI, and throughput — correlated with subscriber identity (IMSI,
ICCID, MSISDN) rather than shown as anonymous radio-side numbers. Keeps
7 days of history in a local SQLite database. Radio management
credentials used to pull this data are stored AES-256-GCM encrypted, not
in plaintext. Includes an admin-triggered downlink "wake" action to
prompt an idle UE to respond so its current signal state can be read.

### Components

- **Backend**: `radio-signal-controller.ts`.
- **Frontend**: `RadioSignalPage.tsx`.

### Design Notes

`ENABLE_UE_SIGNAL_MODULE` defaults **enabled** (set to `false` to hide
it) — unlike most other opt-in modules in this project, this is a pure
visibility gate, not an install/uninstall lifecycle; there's no separate
"module" to install or uninstall on the host.

The Baicells-native connector reads the radio's own vendor-specific
metrics API directly. Other vendors are not currently supported the same
way — a generic JSON connector exists as the fallback path, but it only
works if that radio already exposes its own metrics in a compatible
shape, so it isn't a universal drop-in.

### Current Status

Stable for Baicells radios via the native connector. Other vendors depend
on the generic JSON connector already being viable for that specific
radio's own metrics format.

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
