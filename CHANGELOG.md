# Open5GS NMS v1.0 - Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-03-23

### Added - Initial Public Release

#### Core Features
- **Complete Network Function Management** - Configure all 16 Open5GS network functions (5G Core + 4G EPC)
  - 5G Core: NRF, SCP, AMF, SMF, UPF, AUSF, UDM, UDR, PCF, NSSF, BSF
  - 4G EPC: MME, HSS, PCRF, SGW-C, SGW-U

- **Visual Network Topology** - Interactive JointJS-based topology visualization
  - Real-time service status indicators
  - Manual waypoint routing for professional diagrams
  - Interface status display (S1-MME, S1-U)
  - Active UE session monitoring

- **Configuration Management**
  - Dual editor modes: Form-based with tooltips + Monaco YAML editor
  - Real-time validation with Zod schemas
  - Cross-service dependency checking
  - Safe apply workflow with automatic backups
  - Ordered service restart respecting dependencies
  - Automatic rollback on failure

- **Subscriber Management**
  - Full CRUD operations via MongoDB
  - SIM Generator with country-based MCC selection (65+ countries)
  - Auto-provision generated SIMs to database
  - Sequential and random IMSI generation
  - Pagination and search functionality

- **SUCI/5G Privacy Key Management**
  - Generate home network public/private keypairs
  - Support for Profile A (X25519) and Profile B (secp256r1)
  - Public key display and export for eSIM provisioning
  - Automatic UDM configuration updates

- **Service Management**
  - Real-time systemd service monitoring via WebSocket
  - Start/stop/restart individual services
  - Bulk operations (start all, stop all, restart all)
  - Service health indicators and dependency awareness

- **Real-Time Monitoring**
  - Live service logs via WebSocket streaming
  - Per-service log filtering
  - Real-time service status updates
  - Active UE sessions with IP-to-IMSI correlation

- **Auto-Configuration Wizard**
  - One-click network setup for 4G and 5G
  - Preview YAML changes before applying
  - Optional NAT configuration with iptables
  - Smart defaults from current Open5GS configuration

- **Backup & Restore**
  - Automatic timestamped backups before every change
  - Configuration file backups (all 16 YAML files)
  - MongoDB subscriber database backups
  - Selective restore with diff preview
  - Restore to factory defaults

- **Comprehensive Tooltip System**
  - 150+ tooltips covering all configuration fields
  - Contextual help for every input field
  - Technical documentation integrated into UI

- **Audit Logging**
  - Complete audit trail of all system actions
  - Configuration changes logged with diffs
  - Service management actions tracked
  - Subscriber modifications logged
  - File-based JSON logging

#### Architecture & Technology

**Frontend:**
- React 18.2 with TypeScript 5.3
- Vite 5.0 build tooling
- TailwindCSS 3.4 for styling
- Zustand 4.4 for state management
- JointJS 3.7 for topology visualization
- Monaco Editor 4.6 for YAML editing
- Axios for HTTP client

**Backend:**
- Node.js 20 LTS with TypeScript 5.3
- Express 4.18 REST API
- Clean Architecture pattern (Domain → Application → Infrastructure → Interface)
- Zod 3.22 for runtime validation
- MongoDB Native Driver 6.3
- WebSocket (ws) 8.16 for real-time updates
- Pino 8.17 for structured logging
- async-mutex for safe concurrent operations

**Infrastructure:**
- Docker multi-stage builds
- Docker Compose orchestration
- nginx reverse proxy
- Host network mode for systemd integration
- Privileged container for service management

### Fixed
- Number type conversion for MCC/MNC fields
- Service status check retry logic (5 attempts for MME)
- YAML comment preservation in text editor
- Cross-service validation improvements
- DNS resolution issues in Docker builds

### Security
- Helmet middleware for HTTP security headers
- CORS configuration
- Rate limiting (100 req/15min per IP)
- Input validation with Zod schemas
- Mutex-locked configuration applies
- Automatic rollback on failures

---

## Release Information

**Tested Platform:** Ubuntu 24.04 LTS  
**Supported Open5GS Version:** 2.7.0+  
**License:** MIT  
**Docker Required:** Engine 24.0+, Compose v2.20+

---

## Upgrade Notes

This is the initial public release. Future upgrade instructions will be provided here.

---

## Known Limitations

- No built-in authentication/authorization (local deployment only)
- No HTTPS/WSS (nginx SSL termination recommended)
- Single-host deployment only
- js-yaml strips YAML comments on write operations
- Requires privileged Docker container for systemctl access

---

## Future Roadmap

See [GitHub Issues](https://github.com/YOUR_ORG/open5gs-nms/issues) for planned features and enhancements.

**High Priority:**
- JWT/OAuth2 authentication
- HTTPS/WSS support
- Multi-user support with roles
- Enhanced backup scheduling

**Medium Priority:**
- Prometheus metrics integration
- Email/Slack notifications
- Git-based configuration versioning
- Multi-host deployment support

---

[1.0.0]: https://github.com/YOUR_ORG/open5gs-nms/releases/tag/v1.0.0
