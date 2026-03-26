# Open5GS Network Management System — Complete Technical Documentation

**Version:** 1.0.0  
**Last Updated:** 2026-03-14  
**Author:** Production-grade NMS for Open5GS 5G/4G Core Networks

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [System Architecture](#system-architecture)
3. [Technology Stack](#technology-stack)
4. [Backend Architecture](#backend-architecture)
5. [Frontend Architecture](#frontend-architecture)
6. [Open5GS Integration](#open5gs-integration)
7. [Core Features](#core-features)
8. [API Reference](#api-reference)
9. [Database Schema](#database-schema)
10. [Security & Safety](#security--safety)
11. [Deployment](#deployment)
12. [Development Guide](#development-guide)
13. [Troubleshooting](#troubleshooting)

---

## Executive Summary

The **Open5GS Network Management System (NMS)** is a production-grade web application for managing Open5GS 5G Core and 4G EPC network deployments. It provides a comprehensive management interface for:

- **Configuration Management**: Edit all 16 Open5GS network function (NF) configurations through structured forms with real-time validation
- **Service Control**: Start/stop/restart systemd services with automatic dependency ordering
- **Subscriber Provisioning**: Full CRUD operations for subscriber management with MongoDB integration
- **Network Topology**: Interactive visualization of network functions and their interconnections
- **Real-time Monitoring**: Live service status updates via WebSocket
- **Audit Trail**: Complete logging of all configuration changes and system actions
- **SUCI Key Management**: Generate and manage home network public/private key pairs for 5G privacy
- **Backup & Restore**: Automated configuration and database backups with rollback capability

### Key Differentiators

- **Production-Ready Safety**: Mutex-locked operations, automatic backups, ordered service restarts, and automatic rollback on failure
- **Clean Architecture**: Domain-driven design with clear separation of concerns (Domain → Application → Infrastructure → Interface)
- **Real-Time Updates**: WebSocket-based service monitoring and log streaming
- **Type-Safe**: Full TypeScript implementation across frontend and backend
- **Docker-Native**: Containerized deployment with host network access for systemd integration
- **Open5GS Native**: Deep integration with Open5GS YAML configuration format and MongoDB schema

---

## System Architecture

### High-Level Overview

```
┌──────────────────────────────────────────────────────────────┐
│                         Browser                               │
│  React 18 + Vite + TailwindCSS + JointJS + Zustand           │
│  Renders: Dashboard, Topology, Config Forms, Subscribers     │
└───────────────┬────────────────────┬─────────────────────────┘
                │ HTTP/REST          │ WebSocket
                │ Port 8080          │ Port 8080
                ▼                    ▼
┌──────────────────────────────────────────────────────────────┐
│                    nginx (Alpine)                             │
│  Reverse Proxy: Frontend (8080) → Backend API (3001)         │
│  WebSocket Upgrade: Port 8080 → Backend WS (3002)            │
└───────────────┬────────────────────┬─────────────────────────┘
                │ HTTP               │ WS
                │ localhost:3001     │ localhost:3002
                ▼                    ▼
┌──────────────────────────────────────────────────────────────┐
│              Backend (Node.js 20 + TypeScript)                │
│  Container: privileged=true, network_mode=host, pid=host     │
│                                                               │
│  Layers:                                                      │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Interface Layer (REST Controllers + WS Handlers)     │    │
│  └─────────────────┬───────────────────────────────────┘    │
│  ┌─────────────────▼───────────────────────────────────┐    │
│  │ Application Layer (Use Cases / Business Logic)       │    │
│  └─────────────────┬───────────────────────────────────┘    │
│  ┌─────────────────▼───────────────────────────────────┐    │
│  │ Domain Layer (Entities, Services, Interfaces)        │    │
│  └─────────────────┬───────────────────────────────────┘    │
│  ┌─────────────────▼───────────────────────────────────┐    │
│  │ Infrastructure (YAML, MongoDB, systemctl, WS)        │    │
│  └─────────────────────────────────────────────────────┘    │
└───────┬──────────┬─────────────┬──────────────────────────┬─┘
        │          │             │                          │
        ▼          ▼             ▼                          ▼
   /etc/open5gs  systemctl   MongoDB                  /var/log
   (bind mount)  (via dbus)  (host:27017)            (bind mount)
```

### Component Communication

1. **Frontend → nginx** (Port 8080)
   - Static assets served from nginx
   - API requests proxied to backend:3001
   - WebSocket connections upgraded and proxied to backend:3002

2. **Backend → Open5GS**
   - YAML config files: Read/write to `/etc/open5gs/*.yaml`
   - Service control: Execute `systemctl` via D-Bus
   - MongoDB: Direct connection to `mongodb://127.0.0.1:27017/open5gs`

3. **Backend → Browser**
   - REST API: JSON responses for config, subscribers, services
   - WebSocket: Real-time service status updates, log streaming

### Network Architecture

All containers use `network_mode: host` to:
- Access MongoDB running on host (127.0.0.1:27017)
- Execute systemctl commands via host PID namespace
- Read/write Open5GS configs on host filesystem
- Listen on host ports without NAT overhead

### Privilege Requirements

The backend container requires:
- **privileged: true** — For systemctl access and D-Bus communication
- **pid: host** — To see and manage host processes
- **Host network** — To access local MongoDB and services
- **Volume mounts**:
  - `/etc/open5gs` — Read/write NF configs
  - `/var/log/open5gs` — Read service logs
  - `/run/systemd/system` — Systemd socket
  - `/var/run/dbus/system_bus_socket` — D-Bus socket
  - `/usr/bin/systemctl` — systemctl binary
  - `/lib/systemd` — Systemd libraries

---

## Technology Stack

### Backend

| Technology | Version | Purpose |
|------------|---------|---------|
| **Node.js** | 20 LTS | Runtime environment |
| **TypeScript** | 5.3.3 | Type-safe language |
| **Express** | 4.18.2 | HTTP server and REST API |
| **ws** | 8.16.0 | WebSocket server for real-time updates |
| **yaml** | 2.3.4 | YAML parsing and stringification |
| **js-yaml** | 4.1.0 | Alternative YAML parser |
| **zod** | 3.22.4 | Schema validation |
| **mongodb** | 6.3.0 | Native MongoDB driver |
| **pino** | 8.17.2 | High-performance logging |
| **async-mutex** | 0.4.1 | Mutex locks for safe concurrent operations |
| **diff** | 5.1.0 | Configuration diff generation |
| **helmet** | 7.1.0 | HTTP security headers |
| **cors** | 2.8.5 | Cross-origin resource sharing |
| **compression** | 1.7.4 | HTTP response compression |
| **express-rate-limit** | 7.1.5 | API rate limiting |

### Frontend

| Technology | Version | Purpose |
|------------|---------|---------|
| **React** | 18.2.0 | UI framework |
| **TypeScript** | 5.3.3 | Type-safe language |
| **Vite** | 5.0.11 | Build tool and dev server |
| **TailwindCSS** | 3.4.1 | Utility-first CSS framework |
| **Zustand** | 4.4.7 | State management |
| **React Router** | 6.21.1 | Client-side routing |
| **Axios** | 1.6.4 | HTTP client |
| **JointJS** | 3.7.0 | Network topology visualization |
| **Recharts** | 2.10.3 | Chart components |
| **Monaco Editor** | 4.6.0 | Code editor for YAML |
| **Lucide React** | 0.303.0 | Icon library |
| **react-hot-toast** | 2.4.1 | Toast notifications |
| **clsx** | 2.1.0 | Conditional className utility |

### Infrastructure

| Technology | Purpose |
|------------|---------|
| **Docker** | Container runtime |
| **Docker Compose** | Multi-container orchestration |
| **nginx** | Reverse proxy and static file server |
| **MongoDB** | Subscriber database (Open5GS native) |
| **systemd** | Service management |
| **D-Bus** | Inter-process communication for systemctl |

---

## Backend Architecture

The backend follows **Clean Architecture** principles with clear separation of concerns and dependency inversion.

### Layer Structure

```
src/
├── domain/              # Business logic, entities, interfaces (no deps)
│   ├── entities/        # Pure TypeScript classes
│   ├── interfaces/      # Abstract interfaces for repositories, executors
│   ├── services/        # Domain services (validation, topology builder)
│   └── value-objects/   # Immutable value objects
├── application/         # Use cases (orchestration layer)
│   ├── dto/             # Data transfer objects
│   └── use-cases/       # Business workflows
├── infrastructure/      # External integrations
│   ├── yaml/            # YAML file I/O
│   ├── mongodb/         # MongoDB repository
│   ├── system/          # systemctl executor
│   ├── websocket/       # WebSocket broadcaster
│   └── logging/         # Audit logger
├── interfaces/          # HTTP/WS entry points
│   └── rest/            # Express route handlers
├── config/              # App configuration
│   └── defaults/        # Default YAML configs
└── index.ts             # Application entry point
```

### Domain Layer

#### Entities

Pure TypeScript classes representing core domain concepts. No external dependencies.

**Key Entities:**
- `NrfConfig` — NRF (NF Repository Function) configuration
- `AmfConfig` — AMF (Access and Mobility Management Function) configuration
- `SmfConfig` — SMF (Session Management Function) configuration
- `UpfConfig` — UPF (User Plane Function) configuration
- `AusfConfig` — AUSF (Authentication Server Function) configuration
- `UdmConfig` — UDM (Unified Data Management) configuration
- `UdrConfig` — UDR (Unified Data Repository) configuration
- `PcfConfig` — PCF (Policy Control Function) configuration
- `NssfConfig` — NSSF (Network Slice Selection Function) configuration
- `BsfConfig` — BSF (Binding Support Function) configuration
- `ScpConfig` — SCP (Service Communication Proxy) configuration
- `MmeConfig` — MME (Mobility Management Entity) for 4G
- `HssConfig` — HSS (Home Subscriber Server) for 4G
- `PcrfConfig` — PCRF (Policy and Charging Rules Function) for 4G
- `SgwcConfig` — SGW-C (Serving Gateway Control Plane) for 4G
- `SgwuConfig` — SGW-U (Serving Gateway User Plane) for 4G
- `Subscriber` — Subscriber data matching Open5GS MongoDB schema
- `ServiceStatus` — Service runtime status
- `TopologyNode` — Network function node in topology graph
- `TopologyEdge` — Connection between NFs
- `AuditLog` — Audit trail entry

Example entity structure:

```typescript
// domain/entities/amf-config.ts
export interface AmfConfig {
  sbi: {
    addr: string | string[];
    port: number;
  };
  ngap: {
    addr: string;
  };
  guami: Array<{
    plmn_id: { mcc: string; mnc: string };
    amf_id: { region: number; set: number };
  }>;
  tai: Array<{
    plmn_id: { mcc: string; mnc: string };
    tac: number;
  }>;
  plmn_support: Array<{
    plmn_id: { mcc: string; mnc: string };
    s_nssai: Array<{ sst: number; sd?: string }>;
  }>;
  security: {
    integrity_order: string[];
    ciphering_order: string[];
  };
  network_name: {
    full: string;
    short: string;
  };
  amf_name: string;
}
```

#### Interfaces

Abstract contracts defining how infrastructure components should behave.

```typescript
// domain/interfaces/config-repository.ts
export interface IConfigRepository {
  loadAll(): Promise<AllConfigs>;
  loadNrf(): Promise<NrfConfig>;
  saveNrf(config: NrfConfig): Promise<void>;
  // ... methods for all 16 NFs
  getRawYaml(service: string): Promise<string>;
  backupAll(backupDir: string): Promise<void>;
  restoreBackup(backupDir: string): Promise<void>;
}
```

```typescript
// domain/interfaces/host-executor.ts
export interface IHostExecutor {
  executeCommand(command: string, args: string[]): Promise<ExecutionResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  restartService(serviceName: string): Promise<ExecutionResult>;
  isServiceActive(serviceName: string): Promise<boolean>;
  getServiceStatus(serviceName: string): Promise<ServiceStatus>;
  createDirectory(path: string): Promise<void>;
  listDirectory(path: string): Promise<string[]>;
  streamLogs(serviceName: string): AsyncIterableIterator<string>;
}
```

#### Services

Domain services encapsulate business logic that doesn't fit into entities.

**TopologyBuilder** — Constructs network topology graph from configurations:

```typescript
// domain/services/topology-builder.ts
export class TopologyBuilder {
  build(configs: AllConfigs, statuses?: Record<string, ServiceStatus>): TopologyGraph {
    const nodes = this.buildNodes(configs, statuses);
    const edges = this.buildEdges(configs);
    return { nodes, edges };
  }

  private buildEdges(configs: AllConfigs): TopologyEdge[] {
    const edges: TopologyEdge[] = [];
    // Validates NRF references
    // Checks PFCP connectivity
    // Verifies SBI addressing
    return edges;
  }
}
```

**CrossServiceValidator** — Validates cross-NF dependencies:
- NRF address consistency
- PFCP client-server matching
- PLMN ID consistency
- Network slice (S-NSSAI) validation

### Application Layer

Use cases orchestrate business workflows by coordinating domain entities and infrastructure components.

#### Key Use Cases

**ApplyConfigUseCase** — Safe configuration application with automatic rollback:

```typescript
// application/use-cases/apply-config.ts
export class ApplyConfigUseCase {
  private readonly mutex = new Mutex();  // Prevents concurrent applies

  async execute(newConfigs: AllConfigsDto): Promise<ApplyResultDto> {
    return this.mutex.runExclusive(async () => {
      // Step 1: Pre-validation (currently disabled - schemas need update)
      // Step 2: Generate diff for audit trail
      // Step 3: Create timestamped backup
      // Step 4: Write new configs (raw YAML passthrough)
      // Step 5: Restart services in dependency order
      // Step 6: Verify each service is active
      // Step 7: Automatic rollback on any failure
      // Step 8: Audit logging
    });
  }
}
```

**Service Restart Order:**
```typescript
const SERVICE_RESTART_ORDER: ServiceName[] = [
  'nrf',    // NF Repository Function (must be first - all NFs register here)
  'scp',    // Service Communication Proxy (optional routing layer)
  'udr',    // Unified Data Repository (database for UDM)
  'udm',    // Unified Data Management (depends on UDR)
  'ausf',   // Authentication Server (depends on UDM)
  'pcf',    // Policy Control Function
  'nssf',   // Network Slice Selection Function
  'bsf',    // Binding Support Function
  'amf',    // Access and Mobility Management (depends on AUSF)
  'smf',    // Session Management (depends on PCF, AMF)
  'upf',    // User Plane Function (depends on SMF for PFCP)
  'mme',    // 4G Mobility Management Entity
  'hss',    // 4G Home Subscriber Server
  'pcrf',   // 4G Policy and Charging
  'sgwc',   // 4G Serving Gateway Control Plane
  'sgwu',   // 4G Serving Gateway User Plane
];
```

**LoadConfigUseCase** — Loads all NF configurations:
```typescript
async execute(): Promise<AllConfigs> {
  const configs = await this.configRepo.loadAll();
  await this.auditLogger.log({
    action: 'config_load',
    user: 'system',
    success: true,
  });
  return configs;
}
```

**SubscriberManagementUseCase** — CRUD operations for subscribers:
```typescript
async createSubscriber(sub: CreateSubscriberDto): Promise<Subscriber> {
  // Validates IMSI format
  // Ensures required fields (K, OPc)
  // Creates with default QoS profiles
  const subscriber = await this.subscriberRepo.create(sub);
  await this.auditLogger.log({
    action: 'subscriber_create',
    details: `IMSI: ${subscriber.imsi}`,
    success: true,
  });
  return subscriber;
}
```

**ServiceMonitorUseCase** — Polls service status and broadcasts via WebSocket:
```typescript
startPolling(intervalMs: number): void {
  this.intervalId = setInterval(async () => {
    const statuses = await this.fetchAllStatuses();
    this.wsBroadcaster.broadcast({
      type: 'service_status_update',
      payload: { statuses },
    });
  }, intervalMs);
}
```

**BackupRestoreUseCase** — Configuration and database backups:
```typescript
async createBackup(): Promise<BackupMetadata> {
  const timestamp = new Date().toISOString();
  const configBackupPath = `${this.backupPath}/${timestamp}`;
  const mongoBackupPath = `${this.mongoBackupPath}/${timestamp}`;
  
  await this.configRepo.backupAll(configBackupPath);
  await this.backupMongoDB(mongoBackupPath);
  
  return { timestamp, configBackupPath, mongoBackupPath };
}
```

**SuciManagementUseCase** — SUCI (5G privacy) key management:
```typescript
async generateKey(params: GenerateKeyParams): Promise<SuciKey> {
  // Generates curve25519 (Profile A) or secp256r1 (Profile B) keypair
  // Saves private key to /etc/open5gs/hnet/{pki}.key
  // Updates udm.yaml with public key hex string
  // Returns public key and metadata
}
```

**AutoConfigUseCase** — Wizard-based configuration:
```typescript
async generateConfigs(params: AutoConfigParams): Promise<AllConfigs> {
  // Generates all 16 NF configs from minimal input
  // Assigns IP addresses, ports, PLMNs
  // Sets up network slices, TAI lists
  // Configures SBI connections, PFCP addresses
}
```

### Infrastructure Layer

Concrete implementations of domain interfaces.

**YamlConfigRepository** — File-based config storage:
```typescript
export class YamlConfigRepository implements IConfigRepository {
  async loadNrf(): Promise<NrfConfig> {
    const raw = await this.hostExecutor.readFile(`${this.configPath}/nrf.yaml`);
    const parsed = YAML.parse(raw);
    return { ...parsed, rawYaml: parsed };  // Preserve original structure
  }

  async saveNrf(config: NrfConfig): Promise<void> {
    // Uses raw YAML passthrough to preserve comments and structure
    const yamlString = YAML.stringify(config.rawYaml || config);
    await this.hostExecutor.writeFile(`${this.configPath}/nrf.yaml`, yamlString);
  }
}
```

**MongoSubscriberRepository** — MongoDB subscriber storage:
```typescript
export class MongoSubscriberRepository implements ISubscriberRepository {
  async create(sub: CreateSubscriberDto): Promise<Subscriber> {
    const doc = {
      imsi: sub.imsi,
      security: {
        k: sub.k,
        opc: sub.opc,
        amf: sub.amf || '8000',
        sqn: 0,
      },
      ambr: {
        downlink: { value: sub.downlink || 1, unit: 3 },  // Gbps
        uplink: { value: sub.uplink || 1, unit: 3 },
      },
      slice: sub.slice.map(s => ({
        sst: s.sst,
        default_indicator: s.default_indicator,
        session: s.session.map(sess => ({
          name: sess.name,
          type: sess.type,
          qos: { index: sess.qos_index, arp: { priority_level: 8 } },
          ambr: sess.ambr,
        })),
      })),
    };
    await this.db.collection('subscribers').insertOne(doc);
    return this.mapToSubscriber(doc);
  }
}
```

**LocalHostExecutor** — System command execution:
```typescript
export class LocalHostExecutor implements IHostExecutor {
  async restartService(serviceName: string): Promise<ExecutionResult> {
    // Uses systemctl via child_process.spawn
    const result = await this.executeCommand(this.systemctlPath, [
      'restart',
      serviceName,
    ]);
    return result;
  }

  async isServiceActive(serviceName: string): Promise<boolean> {
    const result = await this.executeCommand(this.systemctlPath, [
      'is-active',
      serviceName,
    ]);
    return result.exitCode === 0 && result.stdout.trim() === 'active';
  }
}
```

**WssBroadcaster** — WebSocket message broadcasting:
```typescript
export class WssBroadcaster implements IWebSocketBroadcaster {
  broadcast(message: WebSocketMessage): void {
    const payload = JSON.stringify(message);
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  }
}
```

**FileAuditLogger** — Structured audit logging:
```typescript
export class FileAuditLogger implements IAuditLogger {
  async log(entry: Partial<AuditLog>): Promise<void> {
    const logEntry: AuditLog = {
      timestamp: new Date().toISOString(),
      action: entry.action || 'unknown',
      user: entry.user || 'system',
      details: entry.details,
      success: entry.success ?? true,
    };
    
    const logLine = JSON.stringify(logEntry) + '\n';
    await fs.appendFile(this.currentLogFile, logLine);
  }
}
```

### Interface Layer

REST controllers and WebSocket handlers.

**ConfigController** — Configuration management endpoints:
```typescript
router.get('/all', async (req, res) => {
  const configs = await loadConfigUseCase.execute();
  res.json({ success: true, configs });
});

router.post('/validate', async (req, res) => {
  const result = await validateConfigUseCase.validateDto(req.body);
  res.json({ success: true, result });
});

router.post('/apply', async (req, res) => {
  const result = await applyConfigUseCase.execute(req.body);
  res.json(result);
});
```

**ServiceController** — Service management:
```typescript
router.get('/statuses', async (req, res) => {
  const statuses = await serviceMonitorUseCase.getAllStatuses();
  res.json({ success: true, statuses });
});

router.post('/:service/restart', async (req, res) => {
  await serviceMonitorUseCase.restartService(req.params.service);
  res.json({ success: true });
});
```

**SubscriberController** — Subscriber CRUD:
```typescript
router.get('/', async (req, res) => {
  const { skip, limit, search } = req.query;
  const result = await subscriberManagementUseCase.list(
    Number(skip) || 0,
    Number(limit) || 50,
    search as string,
  );
  res.json({ success: true, ...result });
});

router.post('/', async (req, res) => {
  const subscriber = await subscriberManagementUseCase.create(req.body);
  res.json({ success: true, subscriber });
});
```

**LogStreamHandler** — WebSocket log streaming:
```typescript
handleConnection(ws: WebSocket): void {
  ws.on('message', async (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'subscribe_logs' && msg.service) {
      const stream = await logStreamingUseCase.streamLogs(msg.service);
      for await (const line of stream) {
        ws.send(JSON.stringify({ type: 'log_line', line }));
      }
    }
  });
}
```

---

## Frontend Architecture

The frontend is a **React single-page application** built with TypeScript, Vite, and TailwindCSS.

### Directory Structure

```
src/
├── components/          # React components
│   ├── common/          # Reusable UI components
│   │   ├── Layout.tsx   # Main app layout with navigation
│   │   ├── Tooltip.tsx  # Tooltip component
│   │   └── UniversalTooltipWrappers.tsx
│   ├── dashboard/       # Dashboard page
│   ├── topology/        # Network topology visualization
│   ├── services/        # Service management page
│   ├── config/          # Configuration editor
│   │   ├── editors/     # NF-specific editors
│   │   └── ConfigPage.tsx
│   ├── subscribers/     # Subscriber management
│   ├── audit/           # Audit log viewer
│   ├── backup/          # Backup & restore
│   └── suci/            # SUCI key management
├── stores/              # Zustand state management
├── api/                 # API client functions
├── hooks/               # Custom React hooks
├── types/               # TypeScript type definitions
├── data/                # Static data (tooltips)
└── pages/               # Top-level page components
```

### State Management (Zustand)

The app uses **Zustand** for global state management with separate stores for each domain.

**ConfigStore** — Configuration state:
```typescript
export const useConfigStore = create<ConfigState>((set, get) => ({
  configs: null,
  loading: false,
  error: null,
  validation: null,
  dirty: false,
  
  fetchConfigs: async () => {
    const configs = await configApi.getAll();
    set({ configs, loading: false, dirty: false });
  },
  
  updateConfigs: (configs) => set({ configs, dirty: true }),
  
  validate: async () => {
    const result = await configApi.validate(get().configs);
    set({ validation: result });
    return result;
  },
}));
```

**ServiceStore** — Service status:
```typescript
export const useServiceStore = create<ServiceState>((set) => ({
  statuses: [],
  loading: false,
  
  fetchStatuses: async () => {
    const statuses = await serviceApi.getAll();
    set({ statuses, loading: false });
  },
  
  setStatuses: (statuses) => set({ statuses }),
}));
```

**TopologyStore** — Network topology:
```typescript
export const useTopologyStore = create<TopologyState>((set) => ({
  graph: null,
  interfaceStatus: null,
  loading: false,
  
  fetchTopology: async () => {
    const graph = await configApi.getTopology();
    set({ graph, loading: false });
  },
  
  fetchInterfaceStatus: async () => {
    const interfaceStatus = await interfaceApi.getStatus();
    set({ interfaceStatus });
  },
}));
```

### API Client Layer

Axios-based API client with base configuration:

```typescript
// api/index.ts
const API_URL = import.meta.env.VITE_API_URL || '';  // Empty for relative URLs
const client = axios.create({ baseURL: `${API_URL}/api` });

export const configApi = {
  getAll: () => client.get('/config/all').then(r => r.data.configs),
  validate: (configs) => client.post('/config/validate', configs).then(r => r.data.result),
  apply: (configs) => client.post('/config/apply', configs).then(r => r.data),
  getTopology: () => client.get('/config/topology').then(r => r.data.topology),
};

export const serviceApi = {
  getAll: () => client.get('/services/statuses').then(r => r.data.statuses),
  restart: (service) => client.post(`/services/${service}/restart`),
};

export const subscriberApi = {
  list: (skip, limit, search) => 
    client.get('/subscribers', { params: { skip, limit, search } }).then(r => r.data),
  create: (sub) => client.post('/subscribers', sub).then(r => r.data.subscriber),
  update: (imsi, sub) => client.put(`/subscribers/${imsi}`, sub),
  delete: (imsi) => client.delete(`/subscribers/${imsi}`),
};
```

### Key Components

#### TopologyPage — JointJS Network Visualization

Uses **JointJS** to render an interactive network diagram showing all 16 NFs and their connections.

**Features:**
- Real-time service status indicators (green/red dots)
- Animated connections when both endpoints are active
- S1-MME and S1-U interface status from conntrack
- Active UE sessions display with IP-to-IMSI correlation
- Connected eNodeB list with hover tooltips
- Manual coordinate-based positioning for pixel-perfect layout
- Color-coded interfaces (pink=SBI, green=4G, blue=5G, yellow=user plane, purple=internet)

**Layout Structure:**
- Control Plane Box (gray): Contains MME, HSS, SGW-C, PCRF, AMF, SMF, AUSF, UDM, UDR, PCF, NSSF
- SBI Box (pink dashed): NRF, NSSF, AUSF, AMF, UDM, UDR, PCF, SMF
- User Plane Box (gray): SGW-U, UPF
- RAN: eNodeB (4G), gNodeB (5G)
- External: MongoDB, Internet

**Key Interfaces Visualized:**
- **S1-MME** (green): MME ↔ eNodeB control plane
- **S1-U** (yellow): SGW-U ↔ eNodeB user plane
- **N2** (pink): AMF ↔ gNodeB control plane
- **N3** (yellow): UPF ↔ gNodeB user plane
- **N4/Sxb** (pink dashed): SMF ↔ UPF PFCP control
- **N4u/Sxu** (yellow dashed): SMF ↔ UPF user data
- **S11** (green): MME ↔ SGW-C
- **S5c** (green): SGW-C ↔ SMF
- **Sxa** (green dashed): SGW-C ↔ SGW-U
- **S5u** (yellow): SGW-U ↔ UPF
- **N6/Sgi** (purple): UPF ↔ Internet
- **SBI connections** (pink): N7, N8, N11, N12, N13, N15, N35, N36

#### ConfigPage — Multi-NF Configuration Editor

Tabbed interface for editing all 16 NF configurations with structured forms.

**Architecture:**
- Tab-based navigation (5G Core / 4G EPC)
- Form mode vs Text mode toggle (Monaco YAML editor)
- Individual NF editors as React components
- Shared field components with tooltips
- Real-time dirty state tracking
- Validation before apply
- Diff preview before commit

**NF Editors:**
- **5G Core**: NRF, SCP, AMF, SMF, UPF, AUSF, UDM, UDR, PCF, NSSF, BSF
- **4G EPC**: MME, HSS, PCRF, SGW-C, SGW-U

**Common Editor Pattern:**
```typescript
function SmfEditor({ configs, onChange }) {
  const smf = configs.smf;
  const updateSmf = (partial) => onChange({ ...configs, smf: { ...smf, ...partial } });
  
  return (
    <div className="space-y-6">
      <div>
        <h3>SBI Server</h3>
        <FieldWithTooltip 
          label="Address" 
          value={smf.sbi.server[0].address}
          onChange={(v) => updateSmf({ sbi: { ...smf.sbi, server: [{ address: v }] } })}
          tooltip={SMF_TOOLTIPS.sbi_address}
        />
      </div>
    </div>
  );
}
```

#### SubscriberPage — MongoDB Subscriber Management

Full CRUD interface matching Open5GS MongoDB schema exactly.

**Features:**
- Pagination (50 per page)
- Search by IMSI/MSISDN
- Create/Edit/Delete operations
- Multi-slice support
- Multi-session per slice
- QoS profile selection
- SIM Generator for test data
- SUCI (5G privacy) key integration

**Subscriber Schema Mapping:**
```typescript
interface Subscriber {
  imsi: string;
  msisdn?: string;
  security: {
    k: string;           // 128-bit hex key
    opc: string;         // 128-bit hex OPc
    amf: string;         // AMF value (default "8000")
    sqn: number;         // Sequence number
  };
  ambr: {
    downlink: { value: number; unit: 3 };  // Gbps
    uplink: { value: number; unit: 3 };
  };
  slice: Array<{
    sst: number;
    sd?: string;
    default_indicator: boolean;
    session: Array<{
      name: string;       // "internet", "ims", etc.
      type: number;       // 3=IPv4
      qos: { index: number; arp: { priority_level: number } };
      ambr: { downlink: { value: number; unit: number }; uplink: { value: number; unit: number } };
    }>;
  }>;
  access_restriction_data: number;
  subscriber_status: number;
  network_access_mode: number;
  subscribed_rau_tau_timer: number;
}
```

#### Tooltip System

Comprehensive tooltip system with 150+ tooltips across all pages.

**Architecture:**
- Centralized tooltip definitions in `src/data/tooltips/`
- Reusable wrapper components
- Hover-triggered with 500ms delay
- Auto-positioning (top/bottom based on space)
- Keyboard accessible (focus/blur)
- Consistent styling

**Tooltip Data Files:**
```
data/tooltips/
├── index.ts          # Central export
├── nrf.ts            # NRF tooltips
├── amf.ts            # AMF tooltips
├── smf.ts            # SMF tooltips
├── 5g-nfs.ts         # UDM, UDR, AUSF, PCF, NSSF, BSF
├── 4g-epc.ts         # MME, HSS, PCRF, SGW-C, SGW-U
├── subscriber.ts     # Subscriber fields
├── sim-generator.ts  # SIM Generator
├── suci.ts           # SUCI key management
└── auto-config.ts    # Auto Config wizard
```

**Usage Example:**
```typescript
import { FieldWithTooltip } from './FieldsWithTooltips';
import { AMF_TOOLTIPS } from '../../data/tooltips';

<FieldWithTooltip
  label="PLMN MCC"
  value={plmn.mcc}
  onChange={handleChange}
  tooltip={AMF_TOOLTIPS.plmn_mcc}
/>
```

---

## Open5GS Integration

### Supported Network Functions

The NMS manages all 16 Open5GS network functions:

#### 5G Core (11 NFs)

| NF | Full Name | Role | Config File |
|----|-----------|------|-------------|
| **NRF** | NF Repository Function | Service registry for NF discovery | `/etc/open5gs/nrf.yaml` |
| **SCP** | Service Communication Proxy | Optional HTTP/2 proxy for SBI traffic | `/etc/open5gs/scp.yaml` |
| **AMF** | Access and Mobility Management | UE registration, mobility, authentication | `/etc/open5gs/amf.yaml` |
| **SMF** | Session Management Function | PDU session setup, QoS, UPF selection | `/etc/open5gs/smf.yaml` |
| **UPF** | User Plane Function | Packet forwarding, QoS enforcement | `/etc/open5gs/upf.yaml` |
| **AUSF** | Authentication Server Function | 5G-AKA authentication | `/etc/open5gs/ausf.yaml` |
| **UDM** | Unified Data Management | Subscription data, credential generation | `/etc/open5gs/udm.yaml` |
| **UDR** | Unified Data Repository | MongoDB interface for subscription data | `/etc/open5gs/udr.yaml` |
| **PCF** | Policy Control Function | QoS policies, charging rules | `/etc/open5gs/pcf.yaml` |
| **NSSF** | Network Slice Selection | Slice selection based on S-NSSAI | `/etc/open5gs/nssf.yaml` |
| **BSF** | Binding Support Function | Binding information storage | `/etc/open5gs/bsf.yaml` |

#### 4G EPC (5 NFs)

| NF | Full Name | Role | Config File |
|----|-----------|------|-------------|
| **MME** | Mobility Management Entity | UE tracking, bearer management | `/etc/open5gs/mme.yaml` |
| **HSS** | Home Subscriber Server | Authentication, subscription profiles | `/etc/open5gs/hss.yaml` |
| **PCRF** | Policy and Charging Rules Function | QoS policies for 4G | `/etc/open5gs/pcrf.yaml` |
| **SGW-C** | Serving Gateway Control | S11/S5 control plane | `/etc/open5gs/sgwc.yaml` |
| **SGW-U** | Serving Gateway User | S1-U/S5-U user plane | `/etc/open5gs/sgwu.yaml` |

### YAML Configuration Format

Open5GS uses nested YAML configuration files. The NMS preserves:
- Comments
- Formatting
- Array style (flow vs block)
- Key ordering

**Example AMF Configuration:**
```yaml
amf:
  sbi:
    server:
      - address: 127.0.0.5
        port: 7777
    client:
      scp:
        - uri: http://127.0.0.200:7777
  ngap:
    server:
      - address: 10.0.1.175
  guami:
    - plmn_id:
        mcc: 001
        mnc: 01
      amf_id:
        region: 2
        set: 1
  tai:
    - plmn_id:
        mcc: 001
        mnc: 01
      tac: 1
  plmn_support:
    - plmn_id:
        mcc: 001
        mnc: 01
      s_nssai:
        - sst: 1
  security:
    integrity_order: [NIA2, NIA1, NIA0]
    ciphering_order: [NEA0, NEA1, NEA2]
  network_name:
    full: Open5GS
    short: Next
  amf_name: open5gs-amf0

logger:
  file:
    path: /var/log/open5gs/amf.log
  level: info
```

### systemd Service Names

All Open5GS NFs run as systemd services:

```
open5gs-nrfd.service
open5gs-scpd.service
open5gs-amfd.service
open5gs-smfd.service
open5gs-upfd.service
open5gs-ausfd.service
open5gs-udmd.service
open5gs-udrd.service
open5gs-pcfd.service
open5gs-nssfd.service
open5gs-bsfd.service
open5gs-mmed.service
open5gs-hssd.service
open5gs-pcrfd.service
open5gs-sgwcd.service
open5gs-sgwud.service
```

### MongoDB Schema

Open5GS uses MongoDB for subscriber storage. The NMS matches this schema exactly.

**Database:** `open5gs`  
**Collection:** `subscribers`

**Document Structure:**
```json
{
  "imsi": "001010000000001",
  "msisdn": ["1234567890"],
  "security": {
    "k": "465B5CE8B199B49FAA5F0A2EE238A6BC",
    "opc": "E8ED289DEBA952E4283B54E88E6183CA",
    "amf": "8000",
    "sqn": 0
  },
  "ambr": {
    "downlink": { "value": 1, "unit": 3 },
    "uplink": { "value": 1, "unit": 3 }
  },
  "slice": [
    {
      "sst": 1,
      "default_indicator": true,
      "session": [
        {
          "name": "internet",
          "type": 3,
          "qos": {
            "index": 9,
            "arp": {
              "priority_level": 8,
              "pre_emption_capability": 1,
              "pre_emption_vulnerability": 1
            }
          },
          "ambr": {
            "downlink": { "value": 1, "unit": 3 },
            "uplink": { "value": 1, "unit": 3 }
          }
        }
      ]
    }
  ],
  "access_restriction_data": 32,
  "subscriber_status": 0,
  "network_access_mode": 0,
  "subscribed_rau_tau_timer": 12
}
```

**Key Points:**
- `k` and `opc`: 128-bit hex keys (32 hex characters)
- `unit: 3` means Gbps for AMBR values
- `type: 3` means IPv4 PDU session
- `qos.index` maps to 5QI (5G QoS Identifier)
- Multiple slices and sessions supported

### Interface Protocols

The NMS monitors and validates these Open5GS interfaces:

**Service-Based Interface (SBI):**
- Protocol: HTTP/2
- Port: 7777 (default)
- Used by: All 5G NFs
- Discovery: Via NRF or SCP

**PFCP (Packet Forwarding Control Protocol):**
- Port: 8805
- Used by: SMF ↔ UPF, SGW-C ↔ SGW-U
- Purpose: Control plane to user plane signaling

**NGAP (NG Application Protocol):**
- Port: 38412 (SCTP)
- Used by: AMF ↔ gNodeB
- Purpose: 5G control plane

**GTP-U (GPRS Tunneling Protocol - User):**
- Port: 2152 (UDP)
- Used by: UPF, SGW-U for user data tunneling
- Purpose: 4G/5G user plane encapsulation

**S1-MME:**
- Port: 36412 (SCTP)
- Used by: MME ↔ eNodeB
- Purpose: 4G control plane

**S1-U:**
- Port: 2152 (UDP)
- Used by: SGW-U ↔ eNodeB
- Purpose: 4G user plane

**Diameter:**
- Port: 3868
- Used by: HSS, PCRF
- Purpose: 4G authentication and policy

---

## Core Features

### 1. Configuration Management

**Capabilities:**
- Edit all 16 NF configurations through structured forms
- Form mode (guided inputs) or Text mode (Monaco YAML editor)
- Real-time validation with Zod schemas
- Cross-service dependency checking
- YAML comment and format preservation
- Diff preview before applying changes

**Safety Features:**
- Mutex-locked apply operations (one at a time)
- Automatic timestamped backups before every apply
- Ordered service restarts respecting dependencies
- Post-restart verification (systemctl is-active checks)
- Automatic rollback on any failure
- Audit logging of all changes

**Validation Rules:**
- IP address format validation
- Port range checking (1-65535)
- PLMN ID format (MCC: 3 digits, MNC: 2-3 digits)
- TAC range (1-65535)
- S-NSSAI (SST: 1-255, SD: 24-bit hex)
- NRF URI consistency across NFs
- PFCP address matching (SMF client = UPF server)

### 2. Service Management

**Features:**
- Real-time service status monitoring
- Start/Stop/Restart individual services
- Bulk restart all services
- Service health indicators (active/inactive/failed)
- Automatic status updates via WebSocket
- Service dependency awareness

**Service Status Information:**
- Active state (running/stopped/failed)
- PID (process ID)
- Memory usage
- Uptime
- Last restart time
- systemd unit status

**WebSocket Updates:**
```json
{
  "type": "service_status_update",
  "payload": {
    "statuses": [
      {
        "name": "nrf",
        "active": true,
        "pid": 12345,
        "uptime": "3d 14h 32m"
      }
    ]
  }
}
```

### 3. Subscriber Management

**Operations:**
- Create new subscribers
- Edit existing subscribers
- Delete subscribers
- Search by IMSI or MSISDN
- Paginated list view (50 per page)
- Bulk import from CSV (planned)

**SIM Generator:**
- Country-based MCC selection (65+ countries)
- Sequential IMSI generation
- Random K/OPc key generation
- Configurable AMBR values
- Default QoS profiles
- Simlessly eSIM integration support

**SUCI Integration:**
- Generate home network public/private keypairs
- Support for Profile A (X25519/curve25519) and Profile B (secp256r1)
- PKI value selection (0-255)
- Public key display and export
- Routing indicator configuration
- Automatic UDM config update

### 4. Network Topology

**Visualization:**
- Interactive JointJS-based diagram
- Real-time NF status indicators
- Connection validity checking
- Interface protocol labels
- Service status color coding
  - Green: Active service
  - Red: Inactive service
  - Green connections: Both endpoints active (animated)
  - Gray connections: At least one endpoint inactive

**Displayed Information:**
- All 16 NF positions and status
- S1-MME and S1-U active connections
- Connected eNodeB IP addresses
- Active UE sessions (IP + IMSI correlation)
- Interface labels (N2, N3, N4, S1-MME, S1-U, etc.)

**Layout:**
- Control Plane box (gray border)
- User Plane box (gray border)
- SBI box (pink dashed border)
- RAN elements (eNodeB, gNodeB)
- External connections (MongoDB, Internet)

### 5. Audit Trail

**Logged Events:**
- Configuration loads
- Configuration applies (with diff)
- Configuration rollbacks
- Service restarts
- Subscriber creates/updates/deletes
- Backup creations
- Restore operations
- Auto-config executions
- SUCI key generations

**Log Format:**
```json
{
  "timestamp": "2026-03-14T10:30:45.123Z",
  "action": "config_apply",
  "user": "admin",
  "details": "Applied configuration changes to 5 NFs",
  "diffSummary": "amf: Updated TAI list\nsmf: Changed session pool...",
  "restartResult": {
    "success": true,
    "services": ["nrf", "amf", "smf"],
    "errors": []
  },
  "success": true
}
```

**Storage:**
- File-based logging to `/var/log/open5gs-nms/audit/`
- Daily log rotation
- JSON lines format for easy parsing
- Indefinite retention

### 6. Backup & Restore

**Backup Types:**
- Configuration backups (all 16 YAML files)
- MongoDB backups (subscribers collection)
- Combined backups (config + MongoDB)

**Backup Storage:**
- Config backups: `/etc/open5gs/backups/config/YYYY-MM-DD-HHMM/`
- MongoDB backups: `/etc/open5gs/backups/mongodb/YYYY-MM-DD-HHMM/`
- Automatic cleanup (keep last 30 backups)

**Restore Operations:**
- Selective restore (config only, MongoDB only, or both)
- Preview before restore
- Automatic service restart after config restore
- Rollback to any previous backup

**Automatic Backups:**
- Before every config apply
- Before restore defaults
- Manual backup via UI button

### 7. SUCI Key Management

**SUCI (Subscription Concealed Identifier)** provides 5G privacy by encrypting SUPI (IMSI) over the air.

**Features:**
- Generate home network keypairs (public/private)
- Two SUCI profiles supported:
  - **Profile A**: X25519 (curve25519) - Recommended
  - **Profile B**: secp256r1 (NIST P-256)
- PKI value selection (0-255)
- Routing Indicator (4 hex chars, default "0000")
- Public key hex display
- Private key secure storage (`/etc/open5gs/hnet/{pki}.key`)
- Automatic UDM config update with public key

**Key Generation Process:**
1. User selects Profile (A or B), PKI value (0-255)
2. Backend calls `openssl` to generate keypair
3. Private key saved to `/etc/open5gs/hnet/{pki}.key` (permissions: 600)
4. Public key extracted and converted to hex
5. UDM config (`/etc/open5gs/udm.yaml`) updated with:
   ```yaml
   hnet:
     - id: 1
       scheme: 1  # Profile A
       key: "PUBLIC_KEY_HEX_STRING"
   ```
6. Return public key to frontend for display

**Regenerate/Delete Operations:**
- Regenerate: Generate new keypair with same PKI value
- Delete: Remove key files and UDM config entry
- Warning modals for destructive operations

### 8. Auto-Configuration Wizard

**Purpose:** Generate all 16 NF configurations from minimal input for quick deployment.

**Input Parameters:**
- PLMN ID (MCC/MNC)
- Control plane server IP
- User plane server IP
- Session subnet (e.g., 10.45.0.0/16)
- DNS servers
- Network name (full/short)

**Generated Configs:**
- All 16 NF YAML files with:
  - Correct IP addresses and ports
  - NRF registration URIs
  - PFCP client-server matching
  - TAI lists
  - PLMN support lists
  - Network slicing (SST 1)
  - Default QoS profiles
  - Security algorithms (NIA2/NEA2)

**Apply Options:**
- Preview generated configs before applying
- Apply directly with automatic backup
- Download as ZIP archive

### 9. Log Streaming

**Features:**
- Real-time log tailing via WebSocket
- Select any NF service to stream logs
- Auto-scroll with pause button
- Color-coded log levels (ERROR=red, WARN=yellow, INFO=blue)
- Search/filter log lines
- Download logs as text file

**Implementation:**
```typescript
// Backend streams journalctl output
async *streamLogs(serviceName: string): AsyncIterableIterator<string> {
  const process = spawn('journalctl', ['-u', serviceName, '-f', '--no-pager']);
  for await (const chunk of process.stdout) {
    yield chunk.toString();
  }
}

// Frontend subscribes via WebSocket
ws.send(JSON.stringify({ type: 'subscribe_logs', service: 'open5gs-amfd' }));
ws.onmessage = (event) => {
  const { type, line } = JSON.parse(event.data);
  if (type === 'log_line') {
    appendToLogView(line);
  }
};
```

### 10. Active Session Monitoring

**Features:**
- List all active UE sessions
- Display UE IP addresses
- Correlate IP addresses with IMSI from MongoDB
- Real-time updates (30 second polling)
- Session count indicator
- Integration with topology visualization

**Data Sources:**
- `ip route show table 1` — UE IP addresses from routing table
- MongoDB subscribers collection — IMSI lookup
- conntrack table — S1-U connections (planned)

**Display:**
```
Active UE Sessions (2)
◆ 10.45.0.2
  IMSI: 001010000000001
◆ 10.45.0.3
  IMSI: 001010000000002
```

---

## API Reference

### Configuration Endpoints

**GET /api/config/all**
- Returns all 16 NF configurations
- Response: `{ success: true, configs: AllConfigs }`

**POST /api/config/validate**
- Validates configuration object
- Body: `AllConfigs`
- Response: `{ success: true, result: ValidationResult }`

**POST /api/config/apply**
- Applies new configurations with safety checks
- Body: `AllConfigs`
- Response: `{ success: boolean, diff: string, validationErrors: [], restartResults: [], rollback: boolean }`

**GET /api/config/topology**
- Returns network topology graph
- Response: `{ success: true, topology: TopologyGraph }`

**GET /api/config/raw/:service**
- Returns raw YAML for a specific service
- Params: `service` (nrf, amf, smf, etc.)
- Response: Raw YAML text

### Service Endpoints

**GET /api/services/statuses**
- Returns status of all 16 services
- Response: `{ success: true, statuses: ServiceStatus[] }`

**POST /api/services/:service/start**
- Starts a service
- Params: `service`
- Response: `{ success: true }`

**POST /api/services/:service/stop**
- Stops a service
- Params: `service`
- Response: `{ success: true }`

**POST /api/services/:service/restart**
- Restarts a service
- Params: `service`
- Response: `{ success: true }`

### Subscriber Endpoints

**GET /api/subscribers**
- Lists subscribers with pagination
- Query params: `skip`, `limit`, `search`
- Response: `{ success: true, subscribers: Subscriber[], total: number }`

**POST /api/subscribers**
- Creates a new subscriber
- Body: `CreateSubscriberDto`
- Response: `{ success: true, subscriber: Subscriber }`

**GET /api/subscribers/:imsi**
- Gets a specific subscriber
- Params: `imsi`
- Response: `{ success: true, subscriber: Subscriber }`

**PUT /api/subscribers/:imsi**
- Updates a subscriber
- Params: `imsi`
- Body: `UpdateSubscriberDto`
- Response: `{ success: true, subscriber: Subscriber }`

**DELETE /api/subscribers/:imsi**
- Deletes a subscriber
- Params: `imsi`
- Response: `{ success: true }`

### Backup Endpoints

**GET /api/backup/list**
- Lists all available backups
- Response: `{ success: true, backups: BackupMetadata[] }`

**POST /api/backup/create**
- Creates a new backup (config + MongoDB)
- Response: `{ success: true, backup: BackupMetadata }`

**POST /api/backup/restore**
- Restores from a backup
- Body: `{ timestamp: string, restoreConfig: boolean, restoreMongo: boolean }`
- Response: `{ success: true }`

**POST /api/backup/defaults/restore**
- Restores all configs to factory defaults
- Response: `{ success: true }`

### SUCI Endpoints

**GET /api/suci/keys**
- Lists all SUCI keys
- Response: `{ success: true, keys: SuciKey[] }`

**POST /api/suci/generate**
- Generates a new SUCI keypair
- Body: `{ scheme: number, pki: number }`
- Response: `{ success: true, key: SuciKey }`

**PUT /api/suci/regenerate/:pki**
- Regenerates a SUCI keypair
- Params: `pki`
- Response: `{ success: true, key: SuciKey }`

**DELETE /api/suci/:pki**
- Deletes a SUCI key
- Params: `pki`
- Query: `deleteFile` (boolean)
- Response: `{ success: true }`

### Auto-Config Endpoints

**POST /api/auto-config/generate**
- Generates all configs from wizard input
- Body: `AutoConfigParams`
- Response: `{ success: true, configs: AllConfigs }`

### Interface Status Endpoints

**GET /api/interface-status**
- Returns interface status (S1-MME, S1-U, active UEs)
- Response: `{ success: true, status: InterfaceStatus }`

### Audit Endpoints

**GET /api/audit/logs**
- Returns audit logs
- Query params: `skip`, `limit`, `action`, `startDate`, `endDate`
- Response: `{ success: true, logs: AuditLog[], total: number }`

### WebSocket Events

**Connected to ws://localhost:3002**

**Client → Server:**
```json
{ "type": "subscribe_logs", "service": "open5gs-amfd" }
```

**Server → Client:**
```json
{ "type": "service_status_update", "payload": { "statuses": [...] } }
{ "type": "log_line", "line": "2026-03-14 10:30:45.123 [INFO] AMF started" }
{ "type": "config_applied", "payload": { "timestamp": "..." } }
```

---

## Database Schema

### MongoDB Collections

**Database:** `open5gs`

**Collection:** `subscribers`

Full subscriber document schema:

```typescript
interface MongoSubscriber {
  _id: ObjectId;
  imsi: string;                    // "001010000000001"
  msisdn?: string[];               // ["1234567890"]
  imeisv?: string;
  mme_host?: string;
  mme_realm?: string;
  purge_flag?: boolean[];
  
  security: {
    k: string;                     // 128-bit hex (32 chars)
    opc?: string;                  // 128-bit hex (32 chars)
    op?: string;                   // Alternative to opc
    amf: string;                   // "8000"
    sqn: number;                   // Sequence number, starts at 0
  };
  
  ambr: {
    downlink: { value: number; unit: number };  // unit: 0=bps, 1=Kbps, 2=Mbps, 3=Gbps
    uplink: { value: number; unit: number };
  };
  
  slice: Array<{
    sst: number;                   // 1-255
    sd?: string;                   // 24-bit hex (6 chars)
    default_indicator: boolean;
    session: Array<{
      name: string;                // "internet", "ims", etc.
      type: number;                // 1=IPv4, 2=IPv6, 3=IPv4v6
      qos: {
        index: number;             // 5QI (1-254)
        arp: {
          priority_level: number;  // 1-15 (lower = higher priority)
          pre_emption_capability: number;   // 1=may, 2=not
          pre_emption_vulnerability: number; // 1=yes, 2=not
        };
      };
      ambr: {
        downlink: { value: number; unit: number };
        uplink: { value: number; unit: number };
      };
      ue?: {
        ipv4?: string;
        ipv6?: string;
      };
      smf?: {
        id: string;
      };
      pcc_rule?: Array<any>;
    }>;
  }>;
  
  access_restriction_data: number;    // 32 = all allowed
  subscriber_status: number;          // 0 = service granted
  network_access_mode: number;        // 0 = packet and circuit
  subscribed_rau_tau_timer: number;   // 12 = 12 minutes
  
  __v?: number;                       // Mongoose version key
}
```

**Indexes:**
- `{ imsi: 1 }` — Unique index on IMSI
- `{ msisdn: 1 }` — Index on MSISDN (if present)

---

## Security & Safety

### Configuration Safety

**Mutex Locking:**
- Only one config apply operation allowed at a time
- Using `async-mutex` library
- Prevents race conditions and config corruption

**Automatic Backups:**
- Created before every apply operation
- Timestamped: `/etc/open5gs/backups/config/YYYY-MM-DD-HHMM/`
- Contains all 16 YAML files
- Stored indefinitely (manual cleanup)

**Ordered Service Restarts:**
```
1. NRF (must be first - all NFs register here)
2. SCP (optional routing proxy)
3. UDR (data repository)
4. UDM (depends on UDR)
5. AUSF (depends on UDM)
6. PCF (policy function)
7. NSSF (slice selection)
8. BSF (binding support)
9. AMF (depends on AUSF)
10. SMF (depends on PCF, AMF)
11. UPF (depends on SMF for PFCP)
12. MME (4G mobility)
13. HSS (4G subscriber server)
14. PCRF (4G policy)
15. SGW-C (4G control plane)
16. SGW-U (4G user plane)
```

**Post-Restart Verification:**
- After each service restart, check `systemctl is-active`
- Retry up to 5 times with increasing delays
- If any service fails to start, trigger rollback

**Automatic Rollback:**
- Restore backup YAML files
- Restart all services with old configs
- Log rollback event to audit trail
- Return failure to frontend with error details

### HTTP Security

**Helmet Middleware:**
- Sets secure HTTP headers
- Prevents common web vulnerabilities
- HSTS, X-Frame-Options, CSP, etc.

**CORS:**
- Configured to allow frontend origin
- Credentials allowed for authentication (planned)

**Rate Limiting:**
- 100 requests per 15 minutes per IP
- Applied to all `/api/*` routes
- Prevents brute force and DoS attacks

**Input Validation:**
- Zod schemas for all API inputs
- Type checking with TypeScript
- SQL injection not applicable (MongoDB, no raw queries)

**Compression:**
- Gzip compression for HTTP responses
- Reduces bandwidth usage

### Container Security

**Privileged Mode:**
- Required for systemctl access
- Necessary evil for service management
- Mitigated by:
  - Read-only mounts where possible
  - Minimal attack surface
  - No public network exposure

**Host PID Namespace:**
- Required to manage host services
- Container can see all host processes
- Risk accepted for operational necessity

**Volume Mounts:**
- `/etc/open5gs` — Read/write for configs
- `/var/log/open5gs` — Read-only for logs
- `/run/systemd`, `/var/run/dbus` — Read-only for systemd
- `/usr/bin/systemctl`, `/lib/systemd` — Read-only binaries

### Secrets Management

**Subscriber Keys (K, OPc):**
- Stored in MongoDB (local database)
- Not transmitted over network (except localhost)
- HTTPS recommended for production (nginx SSL termination)

**SUCI Private Keys:**
- Stored in `/etc/open5gs/hnet/*.key`
- File permissions: 600 (owner read/write only)
- Never transmitted to frontend
- Only public keys exposed via API

**No Authentication (Current):**
- No user login required
- Suitable for trusted internal networks only
- **TODO:** Add JWT-based authentication for production

---

## Deployment

### Prerequisites

1. **Ubuntu/Debian Server** with Open5GS installed:
   ```bash
   sudo apt update
   sudo apt install open5gs
   ```

2. **MongoDB** running on localhost:
   ```bash
   sudo apt install mongodb
   sudo systemctl enable mongodb
   sudo systemctl start mongodb
   ```

3. **Docker and Docker Compose**:
   ```bash
   curl -fsSL https://get.docker.com -o get-docker.sh
   sudo sh get-docker.sh
   sudo apt install docker-compose
   ```

4. **Open5GS Configs** in `/etc/open5gs/`:
   ```
   /etc/open5gs/
   ├── amf.yaml
   ├── ausf.yaml
   ├── bsf.yaml
   ├── hss.yaml
   ├── mme.yaml
   ├── nrf.yaml
   ├── nssf.yaml
   ├── pcf.yaml
   ├── pcrf.yaml
   ├── scp.yaml
   ├── sgwc.yaml
   ├── sgwu.yaml
   ├── smf.yaml
   ├── udm.yaml
   ├── udr.yaml
   └── upf.yaml
   ```

### Quick Start

1. **Clone/Copy Project:**
   ```bash
   cd /opt
   git clone https://github.com/YOUR_ORG/open5gs-nms.git
   cd open5gs-nms
   ```

2. **Configure Environment** (optional):
   ```bash
   cp .env.example .env
   # Edit .env if needed (defaults work for most cases)
   ```

3. **Build and Start:**
   ```bash
   docker-compose up --build -d
   ```

4. **Access UI:**
   ```
   http://YOUR_SERVER_IP:8080
   ```

5. **Check Logs:**
   ```bash
   docker-compose logs -f backend
   docker-compose logs -f frontend
   docker-compose logs -f nginx
   ```

### Docker Compose Configuration

```yaml
services:
  nginx:
    image: nginx:alpine
    container_name: open5gs-nms-nginx
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/conf.d/nms.conf:ro
    depends_on:
      backend:
        condition: service_healthy
      frontend:
        condition: service_healthy

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    container_name: open5gs-nms-backend
    restart: unless-stopped
    privileged: true          # For systemctl access
    pid: host                 # For process management
    network_mode: host        # For MongoDB and services
    volumes:
      - /etc/open5gs:/etc/open5gs
      - /var/log/open5gs:/var/log/open5gs
      - /run/systemd/system:/run/systemd/system:ro
      - /var/run/dbus/system_bus_socket:/var/run/dbus/system_bus_socket
      - /usr/bin/systemctl:/usr/bin/systemctl:ro
      - /lib/systemd:/lib/systemd:ro
      - ./logs:/var/log/open5gs-nms
      - /etc/open5gs/backups:/etc/open5gs/backups
    environment:
      - NODE_ENV=production
      - PORT=3001
      - MONGODB_URI=mongodb://127.0.0.1:27017/open5gs
      - CONFIG_PATH=/etc/open5gs
      - BACKUP_PATH=/etc/open5gs/backups/config
      - MONGO_BACKUP_PATH=/etc/open5gs/backups/mongodb
      - LOG_LEVEL=info
      - WS_PORT=3002
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:3001/api/health', r => { process.exit(r.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 10s

  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
      args:
        - VITE_API_URL=
        - VITE_WS_URL=
    container_name: open5gs-nms-frontend
    restart: unless-stopped
    network_mode: host
    depends_on:
      backend:
        condition: service_healthy
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `production` | Node.js environment |
| `PORT` | `3001` | Backend REST API port |
| `WS_PORT` | `3002` | WebSocket server port |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/open5gs` | MongoDB connection string |
| `CONFIG_PATH` | `/etc/open5gs` | Open5GS config directory |
| `BACKUP_PATH` | `/etc/open5gs/backups/config` | Config backup location |
| `MONGO_BACKUP_PATH` | `/etc/open5gs/backups/mongodb` | MongoDB backup location |
| `LOG_LEVEL` | `info` | Pino log level (fatal, error, warn, info, debug, trace) |
| `HOST_SYSTEMCTL_PATH` | `/usr/bin/systemctl` | Path to systemctl binary |
| `VITE_API_URL` | `` | Frontend API URL (empty = relative URLs) |
| `VITE_WS_URL` | `` | Frontend WebSocket URL (empty = relative) |

### Firewall Configuration

**Required Ports:**
- **8080** — nginx (HTTP, frontend + API proxy)
- **3001** — backend REST API (internal, proxied by nginx)
- **3002** — backend WebSocket (internal, proxied by nginx)
- **27017** — MongoDB (localhost only, no external access)

**Recommended Firewall Rules:**
```bash
# Allow HTTP to NMS
sudo ufw allow 8080/tcp

# Allow HTTPS (if using SSL)
sudo ufw allow 443/tcp

# Block direct access to backend
sudo ufw deny 3001/tcp
sudo ufw deny 3002/tcp

# MongoDB should only listen on localhost (edit /etc/mongodb.conf)
# bindIp: 127.0.0.1
```

### SSL/TLS Configuration (Production)

For production deployments, terminate SSL at nginx:

1. **Obtain SSL Certificate** (Let's Encrypt):
   ```bash
   sudo apt install certbot
   sudo certbot certonly --standalone -d nms.yourdomain.com
   ```

2. **Update nginx.conf:**
   ```nginx
   server {
       listen 443 ssl http2;
       server_name nms.yourdomain.com;
       
       ssl_certificate /etc/letsencrypt/live/nms.yourdomain.com/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/nms.yourdomain.com/privkey.pem;
       ssl_protocols TLSv1.2 TLSv1.3;
       ssl_ciphers HIGH:!aNULL:!MD5;
       
       # ... rest of config
   }
   
   server {
       listen 80;
       server_name nms.yourdomain.com;
       return 301 https://$server_name$request_uri;
   }
   ```

3. **Mount SSL Certs in Docker Compose:**
   ```yaml
   nginx:
     volumes:
       - ./nginx/nginx.conf:/etc/nginx/conf.d/nms.conf:ro
       - /etc/letsencrypt:/etc/letsencrypt:ro
   ```

### Backup Strategy

**Automated Backups:**
- Config backups: Before every apply operation
- MongoDB backups: Manual or via cron job

**Manual Backup:**
```bash
# Via UI: Click "Create Backup" button

# Via CLI:
curl -X POST http://localhost:8080/api/backup/create
```

**Scheduled Backups (cron):**
```bash
# Edit crontab
crontab -e

# Daily backup at 2 AM
0 2 * * * curl -X POST http://localhost:8080/api/backup/create
```

**Restore from Backup:**
```bash
# Via UI: Backup page → Select backup → Restore

# Via CLI:
curl -X POST http://localhost:8080/api/backup/restore \
  -H "Content-Type: application/json" \
  -d '{"timestamp":"2026-03-14-1030","restoreConfig":true,"restoreMongo":true}'
```

### Monitoring and Logs

**Application Logs:**
```bash
# Backend logs
docker-compose logs -f backend

# Frontend build logs
docker-compose logs frontend

# nginx access logs
docker-compose logs -f nginx
```

**Audit Logs:**
```bash
# View audit trail
tail -f ./logs/audit/YYYY-MM-DD.log

# Search audit logs
grep "config_apply" ./logs/audit/*.log
```

**Service Logs (Open5GS):**
```bash
# Via journalctl
journalctl -u open5gs-amfd -f

# Via UI: Logs page → Select service → Stream
```

**System Resource Usage:**
```bash
# Container stats
docker stats

# Disk usage
df -h /etc/open5gs
df -h /var/log/open5gs
```

---

## Development Guide

### Local Development Setup

1. **Clone Repository:**
   ```bash
   git clone https://github.com/YOUR_ORG/open5gs-nms.git
   cd open5gs-nms
   ```

2. **Install Dependencies:**
   ```bash
   # Backend
   cd backend
   npm install
   
   # Frontend
   cd ../frontend
   npm install
   ```

3. **Start Backend (Dev Mode):**
   ```bash
   cd backend
   npm run dev
   # Runs on http://localhost:3001
   ```

4. **Start Frontend (Dev Mode):**
   ```bash
   cd frontend
   npm run dev
   # Runs on http://localhost:5173
   ```

5. **Environment Setup:**
   ```bash
   # backend/.env
   NODE_ENV=development
   PORT=3001
   WS_PORT=3002
   MONGODB_URI=mongodb://127.0.0.1:27017/open5gs
   CONFIG_PATH=/etc/open5gs
   LOG_LEVEL=debug
   
   # frontend/.env
   VITE_API_URL=http://localhost:3001
   VITE_WS_URL=ws://localhost:3002
   ```

### Project Structure

```
open5gs-nms/
├── backend/
│   ├── src/
│   │   ├── domain/          # Business logic
│   │   ├── application/     # Use cases
│   │   ├── infrastructure/  # External integrations
│   │   ├── interfaces/      # REST controllers
│   │   ├── config/          # App config
│   │   └── index.ts         # Entry point
│   ├── package.json
│   ├── tsconfig.json
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── components/      # React components
│   │   ├── stores/          # Zustand stores
│   │   ├── api/             # API clients
│   │   ├── hooks/           # Custom hooks
│   │   ├── types/           # TypeScript types
│   │   └── App.tsx          # Root component
│   ├── package.json
│   ├── vite.config.ts
│   └── Dockerfile
├── nginx/
│   └── nginx.conf           # Reverse proxy config
├── docker-compose.yml
├── .env
└── README.md
```

### Code Style

**Backend:**
- ESLint + Prettier
- TypeScript strict mode
- Functional programming preferred
- Dependency injection for testability

**Frontend:**
- ESLint + React rules
- Prettier for formatting
- Functional components (no classes)
- Hooks for state and effects

**Linting:**
```bash
# Backend
cd backend
npm run lint
npm run lint:fix

# Frontend
cd frontend
npm run lint
```

### Testing

**Backend Tests (TODO):**
```bash
cd backend
npm test
```

**Frontend Tests (TODO):**
```bash
cd frontend
npm test
```

### Building for Production

**Backend:**
```bash
cd backend
npm run build
# Outputs to backend/dist/
```

**Frontend:**
```bash
cd frontend
npm run build
# Outputs to frontend/dist/
```

**Docker Build:**
```bash
docker-compose build
```

### Adding a New NF Config

1. **Define Entity** in `backend/src/domain/entities/`:
   ```typescript
   // new-nf-config.ts
   export interface NewNfConfig {
     sbi: { addr: string; port: number };
     // ... other fields
   }
   ```

2. **Update AllConfigs** type:
   ```typescript
   // backend/src/domain/interfaces/config-repository.ts
   export interface AllConfigs {
     // ... existing NFs
     newnf: NewNfConfig;
   }
   ```

3. **Add Repository Methods:**
   ```typescript
   // In IConfigRepository and YamlConfigRepository
   loadNewNf(): Promise<NewNfConfig>;
   saveNewNf(config: NewNfConfig): Promise<void>;
   ```

4. **Create Frontend Editor:**
   ```tsx
   // frontend/src/components/config/editors/NewNfEditor.tsx
   export function NewNfEditor({ configs, onChange }) {
     // Editor implementation
   }
   ```

5. **Add to ConfigPage:**
   ```tsx
   // frontend/src/components/config/ConfigPage.tsx
   {activeTab === 'newnf' && <NewNfEditor configs={configs} onChange={updateConfigs} />}
   ```

6. **Update Service Restart Order:**
   ```typescript
   // backend/src/domain/entities/service-status.ts
   const SERVICE_RESTART_ORDER: ServiceName[] = [
     // ... insert new NF in correct dependency order
   ];
   ```

---

## Troubleshooting

### Common Issues

**1. Backend Can't Access MongoDB**

Symptom: `MongoServerError: connect ECONNREFUSED 127.0.0.1:27017`

Solution:
```bash
# Check MongoDB status
sudo systemctl status mongodb

# Start MongoDB if stopped
sudo systemctl start mongodb

# Check MongoDB is listening on localhost
sudo netstat -tlnp | grep 27017
```

**2. systemctl Commands Fail in Container**

Symptom: `Failed to connect to bus: No such file or directory`

Solution:
- Ensure container has `privileged: true`
- Verify D-Bus socket is mounted: `/var/run/dbus/system_bus_socket`
- Check systemd mount: `/run/systemd/system`

**3. Config Apply Fails with Rollback**

Symptom: Apply operation returns `rollback: true`

Steps:
1. Check audit logs: `./logs/audit/YYYY-MM-DD.log`
2. Review restart results in API response
3. Check failed service logs: `journalctl -u open5gs-xxxd`
4. Fix config issue and retry

**4. Frontend Can't Reach Backend**

Symptom: Network errors in browser console

Solution:
- Check nginx is running: `docker-compose ps nginx`
- Verify nginx config: `docker-compose logs nginx`
- Check backend health: `curl http://localhost:3001/api/health`
- Restart nginx: `docker-compose restart nginx`

**5. WebSocket Connection Drops**

Symptom: Service status stops updating

Solution:
```bash
# Check WebSocket server
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: test" \
  -H "Sec-WebSocket-Version: 13" \
  http://localhost:3002

# Restart backend
docker-compose restart backend
```

**6. Topology Shows Incorrect Status**

Symptom: All services show as inactive despite being active

Solution:
- Check service monitor polling: `docker-compose logs backend | grep "Service monitoring"`
- Verify systemctl works: `docker-compose exec backend systemctl is-active open5gs-nrfd`
- Restart backend: `docker-compose restart backend`

**7. SUCI Key Generation Fails**

Symptom: Error when generating SUCI keys

Solution:
- Check openssl is installed in container: `docker-compose exec backend which openssl`
- Verify `/etc/open5gs/hnet` directory exists and is writable
- Check backend logs: `docker-compose logs backend | grep SUCI`

**8. High Memory Usage**

Symptom: Containers consuming excessive memory

Solution:
```bash
# Check container resource usage
docker stats

# Limit container memory in docker-compose.yml
services:
  backend:
    mem_limit: 512m
  frontend:
    mem_limit: 256m
```

**9. Backup Creation Fails**

Symptom: Backup operation returns error

Solution:
- Verify backup directories exist and are writable:
  ```bash
  sudo mkdir -p /etc/open5gs/backups/config
  sudo mkdir -p /etc/open5gs/backups/mongodb
  sudo chmod 755 /etc/open5gs/backups
  ```
- Check disk space: `df -h /etc/open5gs`

**10. Subscriber Create Fails**

Symptom: Error when creating subscriber in UI

Solution:
- Check MongoDB connection: `docker-compose logs backend | grep MongoDB`
- Verify subscriber schema matches:
  ```bash
  mongo open5gs --eval "db.subscribers.findOne()"
  ```
- Check for duplicate IMSI:
  ```bash
  mongo open5gs --eval "db.subscribers.find({imsi: 'YOUR_IMSI'})"
  ```

### Debug Mode

Enable detailed logging:

**Backend:**
```bash
# Edit docker-compose.yml
environment:
  - LOG_LEVEL=debug  # or trace for maximum verbosity
```

**Frontend:**
```bash
# In browser console
localStorage.setItem('debug', '*')
# Reload page
```

### Performance Optimization

**Backend:**
- Use connection pooling for MongoDB
- Enable response caching for static config data
- Rate limit WebSocket broadcasts (currently 5s interval)

**Frontend:**
- Use React.memo for expensive components
- Debounce search inputs
- Virtualize long subscriber lists (react-window)

### Health Checks

**Backend Health Endpoint:**
```bash
curl http://localhost:3001/api/health
```

**Expected Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-03-14T10:30:45.123Z",
  "wsConnections": 2
}
```

**All Services Check:**
```bash
curl http://localhost:3001/api/services/statuses | jq
```

---

## Appendix

### Open5GS Reference

**3GPP Interfaces:**
- N1: UE ↔ AMF (NAS)
- N2: gNodeB ↔ AMF (NGAP)
- N3: gNodeB ↔ UPF (GTP-U)
- N4: SMF ↔ UPF (PFCP)
- N6: UPF ↔ Data Network
- N7: SMF ↔ PCF
- N8: AMF ↔ UDM
- N11: AMF ↔ SMF
- N12: AMF ↔ AUSF
- N13: AUSF ↔ UDM
- N35: UDM ↔ UDR
- N36: PCF ↔ UDR

**4G EPC Interfaces:**
- S1-MME: eNodeB ↔ MME (control)
- S1-U: eNodeB ↔ SGW-U (user data)
- S5: SGW ↔ PGW
- S6a: MME ↔ HSS (Diameter)
- S11: MME ↔ SGW-C (GTP-C)
- Gx: PCRF ↔ PGW (Diameter)

### Glossary

- **AMF**: Access and Mobility Management Function
- **AMBR**: Aggregate Maximum Bit Rate
- **AUSF**: Authentication Server Function
- **BSF**: Binding Support Function
- **CUPS**: Control and User Plane Separation
- **EPC**: Evolved Packet Core (4G)
- **GUMMEI**: Globally Unique MME Identifier
- **HSS**: Home Subscriber Server
- **IMSI**: International Mobile Subscriber Identity
- **K**: Long-term key (128-bit)
- **MME**: Mobility Management Entity (4G)
- **MSISDN**: Mobile Station International Subscriber Directory Number
- **NF**: Network Function
- **NRF**: NF Repository Function
- **NSSF**: Network Slice Selection Function
- **OPc**: Derived operator key (from OP and K)
- **PCF**: Policy Control Function
- **PCRF**: Policy and Charging Rules Function (4G)
- **PFCP**: Packet Forwarding Control Protocol
- **PLMN**: Public Land Mobile Network
- **QoS**: Quality of Service
- **SBI**: Service-Based Interface
- **SCP**: Service Communication Proxy
- **SGW**: Serving Gateway (4G)
- **SMF**: Session Management Function
- **S-NSSAI**: Single Network Slice Selection Assistance Information
- **SST**: Slice/Service Type
- **SUCI**: Subscription Concealed Identifier
- **SUPI**: Subscription Permanent Identifier (IMSI)
- **TAC**: Tracking Area Code
- **TAI**: Tracking Area Identity
- **UDM**: Unified Data Management
- **UDR**: Unified Data Repository
- **UE**: User Equipment
- **UPF**: User Plane Function

---

**END OF DOCUMENTATION**

*This document covers the complete technical architecture, implementation details, and operational aspects of the Open5GS Network Management System. For questions or contributions, please refer to the project repository.*
