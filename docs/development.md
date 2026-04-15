# Development Guide

Guide for developers contributing to or extending Open5GS NMS.

---

## Table of Contents

1. [Development Environment Setup](#development-environment-setup)
2. [Project Structure](#project-structure)
3. [Development Workflow](#development-workflow)
4. [Coding Guidelines](#coding-guidelines)
5. [Testing](#testing)
6. [Debugging](#debugging)
7. [Building and Deployment](#building-and-deployment)
8. [Common Development Tasks](#common-development-tasks)

---

## Development Environment Setup

### Prerequisites

- **Node.js** 20 LTS or higher
- **npm** 10 or higher
- **Docker** and **Docker Compose** (optional, for full-stack testing)
- **Open5GS** 2.7+ (for integration testing)
- **MongoDB** 6.0+ (for backend development)
- **Git** for version control
- **VS Code** or your preferred IDE

### Initial Setup

```bash
# Clone the repository
git clone https://github.com/YOUR_ORG/open5gs-nms.git
cd open5gs-nms

# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install
```

### Backend Development

```bash
cd backend

# Copy environment template
cp .env.example .env

# Edit .env for local development
nano .env
```

**backend/.env:**
```bash
NODE_ENV=development
PORT=3001
WS_PORT=3002
MONGODB_URI=mongodb://127.0.0.1:27017/open5gs
CONFIG_PATH=/etc/open5gs
LOG_LEVEL=debug
HOST_SYSTEMCTL_PATH=/usr/bin/systemctl
```

Start development server:
```bash
npm run dev
# Server runs on http://localhost:3001 with hot reload
```

### Frontend Development

```bash
cd frontend

# Copy environment template
cp .env.example .env

# Edit .env for local development
nano .env
```

**frontend/.env:**
```bash
VITE_API_URL=http://localhost:3001
VITE_WS_URL=ws://localhost:3002
```

Start development server:
```bash
npm run dev
# Server runs on http://localhost:5173 with hot reload
```

### IDE Setup (VS Code)

Recommended extensions:
- **ESLint** - JavaScript linting
- **Prettier** - Code formatting
- **TypeScript and JavaScript Language Features** - Built-in
- **Tailwind CSS IntelliSense** - TailwindCSS autocomplete
- **Docker** - Docker file support

**settings.json:**
```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  },
  "typescript.tsdk": "node_modules/typescript/lib"
}
```

---

## Project Structure

### Backend Structure

```
backend/
├── src/
│   ├── domain/              # Business logic (no external dependencies)
│   │   ├── entities/        # Core entities (NF configs, Subscriber, etc.)
│   │   ├── interfaces/      # Abstract contracts
│   │   ├── services/        # Domain services (validation, topology)
│   │   └── value-objects/   # Immutable value types
│   │
│   ├── application/         # Use case orchestration
│   │   ├── dto/             # Data transfer objects
│   │   └── use-cases/       # Business workflows
│   │
│   ├── infrastructure/      # External integrations
│   │   ├── yaml/            # YAML file I/O
│   │   ├── mongodb/         # MongoDB client
│   │   ├── system/          # systemctl executor
│   │   ├── websocket/       # WebSocket broadcaster
│   │   └── logging/         # Audit logger
│   │
│   ├── interfaces/          # HTTP/WebSocket entry points
│   │   └── rest/            # Express controllers
│   │
│   ├── config/              # App configuration
│   └── index.ts             # Entry point
│
├── package.json
├── tsconfig.json
├── Dockerfile
└── .eslintrc.json
```

### Frontend Structure

```
frontend/
├── src/
│   ├── components/          # React components
│   │   ├── common/          # Reusable components
│   │   ├── dashboard/       # Dashboard page
│   │   ├── topology/        # Topology visualization
│   │   ├── services/        # Service management
│   │   ├── config/          # Configuration editors
│   │   ├── subscribers/     # Subscriber management
│   │   ├── suci/            # SUCI key management
│   │   ├── backup/          # Backup & restore
│   │   └── logs/            # Log streaming
│   │
│   ├── stores/              # Zustand state management
│   ├── api/                 # API client functions
│   ├── hooks/               # Custom React hooks
│   ├── types/               # TypeScript types
│   ├── data/                # Static data (tooltips)
│   └── App.tsx              # Root component
│
├── package.json
├── vite.config.ts
├── tailwind.config.js
├── tsconfig.json
└── Dockerfile
```

---

## Development Workflow

### Branch Strategy

```bash
# Create feature branch
git checkout -b feature/your-feature-name

# Make changes
# Commit regularly with clear messages

# Push to your fork
git push origin feature/your-feature-name

# Open pull request on GitHub
```

### Commit Message Convention

Use clear, descriptive commit messages:

```
feat: add SUCI key generation feature
fix: resolve AMF config validation error
docs: update installation guide
refactor: clean up config repository
test: add unit tests for subscriber validation
chore: update dependencies
```

### Code Review Process

1. Create pull request with description
2. Ensure CI checks pass
3. Request review from maintainers
4. Address feedback
5. Squash commits if requested
6. Merge when approved

---

## Coding Guidelines

### TypeScript Best Practices

**Use explicit types:**
```typescript
// Good
interface SubscriberDto {
  imsi: string;
  k: string;
  opc: string;
}

function createSubscriber(data: SubscriberDto): Promise<Subscriber> {
  // ...
}

// Avoid
function createSubscriber(data: any): Promise<any> {
  // ...
}
```

**Use interfaces for objects:**
```typescript
// Good
interface AmfConfig {
  sbi: SbiConfig;
  ngap: NgapConfig;
}

// Less preferred for object shapes
type AmfConfig = {
  sbi: SbiConfig;
  ngap: NgapConfig;
}
```

**Avoid `any` type:**
```typescript
// Instead of:
const data: any = await fetch();

// Use:
const data: unknown = await fetch();
// Then validate/narrow the type
```

### Backend Patterns

**Dependency Injection:**
```typescript
// Use case receives dependencies
export class ApplyConfigUseCase {
  constructor(
    private readonly configRepo: IConfigRepository,
    private readonly hostExecutor: IHostExecutor,
    private readonly auditLogger: IAuditLogger
  ) {}
  
  async execute(configs: AllConfigs): Promise<ApplyResult> {
    // Implementation
  }
}
```

**Error Handling:**
```typescript
// Create custom error types
export class ConfigValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string
  ) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

// Use in use cases
async execute(config: NrfConfig): Promise<void> {
  if (!this.isValidIp(config.sbi.addr)) {
    throw new ConfigValidationError('sbi.addr', 'Invalid IP address');
  }
}
```

**Async/Await:**
```typescript
// Good - proper error handling
async function loadConfig(): Promise<NrfConfig> {
  try {
    const raw = await this.hostExecutor.readFile('/etc/open5gs/nrf.yaml');
    return YAML.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new ConfigNotFoundError('nrf.yaml');
    }
    throw error;
  }
}
```

### Frontend Patterns

**Functional Components:**
```typescript
// Use functional components with hooks
export function ConfigEditor({ serviceId }: ConfigEditorProps) {
  const [config, setConfig] = useState<NrfConfig | null>(null);
  
  useEffect(() => {
    loadConfig();
  }, [serviceId]);
  
  return <div>...</div>;
}
```

**Custom Hooks:**
```typescript
// Extract reusable logic into hooks
export function useServiceStatus(serviceId: string) {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    const fetchStatus = async () => {
      const data = await serviceApi.getStatus(serviceId);
      setStatus(data);
      setLoading(false);
    };
    
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [serviceId]);
  
  return { status, loading };
}
```

**Zustand Stores:**
```typescript
// Keep stores simple and focused
export const useConfigStore = create<ConfigState>((set, get) => ({
  configs: null,
  loading: false,
  
  fetchConfigs: async () => {
    set({ loading: true });
    const configs = await configApi.getAll();
    set({ configs, loading: false });
  },
  
  updateConfig: (serviceName: string, config: any) => {
    const configs = get().configs;
    if (!configs) return;
    
    set({
      configs: {
        ...configs,
        [serviceName]: config
      }
    });
  }
}));
```

---

## Testing

### Running Tests

```bash
# Backend tests
cd backend
npm test                 # Run all tests
npm run test:watch      # Watch mode
npm run test:coverage   # With coverage

# Frontend tests
cd frontend
npm test                # Run all tests
npm run test:watch     # Watch mode
```

### Writing Tests

**Backend Unit Test Example:**
```typescript
// backend/src/domain/services/__tests__/validator.test.ts
import { ConfigValidator } from '../validator';

describe('ConfigValidator', () => {
  let validator: ConfigValidator;
  
  beforeEach(() => {
    validator = new ConfigValidator();
  });
  
  describe('validateIpAddress', () => {
    it('should accept valid IPv4 address', () => {
      expect(validator.validateIpAddress('192.168.1.1')).toBe(true);
    });
    
    it('should reject invalid IPv4 address', () => {
      expect(validator.validateIpAddress('999.999.999.999')).toBe(false);
    });
    
    it('should accept valid IPv6 address', () => {
      expect(validator.validateIpAddress('2001:db8::1')).toBe(true);
    });
  });
});
```

**Frontend Component Test Example:**
```typescript
// frontend/src/components/__tests__/ServiceCard.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { ServiceCard } from '../ServiceCard';

describe('ServiceCard', () => {
  it('renders service name and status', () => {
    render(<ServiceCard name="nrf" status="active" />);
    
    expect(screen.getByText('NRF')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });
  
  it('calls onRestart when restart button clicked', () => {
    const onRestart = jest.fn();
    render(<ServiceCard name="nrf" status="active" onRestart={onRestart} />);
    
    fireEvent.click(screen.getByText('Restart'));
    expect(onRestart).toHaveBeenCalledWith('nrf');
  });
});
```

---

## Debugging

### Backend Debugging

**VS Code launch.json:**
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Backend",
      "runtimeExecutable": "npm",
      "runtimeArgs": ["run", "dev"],
      "cwd": "${workspaceFolder}/backend",
      "console": "integratedTerminal"
    }
  ]
}
```

**Logging:**
```typescript
// Use pino logger
import { logger } from './infrastructure/logging';

logger.debug('Loading config for service: %s', serviceName);
logger.info('Config applied successfully');
logger.warn('Service restart took longer than expected');
logger.error({ err }, 'Failed to save config');
```

### Frontend Debugging

**Browser DevTools:**
- **Console** - Log errors and debug info
- **Network** - Monitor API calls
- **React DevTools** - Inspect component state
- **Redux DevTools** - Inspect Zustand stores (with middleware)

**Debug logging:**
```typescript
// Add debug logs
console.log('Fetching configs...');
console.log('Response:', response);

// Use React DevTools to inspect state
// Install: https://react.dev/learn/react-developer-tools
```

---

## Building and Deployment

### Development Build

```bash
# Backend
cd backend
npm run build
# Output: dist/

# Frontend
cd frontend
npm run build
# Output: dist/
```

### Docker Build

```bash
# Build all services
docker compose build

# Build specific service
docker compose build backend
docker compose build frontend

# Build without cache
docker compose build --no-cache
```

### Production Build

```bash
# Set production environment
export NODE_ENV=production

# Build optimized images
docker compose -f docker-compose.yml -f docker-compose.prod.yml build

# Start production stack
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

---

## Common Development Tasks

### Adding a New NF Configuration Editor

1. **Create entity type** in `backend/src/domain/entities/`
2. **Add repository methods** in `backend/src/domain/interfaces/config-repository.ts`
3. **Implement in YamlConfigRepository** in `backend/src/infrastructure/yaml/`
4. **Add to AllConfigs type**
5. **Create frontend editor** in `frontend/src/components/config/editors/`
6. **Add tooltips** in `frontend/src/data/tooltips/`
7. **Add to ConfigPage** navigation

### Adding a New API Endpoint

**Backend:**
```typescript
// 1. Create use case in backend/src/application/use-cases/
export class MyNewUseCase {
  async execute(params: MyParams): Promise<MyResult> {
    // Implementation
  }
}

// 2. Add controller in backend/src/interfaces/rest/
router.post('/my-endpoint', async (req, res) => {
  const result = await myNewUseCase.execute(req.body);
  res.json({ success: true, result });
});
```

**Frontend:**
```typescript
// 3. Add API client in frontend/src/api/index.ts
export const myApi = {
  myNewEndpoint: (params: MyParams) =>
    client.post('/my-endpoint', params).then(r => r.data.result)
};

// 4. Use in component
const result = await myApi.myNewEndpoint(params);
```

### Adding a New Zustand Store

```typescript
// frontend/src/stores/myStore.ts
import { create } from 'zustand';

interface MyState {
  data: MyData | null;
  loading: boolean;
  
  fetchData: () => Promise<void>;
  updateData: (data: MyData) => void;
}

export const useMyStore = create<MyState>((set) => ({
  data: null,
  loading: false,
  
  fetchData: async () => {
    set({ loading: true });
    const data = await myApi.getData();
    set({ data, loading: false });
  },
  
  updateData: (data) => set({ data })
}));
```

### Adding Tooltips

```typescript
// 1. Create tooltip definitions in frontend/src/data/tooltips/
export const MY_TOOLTIPS = {
  field_name: {
    title: 'Field Name',
    content: 'Description of what this field does...'
  }
};

// 2. Use in component
import { MY_TOOLTIPS } from '../../data/tooltips';
import { FieldWithTooltip } from '../common/FieldsWithTooltips';

<FieldWithTooltip
  label="Field Name"
  value={value}
  onChange={handleChange}
  tooltip={MY_TOOLTIPS.field_name}
/>
```

### Debugging Docker Log Streaming

**Testing Docker Integration:**
```bash
# From host - verify containers are running
docker compose ps

# From backend container - verify docker access
docker exec open5gs-nms-backend docker ps

# Test docker logs command
docker exec open5gs-nms-backend docker logs --tail 10 open5gs-nms-nginx

# Check backend logs for Docker executor
docker compose logs backend | grep -i docker
```

**Testing in UI:**
1. Open Logs page
2. Click "Docker Containers" button
3. Check browser console for container list API call
4. Select a container and verify WebSocket messages:
```javascript
// Browser console should show:
{
  type: 'log_entry',
  source: 'docker',
  log: { timestamp, service, message }
}
```

### Running Full Stack Locally

```bash
# Terminal 1: Backend
cd backend
npm run dev

# Terminal 2: Frontend
cd frontend
npm run dev

# Terminal 3: MongoDB (if not running as service)
mongod --dbpath /data/db

# Access UI at http://localhost:5173
# API at http://localhost:3001
```

---

## Additional Resources

### Documentation
- **TypeScript:** https://www.typescriptlang.org/docs/
- **React:** https://react.dev/
- **Express:** https://expressjs.com/
- **Zustand:** https://docs.pmnd.rs/zustand/
- **TailwindCSS:** https://tailwindcss.com/docs
- **JointJS:** https://resources.jointjs.com/docs/jointjs

### Tools
- **Postman:** API testing
- **MongoDB Compass:** Database GUI
- **Docker Desktop:** Container management
- **VS Code:** IDE with extensions

### Getting Help
- **GitHub Issues:** Report bugs or ask questions
- **GitHub Discussions:** Community discussion
- **Documentation:** Check docs/ directory
- **Code Comments:** Read inline documentation

---

**Happy coding!** If you have questions, open an issue or discussion on GitHub.
