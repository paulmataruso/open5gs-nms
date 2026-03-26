# Contributing to Open5GS NMS

Thank you for your interest in contributing to the Open5GS Network Management System! This document provides guidelines and instructions for contributing.

---

## Table of Contents

1. [Code of Conduct](#code-of-conduct)
2. [Getting Started](#getting-started)
3. [Development Setup](#development-setup)
4. [How to Contribute](#how-to-contribute)
5. [Pull Request Process](#pull-request-process)
6. [Coding Standards](#coding-standards)
7. [Testing Guidelines](#testing-guidelines)
8. [Documentation](#documentation)
9. [Community](#community)

---

## Code of Conduct

### Our Pledge

We are committed to providing a welcoming and inclusive environment for all contributors, regardless of experience level, gender identity, sexual orientation, disability, personal appearance, body size, race, ethnicity, age, religion, or nationality.

### Expected Behavior

- Be respectful and considerate
- Welcome newcomers and help them learn
- Focus on what is best for the community
- Show empathy towards other community members
- Accept constructive criticism gracefully

### Unacceptable Behavior

- Harassment, trolling, or discriminatory comments
- Personal attacks or insults
- Publishing others' private information
- Spam or self-promotion unrelated to the project
- Other conduct that could reasonably be considered inappropriate

### Enforcement

Instances of unacceptable behavior may be reported to the project maintainers. All complaints will be reviewed and investigated promptly and fairly.

---

## Getting Started

### Ways to Contribute

You don't need to be a developer to contribute! Here are many ways to help:

**🐛 Report Bugs**
- Found a bug? [Open an issue](https://github.com/YOUR_ORG/open5gs-nms/issues/new?template=bug_report.md)
- Provide detailed steps to reproduce
- Include screenshots if applicable
- Mention your environment (OS, Open5GS version, etc.)

**💡 Suggest Features**
- Have an idea? [Request a feature](https://github.com/YOUR_ORG/open5gs-nms/issues/new?template=feature_request.md)
- Explain the problem you're trying to solve
- Describe your proposed solution
- Consider implementation complexity

**📝 Improve Documentation**
- Fix typos or clarify instructions
- Add examples or use cases
- Improve API documentation
- Translate documentation

**💻 Write Code**
- Fix bugs from the issue tracker
- Implement new features
- Improve performance
- Refactor code for better maintainability

**🧪 Test Pre-Releases**
- Test beta versions and provide feedback
- Report compatibility issues
- Validate new features

---

## Development Setup

### Prerequisites

- **Node.js** 20 LTS or higher
- **npm** 10 or higher
- **Docker** and **Docker Compose** (for full stack testing)
- **Open5GS** 2.7+ installed on test system
- **MongoDB** 6.0+ running locally
- **Git** for version control

### Fork and Clone

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/open5gs-nms.git
   cd open5gs-nms
   ```
3. Add upstream remote:
   ```bash
   git remote add upstream https://github.com/YOUR_ORG/open5gs-nms.git
   ```

### Backend Development

```bash
cd backend

# Install dependencies
npm install

# Run in development mode with hot reload
npm run dev

# Backend runs on http://localhost:3001
```

### Frontend Development

```bash
cd frontend

# Install dependencies
npm install

# Run development server with hot reload
npm run dev

# Frontend runs on http://localhost:5173
```

### Full Stack with Docker

```bash
# Build and start all services
docker compose up --build

# Access at http://localhost:8888
```

### Environment Variables

Create `.env` files for local development:

**backend/.env**
```bash
NODE_ENV=development
PORT=3001
WS_PORT=3002
MONGODB_URI=mongodb://127.0.0.1:27017/open5gs
CONFIG_PATH=/etc/open5gs
LOG_LEVEL=debug
```

**frontend/.env**
```bash
VITE_API_URL=http://localhost:3001
VITE_WS_URL=ws://localhost:3002
```

---

## How to Contribute

### Finding Issues to Work On

- Look for issues labeled `good first issue` for beginner-friendly tasks
- Issues labeled `help wanted` need contributors
- Check the [project board](https://github.com/YOUR_ORG/open5gs-nms/projects) for planned work

### Before Starting Work

1. **Check if issue exists** - Search existing issues first
2. **Comment on the issue** - Let others know you're working on it
3. **Wait for approval** - For major changes, discuss with maintainers first
4. **Create a branch** - Work on a feature branch, not main

### Branch Naming Convention

Use descriptive branch names:
```bash
feature/add-sbi-validation
fix/amf-restart-timeout
docs/improve-installation-guide
refactor/clean-config-repository
```

---

## Pull Request Process

### Before Submitting

- [ ] Code follows the project's coding standards
- [ ] All tests pass locally
- [ ] Documentation is updated (if applicable)
- [ ] Commit messages are clear and descriptive
- [ ] Branch is up to date with upstream main

### Creating a Pull Request

1. **Push your branch** to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```

2. **Open a Pull Request** on GitHub:
   - Use a clear, descriptive title
   - Reference related issues (e.g., "Fixes #123")
   - Describe what changed and why
   - Add screenshots for UI changes
   - List any breaking changes

3. **Fill out the PR template** completely

### PR Review Process

- Maintainers will review your PR within a few days
- Address any requested changes
- Keep the conversation respectful and constructive
- Once approved, maintainers will merge your PR

### After Your PR is Merged

- Delete your feature branch
- Update your local main branch:
  ```bash
  git checkout main
  git pull upstream main
  git push origin main
  ```

---

## Coding Standards

### TypeScript

- Use **TypeScript** for all new code
- Enable strict mode
- Avoid `any` types - use proper typing
- Use interfaces over types for object shapes
- Document complex types with JSDoc comments

**Example:**
```typescript
// Good
interface SubscriberCreateDto {
  imsi: string;
  k: string;
  opc: string;
  ambr?: AmbrConfig;
}

// Avoid
function createSubscriber(data: any) { ... }
```

### Code Style

- Use **ESLint** and **Prettier** for formatting
- Run linter before committing:
  ```bash
  npm run lint
  npm run lint:fix
  ```

**Formatting:**
- 2 spaces for indentation
- Single quotes for strings
- Semicolons required
- Trailing commas in multiline structures

### Backend Patterns

**Clean Architecture:**
- Keep domain layer pure (no external dependencies)
- Use interfaces for external integrations
- Inject dependencies via constructor

**Example:**
```typescript
// Domain interface
interface IConfigRepository {
  loadNrf(): Promise<NrfConfig>;
  saveNrf(config: NrfConfig): Promise<void>;
}

// Use case with dependency injection
class ApplyConfigUseCase {
  constructor(
    private configRepo: IConfigRepository,
    private auditLogger: IAuditLogger
  ) {}
  
  async execute(config: NrfConfig): Promise<void> {
    await this.configRepo.saveNrf(config);
    await this.auditLogger.log('config_applied');
  }
}
```

**Error Handling:**
```typescript
// Good - specific error types
try {
  await configRepo.saveNrf(config);
} catch (error) {
  if (error instanceof FileNotFoundError) {
    // Handle file not found
  } else if (error instanceof ValidationError) {
    // Handle validation error
  } else {
    throw error; // Re-throw unknown errors
  }
}
```

### Frontend Patterns

**Functional Components:**
- Use functional components with hooks
- Avoid class components

**State Management:**
- Use Zustand stores for global state
- Use local state (useState) for component-specific state
- Avoid prop drilling - use stores instead

**Example:**
```typescript
// Zustand store
export const useConfigStore = create<ConfigState>((set) => ({
  configs: null,
  loading: false,
  
  fetchConfigs: async () => {
    set({ loading: true });
    const configs = await configApi.getAll();
    set({ configs, loading: false });
  },
}));

// Component
function ConfigPage() {
  const { configs, loading, fetchConfigs } = useConfigStore();
  
  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);
  
  if (loading) return <LoadingSpinner />;
  return <ConfigEditor configs={configs} />;
}
```

**Component Structure:**
```typescript
// 1. Imports
import { useState, useEffect } from 'react';

// 2. Types/Interfaces
interface Props {
  serviceId: string;
}

// 3. Component
export function ServiceCard({ serviceId }: Props) {
  // 4. Hooks
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  
  // 5. Effects
  useEffect(() => {
    fetchStatus();
  }, [serviceId]);
  
  // 6. Handlers
  const handleRestart = async () => {
    await serviceApi.restart(serviceId);
  };
  
  // 7. Render
  return (
    <div>...</div>
  );
}
```

### Naming Conventions

**Variables and Functions:**
- camelCase for variables and functions
- Descriptive names that explain purpose
- Avoid abbreviations unless universally understood

```typescript
// Good
const subscriberCount = 10;
function calculateAmbr(value: number, unit: AmbrUnit) { ... }

// Avoid
const subCnt = 10;
function calc(v: number, u: AmbrUnit) { ... }
```

**Components:**
- PascalCase for React components
- Use descriptive names

```typescript
// Good
function SubscriberList() { ... }
function ConfigEditor() { ... }

// Avoid
function List() { ... }
function Editor() { ... }
```

**Files:**
- kebab-case for directories
- PascalCase for React component files
- camelCase for utility/service files

```
components/
  SubscriberList.tsx
  ConfigEditor.tsx
utils/
  formatImsi.ts
  validateYaml.ts
```

---

## Testing Guidelines

### Writing Tests

**Unit Tests:**
- Test individual functions and classes
- Mock external dependencies
- Use descriptive test names

```typescript
describe('validateImsi', () => {
  it('should accept valid 15-digit IMSI', () => {
    expect(validateImsi('001010000000001')).toBe(true);
  });
  
  it('should reject IMSI with less than 15 digits', () => {
    expect(validateImsi('00101000')).toBe(false);
  });
  
  it('should reject IMSI with non-numeric characters', () => {
    expect(validateImsi('00101000000000A')).toBe(false);
  });
});
```

**Integration Tests:**
- Test interactions between components
- Use test database for MongoDB tests
- Clean up after tests

**Running Tests:**
```bash
# Backend
cd backend
npm test
npm run test:watch
npm run test:coverage

# Frontend
cd frontend
npm test
```

### Test Coverage

- Aim for >80% coverage on critical paths
- Focus on business logic and edge cases
- Don't test implementation details

---

## Documentation

### Code Documentation

**JSDoc Comments:**
```typescript
/**
 * Applies new configuration to Open5GS network functions.
 * Creates automatic backup before applying and rolls back on failure.
 * 
 * @param configs - Complete configuration for all 16 network functions
 * @returns Result object with success status, diff, and any errors
 * @throws {ValidationError} If configuration validation fails
 */
async function applyConfigs(configs: AllConfigs): Promise<ApplyResult> {
  // Implementation
}
```

**README Updates:**
- Update README.md for new features
- Add examples for new APIs
- Update screenshots if UI changed

**API Documentation:**
- Document all REST endpoints
- Include request/response examples
- Note breaking changes

---

## Community

### Getting Help

- **GitHub Discussions** - Ask questions, share ideas
- **GitHub Issues** - Report bugs, request features
- **Documentation** - Check docs/ directory first

### Staying Updated

- Watch the repository for updates
- Star the project to show support
- Follow release notes for new versions

### Recognition

Contributors will be recognized in:
- CHANGELOG.md for each release
- GitHub Contributors page
- Special mentions for significant contributions

---

## Thank You!

Your contributions make this project better for everyone. Whether you're fixing a typo, reporting a bug, or implementing a major feature, every contribution is valuable and appreciated.

**Happy coding!** 🎉
