# Feature Documentation

Detailed documentation for all Open5GS NMS features.

---

## Table of Contents

1. [Configuration Management](#configuration-management)
2. [Network Topology Visualization](#network-topology-visualization)
3. [Subscriber Management](#subscriber-management)
4. [eSIM Generator (Simlessly API)](#esim-generator-simlessly-api)
5. [SIM Generator](#sim-generator)
6. [SUCI Key Management](#suci-key-management)
7. [Service Management](#service-management)
8. [Auto-Configuration Wizard](#auto-configuration-wizard)
9. [Real-Time Logging](#real-time-logging)
10. [Backup & Restore](#backup--restore)
11. [Audit Trail](#audit-trail)
12. [IMS / VoLTE](#ims--volte)
13. [SMS over SGs](#sms-over-sgs)
14. [UE Validation](#ue-validation)

---

## Configuration Management

Manage all 16 Open5GS network function configurations through a unified interface.

### Supported Network Functions

**5G Core (11 NFs):**
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

### eigrpd Crash-Guard Patch

A hand-built patch on top of the from-source FRR build (see "Reinstall (Source)" above) that stops a long-standing, upstream-unfixed EIGRP bug ([FRRouting/frr#943](https://github.com/FRRouting/frr/issues/943)) from crashing the entire `eigrpd` process — and withdrawing every EIGRP-learned route — when it fires. See **[docs/frr-eigrpd-crash-guard-patch.md](frr-eigrpd-crash-guard-patch.md)** for the full root-cause writeup, code, and reapplication steps.

### Syslog Forwarding

Forwards all Open5GS NF logs, GenieACS access logs, and the FRR log (19 files total) to a remote syslog server (e.g. Graylog), via rsyslog running on the host.

- **Detect / Install** — checks whether rsyslog is installed and running; installs it with one click if not
- **Configure** — enter a target host, port, and protocol (UDP or TCP); writes a dedicated, fully NMS-owned drop-in file (`/etc/rsyslog.d/71-open5gs-nms-forward.conf`) rather than editing your existing `rsyslog.conf` — safe to use even if you already have rsyslog configured for something else
- **Validation before apply** — the generated config is syntax-checked with `rsyslogd -N1` before rsyslog is ever restarted, so a bad config can't take down your host's logging
- **Automatic permission fixes** — rsyslog normally can't read logs outside `/var/log` (AppArmor) or files it doesn't own (like `frr.log`, owned by the `frr` user); both are fixed automatically the first time you configure a target, via the OS's own sanctioned mechanisms (AppArmor local-override file, adding the `syslog` user to the `frr` group)
- **Disable** — removes the drop-in file and restarts rsyslog; nothing else about your rsyslog setup is touched

---

## Backup & Restore

Automated backup system with selective restore capability.

### Backup Types

**Configuration Backups:**
- All 16 YAML files
- Stored in `/etc/open5gs/backups/config/YYYY-MM-DD-HHMM/`
- Includes exact file permissions

**MongoDB Backups:**
- Complete subscriber database
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

*(Alpha — not production-ready)* Full IMS core integration for voice-over-LTE and SMS-over-IP.

> ⚠️ **This module is in early alpha testing.** Server-side IMS signaling has been verified with a third-party SIP client, but end-to-end VoLTE on real phones is not confirmed working, and will likely require manual configuration beyond what this page automates (device/carrier-specific IMS provisioning, auth scheme adjustments, etc.). Do not rely on this for a production voice deployment.

### Components

- **P-CSCF / I-CSCF / S-CSCF** — Kamailio 5.8.8, built with IMS, TLS, MySQL, and extra modules
- **PyHSS** — Python-based Diameter HSS ([nickvsnetworking/pyhss](https://github.com/nickvsnetworking/pyhss)). Installed automatically by the NMS's one-click Install step (cloned from GitHub, Python deps installed via pip) — no separate manual install required
- **BIND9** — DNS server for the IMS domain zone (`ims.mnc<MNC>.mcc<MCC>.3gppnetwork.org`)
- **RTPEngine** — media relay
- **MariaDB** — backing database for PyHSS and the S/I-CSCF

### Workflow

1. **Install** — one-click install of Kamailio, MariaDB, BIND9, RTPEngine, Redis, and PyHSS
2. **Configure** — wires the P-CSCF address into SMF's PCO and per-session DNS, writes Cx (I/S-CSCF↔PyHSS) and Rx (P-CSCF↔PCRF) Diameter peer XML, generates the IMS DNS zone
3. **Sync Subscribers** — pushes IMPI/IMPU identities for existing subscribers into PyHSS's `ims_hss_db` (via its REST API)
4. **Enable/Disable, Start/Stop/Restart** — full lifecycle control from the UI

### Current Status

Server-side signaling is verified: all Diameter connections establish, the IMS APN and P-CSCF PCO delivery work, and a full SIP REGISTER→INVITE call flow has been confirmed with the third-party SIP client Linphone (using Early-IMS auth, since Linphone can't complete an AKA challenge without SIM hardware). **Real-phone VoLTE is not confirmed working** — see the limitation below and the alpha warning above.

**Known limitation:** Android's telephony framework suppresses VoLTE/SIP REGISTER entirely on test PLMNs (MCC 999) — the phone connects to the IMS APN and gets an IP, but the framework never lets it send SIP traffic. This is a device/carrier-policy limitation, not a server-side issue. A phone with a carrier profile that enables VoLTE for your test PLMN, or a third-party SIP client, will work.

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
- ✅ Safe, validated configuration management
- ✅ Real-time network visualization
- ✅ Comprehensive subscriber management
- ✅ Powerful automation tools
- ✅ Production-ready safety features
- ✅ Voice (IMS/VoLTE, alpha) and SMS (SGs) modules, both optional
- ✅ End-to-end validation via simulated test UEs, no physical radio required

For detailed usage instructions, see **[INSTALL.md](../INSTALL.md)** and other documentation.
