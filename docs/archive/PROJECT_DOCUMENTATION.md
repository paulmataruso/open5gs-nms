# Open5GS NMS - Complete Project Documentation

**Last Updated:** March 2, 2026  
**Project Status:** Production-Ready with Auto Config and Complete Topology

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Current Status](#current-status)
3. [Features](#features)
4. [Quick Start](#quick-start)
5. [Architecture](#architecture)
6. [Technology Stack](#technology-stack)
7. [Configuration Management](#configuration-management)
8. [Development History](#development-history)
9. [Build & Deployment](#build--deployment)
10. [Topology Implementation](#topology-implementation)
11. [Known Issues & Limitations](#known-issues--limitations)
12. [Future Enhancements](#future-enhancements)

---

## Project Overview

Open5GS NMS is a production-grade web GUI for managing Open5GS 5G Core installations. It provides comprehensive configuration management, service monitoring, subscriber provisioning, network topology visualization, and audit logging.

### Key Capabilities
- Manage all 16 network function configurations (NRF, AMF, SMF, UPF, MME, HSS, etc.)
- Control systemd services (start/stop/restart)
- Real-time monitoring via WebSocket
- Full CRUD for subscriber management
- Backup/restore for configs and database
- Network topology visualization
- Comprehensive audit logging

---

## Current Status

### ✅ Production Features Complete
- **Auto Configuration** - One-click network setup with NAT support (NEW)
- Configuration management for all 16 services
- Service control (start/stop/restart with safety checks)
- Subscriber management (MongoDB integration)
- Backup & restore capabilities
- Unified logging system
- Text editor with syntax highlighting
- **Network Topology** - Complete JointJS visualization with manual routing (UPDATED)
- Audit trail for all changes

### 🎉 Recent Additions (March 2, 2026)

**Auto Config Feature - Complete**
- One-click configuration of 4G/5G PLMNs and network IPs
- Preview changes with YAML diff viewer before applying
- Loads current Open5GS values as form defaults
- Optional NAT configuration with iptables
- Shows exact commands before execution

**Topology Visualization - Complete**
- All 20 nodes positioned and styled
- All 40+ interfaces routed with manual waypoints
- gNodeB repositioned to 2400x700
- Clean orthogonal routing (90-degree turns only)
- No T-junctions or diagonal lines
- Real-time interface status (S1-MME, S1-U)

**See `TOPOLOGY_PROGRESS.md` and `CLAUDE.md` for detailed implementation notes**

---

## Features

### Auto Configuration (NEW)
- **One-Click Setup:** Configure Open5GS network in seconds
- **Preview Before Apply:** See exact YAML changes for each service
- **YAML Diff Viewer:** Toggle between summary and detailed diff view
- **Smart Defaults:** Loads current Open5GS values automatically
- **NAT Configuration:** Optional iptables setup with preview:
  - Enable IP forwarding (IPv4/IPv6)
  - Configure MASQUERADE rules for UE traffic
  - Allow tunnel interface traffic
  - Configurable interface (default: ogstun)
- **Services Updated:** mme.yaml, sgwu.yaml, amf.yaml, upf.yaml, smf.yaml

**Configuration Options:**
- 4G PLMN (MCC/MNC for MME)
- 5G PLMN (MCC/MNC for AMF)
- S1-MME IP address
- SGW-U GTP-U IP address
- AMF NGAP IP address
- UPF GTP-U IP address
- IPv4 session pool (subnet + gateway)
- IPv6 session pool (subnet + gateway)

### Configuration Management
- **16 Network Functions:** NRF, SCP, AMF, SMF, UPF, AUSF, UDM, UDR, PCF, NSSF, BSF, MME, HSS, PCRF, SGW-C, SGW-U
- **Dual Editor Modes:**
  - Form Editor: Structured inputs for all YAML fields
  - Text Editor: Monaco-based YAML editor with syntax highlighting
- **Safe Apply Workflow:**
  - Mutex-locked to prevent concurrent changes
  - Automatic backup before every change
  - Ordered service restart (respects dependencies)
  - Post-verification checks
  - Automatic rollback on failure
- **Complete Field Coverage:** Every YAML field has corresponding UI input

### Service Management
- Real-time status monitoring (systemd integration)
- Start/stop/restart individual services
- Bulk operations (start all, stop all, restart all)
- WebSocket streaming for live updates
- Memory and CPU usage tracking

### Subscriber Management
- Full CRUD operations via MongoDB
- Pagination and search
- Matches Open5GS schema exactly
- IMSI, K/OPc keys, AMBR, slices, sessions, QoS profiles

### Backup & Restore
- Config file backups with timestamps
- MongoDB database backups
- Selective file restore with diff comparison
- Auto-selection of changed files
- Configurable retention policies

### Unified Logging
- Centralized log viewing from all services
- WebSocket streaming (tail -f style)
- Service filtering
- Spam reduction

### Audit Logging
- Track all configuration changes
- Service actions logged with timestamps
- Subscriber modifications tracked
- User actions audit trail

---

## Quick Start

### Prerequisites
- Ubuntu 20.04+ or Debian 11+
- Open5GS installed and running (`apt install open5gs`)
- MongoDB installed and running
- Docker and Docker Compose
- Configs in `/etc/open5gs/*.yaml`
- Services managed by systemd

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

- **Domain Layer:** Pure TypeScript entities and interfaces
- **Application Layer:** Use cases orchestrate business logic
- **Infrastructure Layer:** YAML parsing, MongoDB, systemctl, filesystem
- **Interfaces Layer:** Express REST controllers, WebSocket handlers

### Safety Features

1. **Apply Mutex** - Only one config apply operation at a time
2. **Pre-validation** - Zod schema + cross-service dependency checks
3. **Automatic Backup** - Timestamped backup before every change
4. **Ordered Restart** - NRF → AMF → SMF → UPF → AUSF (respects dependencies)
5. **Post-verification** - Checks `systemctl is-active` after restart
6. **Auto-rollback** - Restores backup if any restart fails

---

## Technology Stack

### Backend
- Node.js 20 LTS
- TypeScript 5.3
- Express 4.18
- MongoDB Native Driver 6.3
- WebSocket (ws) 8.16
- Zod 3.22 (validation)
- Pino 8.17 (logging)
- js-yaml 4.1 (YAML parsing)
- async-mutex (concurrency control)

### Frontend
- React 18.2
- Vite 5.0
- TypeScript 5.3
- TailwindCSS 3.4
- Zustand 4.4 (state management)
- **JointJS 3.7** (network topology) ← Current
- Monaco Editor 4.6 (code editing)
- Axios 1.6 (HTTP client)
- Recharts 2.10 (charts)

### Infrastructure
- Docker multi-stage builds
- Nginx (frontend server)
- MongoDB 6.0+
- systemd (service control)

---

## Configuration Management

### All 16 Services Covered

**5G Core (11 services):**
- NRF, SCP, AMF, SMF, UPF, AUSF, UDM, UDR, PCF, NSSF, BSF

**4G EPC (5 services):**
- MME, HSS, PCRF, SGW-C, SGW-U

### Field Coverage Complete

Every field from Open5GS YAML configs has a corresponding UI input:

**Common Fields (all services):**
- Logger (file path, level)
- SBI Server (address, port)
- SBI Client SCP URI

**Service-Specific Examples:**
- **AMF:** NGAP, GUAMI, TAI, PLMN Support, Security, Network Name
- **SMF:** PFCP, GTP-C, GTP-U, Session pools, DNS, MTU, FreeDiameter
- **MME:** S1AP, GTP-C clients (SGW-C, SMF), GUMMEI, Security
- **UPF:** Session pools with subnet/gateway configuration
- **HSS/PCRF:** FreeDiameter paths, database URIs

**Number Parsing Fixed:**
All MCC/MNC/port/TAC fields use `parseInt()` to ensure integers in YAML (not strings).

---

## Development History

### Major Milestones

**Phase 1: Foundation (Complete)**
- Clean Architecture implementation
- Backend API with all endpoints
- Frontend React app with routing
- Docker deployment setup

**Phase 2: Configuration System (Complete)**
- All 16 config editors created
- Form validation with Zod
- Safe apply workflow
- Backup/rollback mechanism
- Text editor with Monaco

**Phase 3: Field Completion (Complete)**
- Added 28 missing fields across 9 services
- SMF: 8 fields (GTP-C, GTP-U, session, DNS, MTU, etc.)
- AMF: 6 fields (TAI, PLMN support, security, etc.)
- MME: 4 fields (GTP-C clients, security, etc.)
- Logger sections added to all 16 services

**Phase 4: Service Management (Complete)**
- systemd integration
- Start/stop/restart with retry logic
- Real-time WebSocket updates
- Service monitor polling

**Phase 5: Subscriber Management (Complete)**
- MongoDB integration
- Full CRUD operations
- Pagination and search
- Schema validation

**Phase 6: Backup/Restore (Complete)**
- Config file backups
- MongoDB backups (mongodump/mongorestore)
- Selective restore with diff view
- Auto-selection of changed files

**Phase 7: Unified Logging (Complete)**
- Centralized log aggregation
- WebSocket streaming
- Service filtering
- Spam reduction

**Phase 8: Topology Visualization (In Progress)**
- ~~ReactFlow implementation~~ (abandoned - diagonal lines, T-junctions)
- ~~Cytoscape.js migration~~ (abandoned - no manual routing control)
- **JointJS migration** (current - Step 2 of 7 complete)
  - Manual waypoint definition
  - 90-degree orthogonal routing
  - Professional diagram quality

### Key Fixes Applied

**Number Type Conversion:**
- Backend: `ensureNumericTypes()` recursively converts numeric strings
- Frontend: All MCC/MNC fields use `parseInt()` with regex validation

**Config Mapper Removal:**
- Eliminated inconsistent mapping layer
- All 16 services now use raw YAML passthrough
- Comments/structure preserved

**Service Status Checks:**
- MME gets 5 retry attempts (was 3)
- 5-second stabilization delay (was 2)
- Better error logging for nsenter timing issues

**Comment Preservation:**
- Text editor uses `yaml` library (preserves comments)
- Form editor uses raw YAML passthrough
- Backend still uses `js-yaml` (strips comments on write)

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

Set in `docker-compose.yml`:

```yaml
PORT: 3001                 # Backend REST API
WS_PORT: 3002              # WebSocket port
MONGODB_URI: mongodb://127.0.0.1:27017/open5gs
CONFIG_PATH: /etc/open5gs  # Config directory
BACKUP_PATH: /etc/open5gs/backups
LOG_LEVEL: info            # Pino log level
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

## Topology Implementation

### Current Approach: JointJS with Manual Routing

**Why JointJS:**
- Professional diagram library
- Full manual control over edge routing
- Supports custom waypoints for every connection
- 90-degree orthogonal connectors built-in
- Proper z-index layering

**Layout Strategy:**
- 3 Background boxes (Control Plane, SBI, User Plane)
- 20 Network function nodes
- Manual waypoint definition for each of 26 connections
- No automatic routing - complete control

**Status:** ✅ COMPLETE (March 2, 2026)

**Final Layout:**
- All 20 network function nodes positioned and styled
- 3 background boxes (Control Plane, SBI, User Plane)
- 40+ interfaces routed with manual waypoints
- gNodeB at 2400x700 (repositioned from 700x1100)
- N2 interface: horizontal from AMF to gNodeB
- N3 interface: vertical from gNodeB to UPF top-right
- UPF top connections: N4 (left), N4u (center), N3 (right)
- Real-time S1-MME and S1-U status display
- Clean 90-degree orthogonal routing throughout

**Connections to Route (26 total):**

*Inside SBI Box (9):*
- UDM ↔ AUSF, AMF, UDR, SMF
- AUSF ↔ AMF
- UDR ↔ PCF
- PCF ↔ AMF, SMF
- SMF ↔ AMF

*Control Plane (8):*
- HSS ↔ MME, MongoDB
- MME ↔ SGW-C
- SGW-C ↔ SMF, SGW-U
- PCRF ↔ SMF, MongoDB
- MongoDB ↔ UDR

*User Plane (2):*
- UPF ↔ Internet, SGW-U

*Cross-box (2):*
- UPF ↔ SMF (N4 Sxb, N4u Sxu) - 2 separate lines

*RAN (4):*
- MME ↔ eNodeB (S1-MME)
- SGW-U ↔ eNodeB (S1-U)
- AMF ↔ gNodeB (N2)
- UPF ↔ gNodeB (N3)

### Files

```
frontend/src/components/topology/
├── TopologyPage.tsx        # Main JointJS component
├── TopologyPage.css        # JointJS styling
└── topologyData.ts         # (deprecated - Cytoscape)
```

---

## Known Issues & Limitations

### Security
- ⚠️ **No authentication/authorization** - All API endpoints open
- ⚠️ **No HTTPS/WSS** - HTTP and WS only
- ⚠️ **No user management** - Single-user system
- ⚠️ **Rate limiting** - Per IP only, not per user

### Backend
- ⚠️ **Comment loss** - js-yaml strips comments on write
- ⚠️ **No config versioning** - No git integration
- ⚠️ **No retry logic** - Failed service restarts don't auto-retry
- ⚠️ **Single host only** - No distributed deployment support
- ⚠️ **Audit log limits** - 10,000 entries in memory

### Frontend
- ⚠️ **WebSocket errors** - Occasional connection issues

### SystemD Integration
- ⚠️ **MME status checks** - nsenter timing issues (warnings only, not blocking)
- ⚠️ **Privileged container** - Backend needs elevated permissions

---

## Future Enhancements

### High Priority
1. **Authentication/Authorization** - JWT or OAuth2
2. **HTTPS/WSS** - SSL/TLS support
3. **Config Versioning** - Git integration

### Medium Priority
5. **User Management** - Roles and permissions
6. **Notification System** - Email/Slack alerts
7. **Prometheus Metrics** - Monitoring integration
8. **Backup Scheduling** - Automated backups
9. **Multi-host Support** - SSH executor for remote hosts

### Low Priority
10. **Diff Viewer** - Visual config comparison
11. **Config Templates** - Pre-configured setups
12. **Import/Export** - Bulk config migration
13. **Dark/Light Theme** - UI customization

---

## API Reference

### Configuration Endpoints

```
GET    /api/config                    # Get all NF configs
GET    /api/config/:service           # Get specific config
POST   /api/config/validate           # Validate configs
POST   /api/config/apply              # Apply configs with restart
GET    /api/config/topology/graph     # Get network topology
POST   /api/auto-config/preview       # Preview auto config changes (NEW)
POST   /api/auto-config/apply         # Apply auto config (NEW)
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

## Troubleshooting

### Backend Won't Start

```bash
# Check logs
docker-compose logs backend

# Common issues:
# 1. MongoDB not accessible
systemctl status mongod

# 2. Permission issues
ls -la /etc/open5gs
chmod 755 /etc/open5gs

# 3. systemctl not accessible  
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

**For detailed topology progress, see:** `TOPOLOGY_PROGRESS.md`  
**For development notes, see:** `CLAUDE.md`  
**For build verification, see:** `BUILD-CHECKLIST.md`
