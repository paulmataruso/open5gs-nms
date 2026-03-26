# Open5GS NMS - Claude Development Log

## Project Status: In Development - Auto Config & Topology Updates

This is an Open5GS Network Management System (NMS) with full CRUD capabilities, backup/restore, unified logging, network topology visualization, and automated configuration.

## Latest Changes (2026-03-02)

### Auto Config Feature - Complete Implementation

**NEW FEATURE:** One-click automated Open5GS configuration with NAT setup support.

**What it does:**
- Configure 4G PLMN (MCC/MNC for MME)
- Configure 5G PLMN (MCC/MNC for AMF)
- Set network IPs (S1-MME, SGW-U GTP-U, AMF NGAP, UPF GTP-U)
- Configure UE session pools (IPv4/IPv6 subnets and gateways)
- Optional NAT configuration with iptables (NEW)

**Key Features:**
1. **Preview Before Apply:**
   - Toggle between Summary view and YAML Diff view
   - Shows exact YAML changes for each service (mme, sgwu, amf, upf, smf)
   - DiffViewer component with color-coded changes

2. **Load Current Values:**
   - Pre-populates form fields with actual Open5GS values
   - Handles nested config structure (`configs.mme.mme.gummei`)
   - Handles array PLMN IDs (`PlmnId | PlmnId[]`)

3. **NAT Configuration (Optional):**
   - Enable IP forwarding (IPv4 and IPv6)
   - Configure iptables MASQUERADE rules
   - Allow traffic from tunnel interface
   - Shows exact commands before execution:
     ```bash
     sysctl -w net.ipv4.ip_forward=1
     sysctl -w net.ipv6.conf.all.forwarding=1
     sysctl -p /etc/sysctl.conf
     iptables -t nat -A POSTROUTING -s <subnet> ! -o ogstun -j MASQUERADE
     ip6tables -t nat -A POSTROUTING -s <subnet> ! -o ogstun -j MASQUERADE
     iptables -I INPUT -i ogstun -j ACCEPT
     ```

**Critical Implementation Details:**

**Problem 1:** TypeScript entity types vs actual YAML structure
- Backend entities have different structure than actual YAML
- Example: Backend UPF has `session[].subnet[].addr` but YAML is `session[].subnet`
- Solution: Work with `rawYaml` directly, not entity types

**Problem 2:** YAML anchors and aliases
- Existing configs use YAML anchors (`&a1`, `*a1`)
- Deep cloning with `JSON.parse(JSON.stringify())` loses anchors
- Solution: Only modify fields that actually changed (conditional updates)

**Correct YAML Format:**
```yaml
# SMF/UPF Session (NOT session.subnet.addr)
session:
  - subnet: 10.45.0.0/16
    gateway: 10.45.0.1
  - subnet: 2001:db8:cafe::/48
    gateway: 2001:db8:cafe::1
```

**Files Modified:**
- `backend/src/application/use-cases/auto-config.ts` - Complete rewrite
- `backend/src/interfaces/rest/auto-config-controller.ts` - Preview endpoint
- `frontend/src/pages/AutoConfigPage.tsx` - Load current values, NAT UI
- `frontend/src/components/DiffViewer.tsx` - YAML diff viewer
- `frontend/src/api/index.ts` - Preview API call

**Key Learnings:**
1. Always work with `rawYaml` for config modifications
2. Config save methods use `rawYaml` passthrough (no entity mapping)
3. Frontend config structure is nested: `configs.mme.mme.gummei`
4. PLMN IDs can be arrays in backend entities
5. Never create new structures - only modify existing ones conditionally

---

### Topology Visualization - gNodeB Repositioned

**CHANGE:** Moved gNodeB from 700x1100 to 2400x700

**What was done:**
1. Removed duplicate gNodeB definition (old one at 700x1100)
2. Positioned gNodeB at 2400x700 (orange color, RAN style)
3. Updated N2 interface:
   - Simplified routing from AMF right side (1650,700) to gNodeB (2355,700)
   - Removed complex multi-segment routing with jumps
   - Now a clean horizontal line at y=700

4. Reorganized UPF top connections:
   - **N4 (pink):** Connects to UPF top-LEFT at x=2360 (offset from left edge)
   - **N4u (yellow):** Connects to UPF top-CENTER at x=2400
   - **N3 (yellow):** Connects to UPF top-RIGHT at x=2440 (offset from right edge)
   - All three interfaces properly spaced across UPF top edge

**UPF Top Layout:**
```
N4 (pink)    N4u (yellow)      N3 (yellow)
    |             |                 |
┌───┼─────────────┼─────────────────┼───┐
│   ↓             ↓                 ↓   │
│ [      UPF Box (2400,1395)        ]   │
```

**Files Modified:**
- `frontend/src/components/topology/TopologyPage.tsx`

---

## Features Implemented

### ✅ Auto Configuration (NEW)
- One-click network setup with preview
- YAML diff viewer before applying changes
- Loads current Open5GS values as defaults
- Optional NAT configuration with iptables
- Works with raw YAML (preserves structure)

### ✅ Configuration Management
- Load, edit, and save all Open5GS configs (YAML)
- Text editor with syntax highlighting (Monaco)
- Validation before applying changes
- Rollback on failure

### ✅ Service Management  
- View status of all 16 services
- Start/stop/restart individual services
- Bulk operations (start all, stop all, restart all)
- Real-time status updates via WebSocket

### ✅ Subscriber Management
- Full CRUD for subscriber profiles
- Pagination and search
- Integration with MongoDB

### ✅ Backup & Restore
- Config file backups with timestamps
- MongoDB database backups
- Selective file restore with diff comparison
- Auto-selection of changed files in restore UI

### ✅ Unified Logging
- Centralized log viewing from all services
- WebSocket streaming (tail -f style)
- Service filtering
- Spam reduction

### ✅ Network Topology (JointJS)
- Manual routing with exact waypoint control
- 90-degree orthogonal connections only
- No T-junctions or lines through boxes
- gNodeB positioned at 2400x700
- All interfaces properly routed

### ✅ Audit Logging
- Track all configuration changes
- User actions logged with timestamps

---

## Technology Stack

**Backend:**
- Node.js + TypeScript
- Express.js
- MongoDB
- systemd integration
- WebSocket for real-time updates

**Frontend:**
- React + TypeScript
- Vite
- Zustand (state management)
- JointJS (network topology)
- Monaco Editor (code editing)
- Tailwind CSS

---

## Build Instructions

```bash
# Build backend
docker-compose build backend

# Build frontend  
docker-compose build frontend

# Restart services
docker-compose restart backend frontend

# Or build both
docker-compose build backend frontend
docker-compose up -d
```

---

## Key Implementation Patterns

### Working with Open5GS Configs

**ALWAYS use rawYaml for modifications:**
```typescript
// ✅ CORRECT - Work with raw YAML
const raw = configs.mme.rawYaml as any;
if (!raw.mme) raw.mme = {};
raw.mme.gummei[0].plmn_id = { mcc: '315', mnc: '010' };
configs.mme.rawYaml = raw;
await configRepo.saveMme(configs.mme);

// ❌ WRONG - Don't modify entity structures
configs.mme.gummei[0].plmn_id = { mcc: '315', mnc: '010' };
await configRepo.saveMme(configs.mme);
```

**Frontend config structure is nested:**
```typescript
// ✅ CORRECT
const mmeConfig = (configs.mme as any)?.mme;
const plmn = mmeConfig?.gummei?.[0]?.plmn_id;

// ❌ WRONG
const plmn = configs.mme?.gummei?.[0]?.plmn_id;
```

**Handle array PLMN IDs:**
```typescript
// Backend entity: plmn_id: PlmnId | PlmnId[]
const plmnId = raw.mme.gummei[0].plmn_id;
const plmn = Array.isArray(plmnId) ? plmnId[0] : plmnId;
```

**Session pools format:**
```typescript
// ✅ CORRECT - Flat structure
raw.upf.session = [
  { subnet: '10.45.0.0/16', gateway: '10.45.0.1' },
  { subnet: '2001:db8:cafe::/48', gateway: '2001:db8:cafe::1' }
];

// ❌ WRONG - Nested addr arrays
raw.upf.session = [
  { subnet: [{ addr: '10.45.0.0/16' }] }
];
```

---

**Last Updated:** March 2, 2026 - Auto Config complete, gNodeB repositioned
**Status:** Production-ready with automated configuration
**Next:** Additional topology refinements as needed
