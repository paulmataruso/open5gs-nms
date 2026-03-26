# Open5GS NMS - Complete Documentation

**Last Updated:** March 2, 2026  
**Project Status:** Production-Ready with Auto Configuration and Complete Topology Visualization

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Project Overview](#project-overview)
3. [Features](#features)
4. [Architecture](#architecture)
5. [Auto Configuration](#auto-configuration)
6. [Topology Visualization](#topology-visualization)
7. [Configuration Management](#configuration-management)
8. [Technology Stack](#technology-stack)
9. [Build & Deployment](#build--deployment)
10. [API Reference](#api-reference)
11. [Implementation Patterns](#implementation-patterns)
12. [Known Issues & Future Enhancements](#known-issues--future-enhancements)
13. [Troubleshooting](#troubleshooting)

---

## Quick Start

### Prerequisites
- Ubuntu 20.04+ or Debian 11+
- Open5GS installed (`apt install open5gs`)
- MongoDB running
- Docker and Docker Compose
- Configs in `/etc/open5gs/*.yaml`

### Installation

```bash
# Clone repository
cd /opt
git clone <repo> open5gs-nms

# Build and start
cd open5gs-nms
docker-compose build
docker-compose up -d

# Access UI
open http://your-host:8080
```

### Verification

```bash
# Health check
curl http://localhost:3001/api/health

# Check services
curl http://localhost:3001/api/services

# View logs
docker-compose logs -f
```

---

## Project Overview

Open5GS NMS is a production-grade web GUI for managing Open5GS 5G Core installations. It provides comprehensive configuration management, service monitoring, subscriber provisioning, network topology visualization, automated configuration, and audit logging.

### Key Capabilities
- **Auto Configuration** - One-click network setup with NAT support
- **Configuration Management** - All 16 network function configs with dual editor modes
- **Service Control** - systemd service management with WebSocket monitoring
- **Network Topology** - JointJS visualization with manual routing
- **Subscriber Management** - Full CRUD for Open5GS subscribers
- **Backup & Restore** - Config and database backup capabilities
- **Unified Logging** - Centralized log viewing with WebSocket streaming
- **Audit Trail** - Complete history of all changes

### Production Features Complete ✅
- Auto Configuration with preview and NAT setup
- Configuration management for all 16 services
- Service control with safety checks and ordered restarts
- Subscriber management with MongoDB integration
- Backup & restore capabilities
- Unified logging system
- Text editor with syntax highlighting (Monaco)
- Network Topology with clean orthogonal routing
- Comprehensive audit logging

---

## Features

### 1. Auto Configuration ⚡ NEW

**One-click automated Open5GS configuration with preview and NAT support.**

**What it configures:**
- 4G PLMN (MCC/MNC for MME)
- 5G PLMN (MCC/MNC for AMF)
- Network IPs (S1-MME, SGW-U GTP-U, AMF NGAP, UPF GTP-U)
- UE session pools (IPv4/IPv6 subnets and gateways)
- Optional NAT with iptables

**Key Features:**
- **Preview Before Apply:** Toggle between Summary and YAML Diff view
- **Smart Defaults:** Loads current Open5GS values automatically
- **NAT Configuration:** Optional iptables setup with command preview:
  ```bash
  sysctl -w net.ipv4.ip_forward=1
  sysctl -w net.ipv6.conf.all.forwarding=1
  iptables -t nat -A POSTROUTING -s <subnet> ! -o ogstun -j MASQUERADE
  ip6tables -t nat -A POSTROUTING -s <subnet> ! -o ogstun -j MASQUERADE
  iptables -I INPUT -i ogstun -j ACCEPT
  ```

**Services Updated:**
- mme.yaml, sgwu.yaml, amf.yaml, upf.yaml, smf.yaml

### 2. Configuration Management

**16 Network Functions Supported:**
- 5G Core: NRF, SCP, AMF, SMF, UPF, AUSF, UDM, UDR, PCF, NSSF, BSF
- 4G EPC: MME, HSS, PCRF, SGW-C, SGW-U

**Dual Editor Modes:**
- **Form Editor:** Structured inputs with validation
- **Text Editor:** Monaco-based YAML editor with syntax highlighting

**Safe Apply Workflow:**
1. Mutex-locked (one operation at a time)
2. Automatic backup before changes
3. Zod schema validation
4. Cross-service dependency checks
5. Ordered service restart (NRF → AMF → SMF → UPF → AUSF)
6. Post-verification checks
7. Automatic rollback on failure

### 3. Network Topology 🗺️

**Complete JointJS visualization with manual routing.**

**Layout:**
- 3 background boxes (Control Plane, SBI, User Plane)
- 20 network function nodes
- 40+ interfaces with manual waypoints
- Clean 90-degree orthogonal routing
- No T-junctions or diagonal lines

**Key Nodes:**
- 4G EPC: HSS, MME, SGW-C, PCRF (green)
- 5G Core: NRF, NSSF, UDM, AUSF, UDR, PCF, SMF, AMF (blue)
- User Plane: SGW-U, UPF (green/blue)
- RAN: eNodeB, gNodeB (orange)
- External: MongoDB (purple), Internet (cyan)

**Interface Colors:**
- Green: 4G control plane (S6a, S11, S5c, Gx, S1-MME)
- Pink: 5G SBI (N8, N10-N15, N35, N36) and N2, N4
- Yellow: User plane data (S1-U, N3, N4u, S5u)
- Purple: Internet/external (N6/Sgi)
- Gray: Database connections (dashed)

**Real-time Status:**
- S1-MME and S1-U interface status
- Connected eNodeB IPs displayed
- Animated lines when active
- Status circles on all nodes (green/red)

### 4. Service Management

- Real-time status monitoring via systemd
- Start/stop/restart individual services
- Bulk operations (start all, stop all, restart all)
- WebSocket streaming for live updates
- Memory and CPU usage tracking
- Retry logic for stability

### 5. Subscriber Management

- Full CRUD operations via MongoDB
- Pagination and search
- Matches Open5GS schema exactly
- IMSI, K/OPc keys, AMBR, slices, sessions, QoS profiles
- Schema validation before save

### 6. Backup & Restore

- Config file backups with timestamps
- MongoDB database backups (mongodump/mongorestore)
- Selective file restore with diff comparison
- Auto-selection of changed files
- Configurable retention policies

### 7. Unified Logging

- Centralized log viewing from all services
- WebSocket streaming (tail -f style)
- Service filtering
- Spam reduction
- Real-time updates

### 8. Audit Logging

- Track all configuration changes
- Service actions logged with timestamps
- Subscriber modifications tracked
- User actions audit trail
- 10,000 entries in memory

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│  Browser (React + TailwindCSS + JointJS)         │
│  Port 8080 (nginx)                                │
└────────────┬─────────────────┬───────────────────┘
             │ REST API        │ WebSocket
             ▼                 ▼
┌──────────────────────────────────────────────────┐
│  Backend (Docker, privileged, host network)       │
│  Node.js + Express + TypeScript                   │
│  Port 3001 (REST) + Port 3002 (WS)               │
│                                                   │
│  Clean Architecture:                              │
│  Domain → Application → Infrastructure            │
└──────┬──────────┬───────────┬───────────────────┘
       │          │           │
       ▼          ▼           ▼
  /etc/open5gs  systemctl  MongoDB
  (bind mount)  (host PID)  (host:27017)
```

### Backend Design Principles

**Clean Architecture Layers:**
- **Domain Layer:** Pure TypeScript entities and interfaces (zero infrastructure deps)
- **Application Layer:** Use cases orchestrate business logic
- **Infrastructure Layer:** YAML parsing, MongoDB, systemctl, filesystem
- **Interfaces Layer:** Express REST controllers, WebSocket handlers

**Safety Features:**
1. **Apply Mutex** - Only one config apply operation at a time
2. **Pre-validation** - Zod schema + cross-service dependency checks
3. **Automatic Backup** - Timestamped backup before every change
4. **Ordered Restart** - NRF → AMF → SMF → UPF → AUSF (respects dependencies)
5. **Post-verification** - Checks `systemctl is-active` after restart
6. **Auto-rollback** - Restores backup if any restart fails

---

## Auto Configuration

### Implementation Details

**Critical Pattern #1: Always Use rawYaml**

```typescript
// ✅ CORRECT - Modify rawYaml directly
const raw = configs.upf.rawYaml as any;
raw.upf.session = [
  { subnet: '10.45.0.0/16', gateway: '10.45.0.1' },
  { subnet: '2001:db8:cafe::/48', gateway: '2001:db8:cafe::1' }
];
configs.upf.rawYaml = raw;
await configRepo.saveUpf(configs.upf);

// ❌ WRONG - Don't modify entity structures
configs.upf.session = [...]; // This won't work!
```

**Why:** Config repository save methods use `rawYaml` passthrough. Backend entity types don't match actual YAML structure.

**Critical Pattern #2: Frontend Structure is Nested**

```typescript
// ✅ CORRECT - Access nested structure
const mmeConfig = (configs.mme as any)?.mme;
const plmn = mmeConfig?.gummei?.[0]?.plmn_id;

// ❌ WRONG - Missing nested layer
const plmn = configs.mme?.gummei?.[0]?.plmn_id; // undefined!
```

**Critical Pattern #3: Handle Array PLMN IDs**

```typescript
// ✅ CORRECT - Check if array
const plmnId = raw.mme.gummei[0].plmn_id;
const plmn = Array.isArray(plmnId) ? plmnId[0] : plmnId;
```

**Critical Pattern #4: Preserve YAML Anchors**

```typescript
// ✅ CORRECT - Only modify if value changed
if (raw.amf.guami && raw.amf.guami.length > 0) {
  const currentPlmn = raw.amf.guami[0].plmn_id;
  if (currentPlmn && (currentPlmn.mcc !== input.mcc || currentPlmn.mnc !== input.mnc)) {
    raw.amf.guami[0].plmn_id = { mcc: input.mcc, mnc: input.mnc };
  }
}

// ❌ WRONG - Always modify (breaks anchors &a1, *a1)
raw.amf.guami[0].plmn_id = { mcc: input.mcc, mnc: input.mnc };
```

**Correct YAML Format for Session Pools:**

```yaml
# ✅ CORRECT - Flat structure
session:
  - subnet: 10.45.0.0/16
    gateway: 10.45.0.1
  - subnet: 2001:db8:cafe::/48
    gateway: 2001:db8:cafe::1

# ❌ WRONG - Nested addr arrays
session:
  - subnet:
      - addr: 10.45.0.0/16
```

---

## Topology Visualization

### Complete Layout (March 2, 2026)

**gNodeB Position:** 2400x700 (moved from 700x1100)

**UPF Top Connections:**
```
N4 (pink)    N4u (yellow)      N3 (yellow)
    |             |                 |
┌───┼─────────────┼─────────────────┼───┐
│   ↓             ↓                 ↓   │
│ [      UPF Box (2400,1395)        ]   │
```

- **N4 (Sxb):** x=2360 (left offset) - Pink dashed
- **N4u (Sxu):** x=2400 (center) - Yellow dashed
- **N3:** x=2440 (right offset) - Yellow solid

**All Node Positions:**

*4G EPC:*
- HSS: 300,400
- MME: 300,700
- SGW-C: 600,700
- PCRF: 800,600
- MongoDB: 800,400

*5G Core (SBI Box):*
- NRF: 1200,250
- NSSF: 1600,250
- UDM: 1100,300
- UDR: 1100,400
- PCF: 1100,600
- SMF: 1100,700
- AUSF: 1600,300
- AMF: 1600,700

*User Plane:*
- SGW-U: 2200,1400
- UPF: 2400,1395

*External:*
- Internet: 2750,1380

*RAN:*
- eNodeB: 500,1100
- gNodeB: 2400,700 ← **Updated**

**Interface Routing:**
- All 40+ interfaces use manual waypoints
- 90-degree orthogonal routing only
- No T-junctions or diagonal lines
- Proper layering: Boxes (z=1,2) → Edges (z=5) → Nodes (z=10) → Status (z=11)

---

## Configuration Management

### All 16 Services Covered

**5G Core (11 services):**
NRF, SCP, AMF, SMF, UPF, AUSF, UDM, UDR, PCF, NSSF, BSF

**4G EPC (5 services):**
MME, HSS, PCRF, SGW-C, SGW-U

### Complete Field Coverage

Every field from Open5GS YAML configs has a corresponding UI input.

**Common Fields:**
- Logger (file path, level)
- SBI Server (address, port)
- SBI Client SCP URI

**Service-Specific Examples:**
- **AMF:** NGAP, GUAMI, TAI, PLMN Support, Security, Network Name
- **SMF:** PFCP, GTP-C, GTP-U, Session pools, DNS, MTU, FreeDiameter
- **MME:** S1AP, GTP-C clients, GUMMEI, Security
- **UPF:** Session pools with subnet/gateway configuration

---

## Technology Stack

### Backend
- Node.js 20 LTS, TypeScript 5.3, Express 4.18
- MongoDB Native Driver 6.3, WebSocket (ws) 8.16
- Zod 3.22 (validation), Pino 8.17 (logging)
- js-yaml 4.1, async-mutex, diff, uuid

### Frontend
- React 18.2, Vite 5.0, TypeScript 5.3
- TailwindCSS 3.4, Zustand 4.4 (state)
- **JointJS 3.7** (network topology)
- Monaco Editor 4.6 (code editing)
- Axios 1.6, Recharts 2.10, Lucide React

### Infrastructure
- Docker multi-stage builds, Nginx
- MongoDB 6.0+, systemd

---

## Build & Deployment

### Build Commands

```bash
# Build all services
docker-compose build

# Build specific service
docker-compose build backend
docker-compose build frontend

# Start services
docker-compose up -d

# View logs
docker-compose logs -f

# Restart after changes
docker-compose restart
```

### Environment Variables

```yaml
PORT: 3001                 # Backend REST API
WS_PORT: 3002              # WebSocket port
MONGODB_URI: mongodb://127.0.0.1:27017/open5gs
CONFIG_PATH: /etc/open5gs
BACKUP_PATH: /etc/open5gs/backups
LOG_LEVEL: info
```

### Docker Requirements

Backend container needs:
- **Privileged mode** - For systemctl access
- **Host PID namespace** - For process management
- **Host network** - For MongoDB and service ports
- **Bind mounts** - `/etc/open5gs`, `/var/run/dbus`, systemctl binary

### Ports

| Service | Port | Protocol | Purpose |
|---------|------|----------|---------|
| Frontend | 8080 | HTTP | Web UI |
| Backend API | 3001 | HTTP | REST API |
| Backend WS | 3002 | WS | Real-time updates |
| MongoDB | 27017 | TCP | Database (host) |

---

## API Reference

### Configuration Endpoints

```
GET    /api/config                    # Get all NF configs
GET    /api/config/:service           # Get specific config
POST   /api/config/validate           # Validate configs
POST   /api/config/apply              # Apply configs with restart
GET    /api/config/topology/graph     # Get network topology
POST   /api/auto-config/preview       # Preview auto config changes
POST   /api/auto-config/apply         # Apply auto config
```

### Service Endpoints

```
GET    /api/services                  # Get all service statuses
GET    /api/services/:name            # Get specific service
POST   /api/services/:name/:action    # start/stop/restart
```

### Subscriber Endpoints

```
GET    /api/subscribers               # List subscribers
GET    /api/subscribers/:imsi         # Get subscriber
POST   /api/subscribers               # Create subscriber
PUT    /api/subscribers/:imsi         # Update subscriber
DELETE /api/subscribers/:imsi         # Delete subscriber
```

### System Endpoints

```
GET    /api/health                    # Health check
GET    /api/audit                     # Get audit logs
```

---

## Implementation Patterns

### Working with Open5GS Configs

**Always use rawYaml for modifications:**
```typescript
const raw = configs.mme.rawYaml as any;
if (!raw.mme) raw.mme = {};
raw.mme.gummei[0].plmn_id = { mcc: '315', mnc: '010' };
configs.mme.rawYaml = raw;
await configRepo.saveMme(configs.mme);
```

**Frontend config structure is nested:**
```typescript
const mmeConfig = (configs.mme as any)?.mme;
const plmn = mmeConfig?.gummei?.[0]?.plmn_id;
```

**Handle array PLMN IDs:**
```typescript
const plmnId = raw.mme.gummei[0].plmn_id;
const plmn = Array.isArray(plmnId) ? plmnId[0] : plmnId;
```

**Session pools format:**
```typescript
raw.upf.session = [
  { subnet: '10.45.0.0/16', gateway: '10.45.0.1' },
  { subnet: '2001:db8:cafe::/48', gateway: '2001:db8:cafe::1' }
];
```

### Common Mistakes to Avoid

❌ Don't use entity types for modifications  
❌ Don't assume frontend structure (missing nested layer)  
❌ Don't ignore array possibilities  
❌ Don't always modify (breaks YAML anchors)  
❌ Don't create wrong YAML structure (nested addr arrays)

---

## Known Issues & Future Enhancements

### Known Issues ⚠️

**Security:**
- No authentication/authorization
- No HTTPS/WSS
- No user management

**Backend:**
- Comment loss (js-yaml strips comments on write)
- No config versioning
- Single host only

**Frontend:**
- Occasional WebSocket connection issues

**SystemD:**
- MME status check timing issues (warnings only)
- Privileged container required

### Future Enhancements 🚀

**High Priority:**
1. Authentication/Authorization (JWT or OAuth2)
2. HTTPS/WSS (SSL/TLS support)
3. Config Versioning (Git integration)

**Medium Priority:**
4. User Management (roles and permissions)
5. Notification System (Email/Slack alerts)
6. Prometheus Metrics (monitoring integration)
7. Backup Scheduling (automated backups)
8. Multi-host Support (SSH executor)

**Low Priority:**
9. Diff Viewer (visual config comparison)
10. Config Templates (pre-configured setups)
11. Import/Export (bulk config migration)
12. Dark/Light Theme (UI customization)

---

## Troubleshooting

### Backend Won't Start

```bash
# Check logs
docker-compose logs backend

# Check MongoDB
systemctl status mongod

# Check permissions
ls -la /etc/open5gs
chmod 755 /etc/open5gs

# Check systemctl access
ls -la /usr/bin/systemctl
```

### Frontend Won't Load

```bash
# Check logs
docker-compose logs frontend

# Test nginx
curl http://localhost:8080

# Check firewall
ufw allow 8080/tcp
```

### Services Can't Restart

```bash
# Verify privileged mode
docker inspect open5gs-nms-backend | grep Privileged

# Verify host PID
docker inspect open5gs-nms-backend | grep PidMode

# Test systemctl
docker exec open5gs-nms-backend systemctl status open5gs-nrfd
```

---

## License

MIT

---

**Project Status:** Production-Ready  
**Last Updated:** March 2, 2026  
**Features Complete:** Auto Config, Topology, Configuration, Services, Subscribers, Backup/Restore, Logging, Audit Trail
