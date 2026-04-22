# System Architecture

Open5GS Network Management System architecture documentation.

---

## Table of Contents

1. [High-Level Overview](#high-level-overview)
2. [Component Architecture](#component-architecture)
3. [Backend Architecture](#backend-architecture)
4. [Frontend Architecture](#frontend-architecture)
5. [Data Flow](#data-flow)
6. [Technology Stack](#technology-stack)
7. [Design Patterns](#design-patterns)
8. [Security Architecture](#security-architecture)
9. [Deployment Architecture](#deployment-architecture)

---

## High-Level Overview

The Open5GS NMS follows a **three-tier architecture** with clear separation between presentation, application logic, and data layers:

```
┌─────────────────────────────────────────────────────────────┐
│  PRESENTATION LAYER                                          │
│  Browser (React 18 + TypeScript + JointJS + TailwindCSS)    │
│  Port: 8888 (nginx reverse proxy)                           │
└───────────────┬──────────────────┬──────────────────────────┘
                │ REST API         │ WebSocket
                │ /api/*           │ /ws
                ▼                  ▼
┌─────────────────────────────────────────────────────────────┐
│  APPLICATION LAYER                                           │
│  nginx Reverse Proxy (Alpine Linux)                         │
│  - Routes /api/* → backend:3001                             │
│  - Upgrades WebSocket → backend:3002                        │
│  - Serves static frontend from /usr/share/nginx/html        │
└───────────────┬──────────────────┬──────────────────────────┘
                │                  │
                ▼                  ▼
┌─────────────────────────────────────────────────────────────┐
│  BUSINESS LOGIC LAYER                                        │
│  Backend (Node.js 20 + TypeScript + Express)                │
│  Clean Architecture: Domain → Application → Infrastructure   │
│  Ports: 3001 (REST), 3002 (WebSocket)                       │
│  Container: privileged=true, network_mode=host, pid=host    │
└─────┬──────────┬──────────┬──────────────────────────────┬─┘
      │          │          │                              │
      ▼          ▼          ▼                              ▼
┌─────────────────────────────────────────────────────────────┐
│  DATA & SYSTEM LAYER                                         │
│  - Open5GS Configs (/etc/open5gs/*.yaml)                    │
│  - MongoDB (subscribers database, localhost:27017)          │
│  - systemd (service lifecycle management)                   │
│  - System logs (/var/log/open5gs/*)                         │
└─────────────────────────────────────────────────────────────┘
```

### Design Principles

1. **Clean Architecture** - Domain-driven design with dependency inversion
2. **Separation of Concerns** - Clear boundaries between layers
3. **Single Responsibility** - Each component has one well-defined purpose
4. **Dependency Injection** - Loose coupling through interfaces
5. **Type Safety** - Full TypeScript implementation across frontend and backend
6. **Immutability** - Functional programming patterns where appropriate

---

## Component Architecture

### System Components

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│   Browser    │───▶│    nginx     │───▶│   Backend    │
│  (React UI)  │◀───│ (Rev Proxy)  │◀───│ (Node.js)    │
└──────────────┘    └──────────────┘    └──────┬───────┘
                                                │
                    ┌───────────────────────────┼───────────────────┐
                    │                           │                   │
                    ▼                           ▼                   ▼
              ┌───────────┐             ┌───────────┐        ┌───────────┐
              │  Open5GS  │             │  MongoDB  │        │  systemd  │
              │  Configs  │             │ (Subs DB) │        │ (Services)│
              └───────────┘             └───────────┘        └───────────┘
```

### Component Responsibilities

| Component | Responsibility | Technology |
|-----------|---------------|------------|
| **Browser** | User interface, state management, API calls | React 18, TypeScript, Zustand |
| **nginx** | Reverse proxy, static file serving, SSL termination | nginx Alpine |
| **Backend** | Business logic, validation, orchestration | Node.js 20, Express, TypeScript |
| **Open5GS** | 5G/4G core network functions | Open5GS 2.7+ |
| **MongoDB** | Subscriber data persistence | MongoDB 6.0+ |
| **systemd** | Service lifecycle management | systemd (host) |
| **Prometheus** | Metrics scraping and storage | Prometheus (port 9099) |
| **Grafana** | Metrics dashboards and visualization | Grafana (port 3000) |

---

## Backend Architecture

The backend follows **Clean Architecture** principles with four distinct layers:

### Layer Structure

```
┌─────────────────────────────────────────────────────────────┐
│  INTERFACE LAYER (HTTP/WebSocket entry points)              │
│  - REST Controllers (Express routes)                         │
│  - WebSocket Handlers (ws server)                           │
│  - Request/Response DTOs                                     │
└────────────────────────┬────────────────────────────────────┘
                         │ calls
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  APPLICATION LAYER (Use Cases / Business workflows)         │
│  - ApplyConfigUseCase                                        │
│  - SubscriberManagementUseCase                              │
│  - ServiceMonitorUseCase                                     │
│  - BackupRestoreUseCase                                      │
└────────────────────────┬────────────────────────────────────┘
                         │ orchestrates
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  DOMAIN LAYER (Business logic, entities, interfaces)        │
│  - Entities: NrfConfig, AmfConfig, Subscriber, etc.         │
│  - Domain Services: TopologyBuilder, Validator              │
│  - Interfaces: IConfigRepository, IHostExecutor             │
└────────────────────────┬────────────────────────────────────┘
                         │ defines contracts for
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  INFRASTRUCTURE LAYER (External integrations)                │
│  - YamlConfigRepository (file I/O)                          │
│  - MongoSubscriberRepository (MongoDB driver)               │
│  - LocalHostExecutor (systemctl, bash)                      │
│  - WssBroadcaster (WebSocket server)                        │
│  - FileAuditLogger (structured logging)                     │
└─────────────────────────────────────────────────────────────┘
```

### Directory Structure

```
backend/src/
├── domain/              # Pure business logic (no external deps)
│   ├── entities/        # 16 NF config types, Subscriber, ServiceStatus
│   ├── interfaces/      # Abstract contracts (repositories, executors)
│   ├── services/        # Domain services (validation, topology)
│   └── value-objects/   # Immutable value types
│
├── application/         # Use case orchestration
│   ├── dto/             # Data transfer objects
│   └── use-cases/       # Business workflows
│       ├── apply-config.ts          # Safe config apply with rollback
│       ├── load-config.ts           # Load all NF configs
│       ├── validate-config.ts       # Cross-service validation
│       ├── sync-prometheus-config.ts # Regenerate prometheus.yml + live reload
│       ├── subscriber-mgmt.ts       # CRUD operations
│       ├── service-monitor.ts       # Service status polling
│       ├── backup-restore.ts        # Backup/restore workflows
│       ├── auto-config.ts           # Wizard-based setup
│       └── suci-mgmt.ts             # SUCI key management
│
├── infrastructure/      # External system integrations
│   ├── yaml/            # YAML file I/O with comment preservation
│   ├── mongodb/         # MongoDB connection and queries
│   ├── system/          # systemctl, bash command execution
│   ├── websocket/       # WebSocket message broadcasting
│   └── logging/         # Audit trail and structured logging
│
├── interfaces/          # HTTP/WebSocket entry points
│   └── rest/            # Express controllers
│       ├── config-controller.ts     # /api/config/*
│       ├── service-controller.ts    # /api/services/*
│       ├── subscriber-controller.ts # /api/subscribers/*
│       ├── backup-controller.ts     # /api/backup/*
│       ├── suci-controller.ts       # /api/suci/*
│       └── auto-config-controller.ts # /api/auto-config/*
│
├── config/              # Application configuration
│   └── defaults/        # Default YAML configs
│
└── index.ts             # Application entry point and DI setup
```

### Key Design Patterns

**1. Dependency Injection**
```typescript
// Use case receives dependencies via constructor
class ApplyConfigUseCase {
  constructor(
    private configRepo: IConfigRepository,
    private hostExecutor: IHostExecutor,
    private auditLogger: IAuditLogger
  ) {}
}

// DI container in index.ts
const configRepo = new YamlConfigRepository(hostExecutor, CONFIG_PATH);
const applyConfigUseCase = new ApplyConfigUseCase(configRepo, hostExecutor, auditLogger);
```

**2. Repository Pattern**
```typescript
// Interface defines contract
interface IConfigRepository {
  loadAll(): Promise<AllConfigs>;
  saveNrf(config: NrfConfig): Promise<void>;
  backupAll(path: string): Promise<void>;
}

// Implementation handles file I/O
class YamlConfigRepository implements IConfigRepository {
  async loadNrf(): Promise<NrfConfig> {
    const raw = await this.hostExecutor.readFile(`${this.configPath}/nrf.yaml`);
    return YAML.parse(raw);
  }
}
```

**3. Use Case Pattern**
```typescript
// Each use case encapsulates one business workflow
class ApplyConfigUseCase {
  async execute(newConfigs: AllConfigsDto): Promise<ApplyResult> {
    // 1. Validate
    // 2. Backup
    // 3. Write configs
    // 4. Restart services (ordered)
    // 5. Verify
    // 6. Rollback on failure
    // 7. Audit log
  }
}
```

**4. Mutex Locking (Concurrency Control)**
```typescript
// Prevent concurrent config applies
private readonly mutex = new Mutex();

async execute(configs: AllConfigsDto): Promise<ApplyResult> {
  return this.mutex.runExclusive(async () => {
    // Only one config apply at a time
  });
}
```

---

## Frontend Architecture

The frontend is a **single-page application (SPA)** built with React and functional programming principles.

### Component Structure

```
frontend/src/
├── components/          # React components
│   ├── common/          # Reusable UI components
│   │   ├── Layout.tsx              # Main app shell with nav
│   │   ├── Tooltip.tsx             # Tooltip component
│   │   └── FieldsWithTooltips.tsx  # Form field wrappers
│   │
│   ├── dashboard/       # Dashboard page
│   │   └── DashboardPage.tsx
│   │
│   ├── topology/        # Network topology
│   │   ├── TopologyPage.tsx        # JointJS diagram
│   │   └── TopologyPage.css        # Diagram styling
│   │
│   ├── services/        # Service management
│   │   └── ServicesPage.tsx
│   │
│   ├── config/          # Configuration management
│   │   ├── ConfigPage.tsx          # Main config UI
│   │   ├── DiffViewer.tsx          # YAML diff display
│   │   └── editors/                # NF-specific editors
│   │       ├── NrfEditor.tsx
│   │       ├── AmfEditor.tsx
│   │       ├── SmfEditor.tsx
│   │       └── ... (16 total)
│   │
│   ├── subscribers/     # Subscriber management
│   │   └── SubscriberPage.tsx      # CRUD UI + SIM Generator
│   │
│   ├── suci/            # SUCI key management
│   │   └── SuciManagementPage.tsx
│   │
│   ├── metrics/         # Prometheus metrics endpoints page
│   │   └── MetricsPage.tsx         # Dual-mode: endpoint table + scrape config YAML
│   │
│   ├── backup/          # Backup & restore
│   │   └── BackupPage.tsx
│   │
│   └── logs/            # Log streaming
│       └── LogsPage.tsx
│
├── stores/              # Zustand state management
│   ├── configStore.ts              # Config state
│   ├── serviceStore.ts             # Service status state
│   ├── subscriberStore.ts          # Subscriber state
│   ├── topologyStore.ts            # Topology state
│   └── suciStore.ts                # SUCI key state
│
├── api/                 # API client layer
│   ├── index.ts                    # Axios client + endpoints
│   └── types.ts                    # API response types
│
├── hooks/               # Custom React hooks
│   ├── useWebSocket.ts             # WebSocket connection
│   └── usePolling.ts               # Polling hook
│
├── types/               # TypeScript type definitions
│   ├── config.ts                   # All NF config types
│   ├── subscriber.ts               # Subscriber types
│   └── service.ts                  # Service status types
│
├── data/                # Static data
│   └── tooltips/                   # 150+ tooltip definitions
│       ├── index.ts
│       ├── nrf.ts
│       ├── amf.ts
│       └── ... (all NFs)
│
└── App.tsx              # Root component with routing
```

### State Management (Zustand)

Zustand provides lightweight, hook-based state management without boilerplate:

```typescript
// Define store with actions
export const useConfigStore = create<ConfigState>((set, get) => ({
  // State
  configs: null,
  loading: false,
  error: null,
  dirty: false,
  
  // Actions
  fetchConfigs: async () => {
    set({ loading: true });
    const configs = await configApi.getAll();
    set({ configs, loading: false, dirty: false });
  },
  
  updateConfigs: (configs) => set({ configs, dirty: true }),
  
  applyConfigs: async () => {
    const result = await configApi.apply(get().configs);
    set({ dirty: false });
    return result;
  },
}));

// Use in component
function ConfigPage() {
  const { configs, loading, fetchConfigs, updateConfigs } = useConfigStore();
  
  useEffect(() => {
    fetchConfigs();
  }, []);
  
  return <div>...</div>;
}
```

### Routing Structure

```typescript
// App.tsx routes
<Routes>
  <Route path="/" element={<DashboardPage />} />
  <Route path="/topology" element={<TopologyPage />} />
  <Route path="/services" element={<ServicesPage />} />
  <Route path="/config" element={<ConfigPage />} />
  <Route path="/subscribers" element={<SubscriberPage />} />
  <Route path="/suci" element={<SuciManagementPage />} />
  <Route path="/auto-config" element={<AutoConfigPage />} />
  <Route path="/backup" element={<BackupPage />} />
  <Route path="/logs" element={<LogsPage />} />
  <Route path="/audit" element={<AuditPage />} />
</Routes>
```

---

## Data Flow

### Configuration Apply Flow

```
User clicks "Apply"
     │
     ▼
Frontend: useConfigStore.applyConfigs()
     │
     ▼
API Call: POST /api/config/apply
     │
     ▼
Backend: ConfigController.apply()
     │
     ▼
ApplyConfigUseCase.execute()
     │
     ├─▶ Acquire mutex lock
     ├─▶ Validate configs (Zod schemas)
     ├─▶ Generate diff for audit
     ├─▶ Create timestamped backup
     ├─▶ Write new YAML files (rawYaml passthrough)
     ├─▶ Restart services (ordered: NRF → AMF → SMF → ...)
     ├─▶ Verify each service is active
     ├─▶ If any fails: Restore backup and restart
     ├─▶ Audit log the operation
     └─▶ Release mutex lock
     │
     ▼
Return result to frontend
     │
     ▼
Frontend: Show toast notification
```

### Real-Time Service Status Updates

```
Backend: ServiceMonitorUseCase starts polling (5s interval)
     │
     ▼
Poll systemd status for all 16 services
     │
     ▼
Broadcast via WebSocket: { type: 'service_status_update', payload: {...} }
     │
     ▼
Frontend: useWebSocket receives message
     │
     ▼
Update serviceStore state
     │
     ▼
React re-renders ServicesPage and TopologyPage
```

### Subscriber Creation Flow

```
User fills form and clicks "Create"
     │
     ▼
Frontend: useSubscriberStore.create()
     │
     ▼
API Call: POST /api/subscribers
     │
     ▼
Backend: SubscriberController.create()
     │
     ▼
SubscriberManagementUseCase.create()
     │
     ├─▶ Validate IMSI format (15 digits)
     ├─▶ Validate K/OPc keys (32 hex chars each)
     ├─▶ Insert into MongoDB subscribers collection
     ├─▶ Audit log the creation
     └─▶ Return created subscriber
     │
     ▼
Frontend: Refresh subscriber list, show toast
```

---

## Technology Stack

### Backend Stack

| Technology | Version | Purpose |
|------------|---------|---------|
| **Runtime** | | |
| Node.js | 20 LTS | JavaScript runtime |
| TypeScript | 5.3.3 | Type-safe language |
| **Web Framework** | | |
| Express | 4.18.2 | HTTP server and routing |
| ws | 8.16.0 | WebSocket server |
| helmet | 7.1.0 | Security headers |
| cors | 2.8.5 | CORS middleware |
| compression | 1.7.4 | Response compression |
| express-rate-limit | 7.1.5 | Rate limiting |
| **Data & Validation** | | |
| mongodb | 6.3.0 | Native MongoDB driver |
| zod | 3.22.4 | Schema validation |
| yaml | 2.3.4 | YAML parsing (preserves comments) |
| js-yaml | 4.1.0 | Alternative YAML parser |
| **Utilities** | | |
| async-mutex | 0.4.1 | Mutex locks |
| diff | 5.1.0 | Text diffing |
| pino | 8.17.2 | Structured logging |

### Frontend Stack

| Technology | Version | Purpose |
|------------|---------|---------|
| **UI Framework** | | |
| React | 18.2.0 | UI library |
| TypeScript | 5.3.3 | Type-safe language |
| Vite | 5.0.11 | Build tool and dev server |
| **Styling** | | |
| TailwindCSS | 3.4.1 | Utility-first CSS |
| Lucide React | 0.303.0 | Icon library |
| **State Management** | | |
| Zustand | 4.4.7 | Lightweight state management |
| **Routing & HTTP** | | |
| React Router | 6.21.1 | Client-side routing |
| Axios | 1.6.4 | HTTP client |
| **Visualization** | | |
| JointJS | 3.7.0 | Network topology diagrams |
| Recharts | 2.10.3 | Charts |
| Monaco Editor | 4.6.0 | YAML code editor |
| **UI Components** | | |
| react-hot-toast | 2.4.1 | Toast notifications |
| clsx | 2.1.0 | Conditional classnames |

### Infrastructure

| Technology | Purpose |
|------------|---------|
| Docker | Container runtime |
| Docker Compose | Multi-container orchestration |
| nginx | Reverse proxy, static server |
| MongoDB | Subscriber database |
| systemd | Service management |
| D-Bus | IPC for systemctl |

---

## Design Patterns

### 1. Clean Architecture

**Layers:**
- **Domain** - Pure business logic, no external dependencies
- **Application** - Use cases that orchestrate domain logic
- **Infrastructure** - Implementations of domain interfaces
- **Interface** - HTTP/WebSocket entry points

**Dependency Rule:** Inner layers never depend on outer layers.

### 2. Repository Pattern

Abstracts data access behind interfaces:
- `IConfigRepository` - Config file I/O
- `ISubscriberRepository` - MongoDB operations
- `IBackupRepository` - Backup storage

### 3. Use Case Pattern

Each use case represents one business workflow:
- `ApplyConfigUseCase` - Apply config with safety checks
- `LoadConfigUseCase` - Load all configs
- `CreateSubscriberUseCase` - Add new subscriber

### 4. Dependency Injection

Services receive dependencies via constructor:
```typescript
class ApplyConfigUseCase {
  constructor(
    private configRepo: IConfigRepository,
    private hostExecutor: IHostExecutor,
    private auditLogger: IAuditLogger
  ) {}
}
```

### 5. Factory Pattern

Used for creating complex objects:
- Config entity factories
- DTO mappers

### 6. Observer Pattern

WebSocket broadcasting for real-time updates:
```typescript
wsBroadcaster.broadcast({
  type: 'service_status_update',
  payload: { statuses }
});
```

### 7. Strategy Pattern

Different YAML parsers based on requirements:
- `yaml` library (preserves comments) for text editor
- `js-yaml` library (faster) for validation

---

## Security Architecture

### Current Security Model

All API routes require a valid session. Unauthenticated requests receive a `401` response and the browser is redirected to the login page.

**Security Layers:**
1. **Auth layer** — Lucia v3 session management, HttpOnly cookies, bcrypt password hashing
2. **Network-level** — Firewall rules, VPN access recommended for internet-exposed deployments
3. **Application-level** — Rate limiting on login, Zod input validation
4. **Container-level** — Privileged mode required (systemctl access)
5. **Data-level** — MongoDB localhost-only; auth data in separate SQLite database

### Auth Data Flow

```
POST /api/auth/login
  └── Rate limiter (10 req/15min per IP)
  └── Lookup user in auth.db (SQLite)
  └── bcrypt.verify() — runs even on missing user (timing-safe)
  └── Lucia.createSession() — stores session in auth.db
  └── Set-Cookie: nms_session (HttpOnly, SameSite=lax)

Every protected request
  └── authMiddleware reads session cookie
  └── Lucia.validateSession() — checks auth.db
  └── If valid: attach req.user, call next()
  └── If expired: clear cookie, return 401
  └── If missing: return 401
```

### Auth Database

The NMS maintains its own SQLite database (`auth.db`) completely separate from the Open5GS MongoDB instance:

```
auth.db
├── user table     (id, username, password_hash, role, created_at, last_login_at)
└── session table  (id, expires_at, user_id)
```

Persisted via Docker volume mount `./data:/app/data`.

### Security Measures

**Authentication & Sessions:**
- Lucia v3 session management with rolling expiry
- HttpOnly cookies (inaccessible to JavaScript)
- SameSite=lax (CSRF protection)
- Secure flag controlled by `COOKIE_SECURE` env var (must be `true` for HTTPS)
- bcrypt password hashing (cost factor 10)
- Timing-safe login (prevents user enumeration)
- Rate limiting on login endpoint (10 attempts/15min per IP)

**Input Validation:**
- Zod schema validation on all API inputs
- Type checking with TypeScript
- YAML schema validation

**HTTP Security:**
- Helmet middleware (security headers)
- CORS configuration
- Rate limiting (100 req/15min per IP on general routes)
- Request size limits

**Container Security:**
- Read-only mounts where possible
- Minimal container images (Debian Bookworm slim)
- No unnecessary services running

**Data Protection:**
- Automatic backups before changes
- Audit logging of all operations
- Rollback capability
- Auth data isolated from Open5GS data

### Security Limitations

**Single user only:**
- No multi-user management UI in v1.2
- No role-based access control (RBAC) — role field exists for future use

**No Encryption in Transit by Default:**
- HTTP only out of the box
- Set `COOKIE_SECURE=true` and configure nginx SSL for HTTPS deployments

**Privileged Container:**
- Backend requires elevated permissions
- Access to host systemd and D-Bus

### Production Security Recommendations

See **[docs/deployment.md](docs/deployment.md)** for:
- SSL/TLS termination at nginx (set `COOKIE_SECURE=true` in `.env` when active)
- VPN or firewall-based access control
- MongoDB authentication
- Regular security updates

---

## Deployment Architecture

### Docker Container Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Docker Host (Ubuntu 24.04)                              │
│                                                           │
│  ┌────────────────────────────────────────────────────┐ │
│  │  nginx Container (Alpine)                           │ │
│  │  network_mode: host                                 │ │
│  │  Port: 8888                                         │ │
│  └─────────────┬──────────────────────────────────────┘ │
│                │ proxies to localhost:3001/3002         │
│  ┌─────────────▼──────────────────────────────────────┐ │
│  │  Backend Container (Node.js 20)                     │ │
│  │  network_mode: host, privileged: true, pid: host   │ │
│  │  Ports: 3001 (REST), 3002 (WebSocket)              │ │
│  │  Volumes:                                            │ │
│  │    - /etc/open5gs → /etc/open5gs                   │ │
│  │    - /var/log/open5gs → /var/log/open5gs (ro)     │ │
│  │    - /run/systemd → /run/systemd (ro)             │ │
│  │    - /var/run/dbus → /var/run/dbus (ro)           │ │
│  │    - /usr/bin/systemctl → /usr/bin/systemctl (ro) │ │
│  └─────────────┬──────────────────────────────────────┘ │
│                │ connects to                             │
│  ┌─────────────▼──────────────────────────────────────┐ │
│  │  Host Services                                       │ │
│  │  - MongoDB (127.0.0.1:27017)                        │ │
│  │  - systemd (via D-Bus)                              │ │
│  │  - Open5GS services (16 NFs)                        │ │
│  └──────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### Monitoring Stack

- **Port 9099** — Prometheus (avoids conflict with Open5GS NFs on 9090)
- **Port 3000** — Grafana

**Prometheus Auto-Sync:** On every config apply, `SyncPrometheusConfigUseCase` reads the metrics address/port from all 7 NFs, writes a fresh `prometheus.yml` via direct `writeFile` (preserves inode for bind mount), then POSTs to `/-/reload`. The backend and Prometheus containers share the same `./monitoring` directory via bind mount.

### Network Architecture

**Host Network Mode:**
- All containers use `network_mode: host`
- Containers share host's network stack
- No NAT overhead
- Direct access to localhost services

**Port Allocation:**
- 8888 - nginx (frontend + API proxy)
- 3001 - Backend REST API (internal)
- 3002 - Backend WebSocket (internal)
- 9099 - Prometheus (configurable via `PROMETHEUS_PORT`)
- 3000 - Grafana (configurable via `GRAFANA_PORT`)
- 27017 - MongoDB (localhost only)

### Volume Mounts

**Backend Container:**
```yaml
volumes:
  # Open5GS config files (read/write)
  - /etc/open5gs:/etc/open5gs
  
  # Open5GS logs (read-only)
  - /var/log/open5gs:/var/log/open5gs:ro
  
  # systemd integration (read-only)
  - /run/systemd/system:/run/systemd/system:ro
  - /var/run/dbus/system_bus_socket:/var/run/dbus/system_bus_socket
  - /usr/bin/systemctl:/usr/bin/systemctl:ro
  - /lib/systemd:/lib/systemd:ro
  
  # Backups (read/write)
  - /etc/open5gs/backups:/etc/open5gs/backups
  
  # Audit logs (read/write)
  - ./logs:/var/log/open5gs-nms
```

### Build Strategy

**Multi-Stage Builds:**
```dockerfile
# Backend
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build

FROM node:20-alpine
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
CMD ["node", "dist/index.js"]

# Frontend
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
```

**Benefits:**
- Smaller final images
- No build tools in production
- Faster deployments

---

## Summary

The Open5GS NMS architecture prioritizes:
- **Clean separation of concerns** through layered architecture
- **Type safety** with full TypeScript implementation
- **Maintainability** via Clean Architecture patterns
- **Safety** with automatic backups and rollback
- **Real-time updates** via WebSocket integration
- **Production readiness** through Docker containerization

For deployment details, see **[docs/deployment.md](docs/deployment.md)**.  
For development setup, see **[docs/development.md](docs/development.md)**.
