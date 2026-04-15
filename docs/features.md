# Feature Documentation

Detailed documentation for all Open5GS NMS features.

---

## Table of Contents

1. [Configuration Management](#configuration-management)
2. [Network Topology Visualization](#network-topology-visualization)
3. [Subscriber Management](#subscriber-management)
4. [SIM Generator](#sim-generator)
5. [SUCI Key Management](#suci-key-management)
6. [Service Management](#service-management)
7. [Auto-Configuration Wizard](#auto-configuration-wizard)
8. [Real-Time Logging](#real-time-logging)
9. [Backup & Restore](#backup--restore)
10. [Audit Trail](#audit-trail)

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

Stream logs from Open5GS services and Docker containers in real-time.

### Log Sources

**Open5GS Services:**
- Stream logs from any of the 16 Open5GS network functions
- Reads from `/var/log/open5gs/*.log` files
- Uses `tail -f` for real-time streaming

**Docker Containers:**
- Stream logs from NMS Docker containers (backend, frontend, nginx)
- Uses `docker logs -f --timestamps` for real-time streaming
- Automatic container discovery

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
  source: 'open5gs' | 'docker',
  services: ['nrf', 'amf'] // or container names
}

// Receive log entry
{
  type: 'log_entry',
  source: 'open5gs' | 'docker',
  log: {
    timestamp: '2026-04-14T14:30:45.123Z',
    service: 'nrf', // or container name
    message: '[info] NRF started'
  }
}
```

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

## Summary

Open5GS NMS provides a complete management solution for Open5GS deployments with:
- ✅ Safe, validated configuration management
- ✅ Real-time network visualization
- ✅ Comprehensive subscriber management
- ✅ Powerful automation tools
- ✅ Production-ready safety features

For detailed usage instructions, see **[INSTALL.md](../INSTALL.md)** and other documentation.
