# System Requirements

Detailed system requirements for deploying and running the Open5GS Network Management System.

---

## Table of Contents

1. [Hardware Requirements](#hardware-requirements)
2. [Software Requirements](#software-requirements)
3. [Network Requirements](#network-requirements)
4. [Open5GS Requirements](#open5gs-requirements)
5. [Browser Requirements](#browser-requirements)
6. [Storage Requirements](#storage-requirements)

---

## Hardware Requirements

### Minimum Configuration

Suitable for testing and small deployments (1-10 subscribers):

| Component | Specification |
|-----------|---------------|
| **CPU** | 2 cores (x86_64) |
| **RAM** | 4GB |
| **Disk** | 20GB free space |
| **Network** | 100 Mbps Ethernet |

### Recommended Configuration

For production deployments (10-100 subscribers):

| Component | Specification |
|-----------|---------------|
| **CPU** | 4+ cores (x86_64) |
| **RAM** | 8GB+ |
| **Disk** | 50GB+ free space (SSD recommended) |
| **Network** | 1 Gbps Ethernet |

### Enterprise Configuration

For large-scale deployments (100+ subscribers):

| Component | Specification |
|-----------|---------------|
| **CPU** | 8+ cores (x86_64) |
| **RAM** | 16GB+ |
| **Disk** | 100GB+ free space (SSD required) |
| **Network** | 1 Gbps+ Ethernet |

### Notes on Hardware

**CPU:**
- x86_64 architecture required (ARM64 not currently supported)
- More cores improve concurrent service restart performance
- Intel or AMD processors both work well

**RAM:**
- 2GB for NMS containers (frontend + backend + nginx)
- 2GB+ for Open5GS services (scales with number of active UEs)
- Additional memory needed for MongoDB and system overhead

**Disk:**
- SSD strongly recommended for production (faster config writes, log access)
- Space needed for:
  - Docker images (~2GB)
  - Configuration backups (~10MB per backup, grows over time)
  - MongoDB backups (~size of subscriber database)
  - System logs (~1-5GB depending on verbosity)

---

## Software Requirements

### Operating System

**Tested and Supported:**
- **Ubuntu 24.04 LTS** ✅ (Primary development platform)
- **Ubuntu 22.04 LTS** ✅ (Fully supported)
- **Ubuntu 20.04 LTS** ⚠️ (May require Docker updates)

**Likely Compatible:**
- Debian 12 (Bookworm)
- Debian 11 (Bullseye)
- Other systemd-based Linux distributions

**Not Supported:**
- Windows (WSL2 might work but untested)
- macOS (Docker Desktop not compatible with host networking)
- Non-systemd Linux distributions

### Required Software

| Software | Minimum Version | Purpose |
|----------|-----------------|---------|
| **Docker Engine** | 24.0+ | Container runtime |
| **Docker Compose** | v2.20+ | Multi-container orchestration |
| **Open5GS** | 2.7.0+ | 5G/4G core network |
| **MongoDB** | 4.4+ | Subscriber database |
| **systemd** | 245+ | Service management |
| **bash** | 4.0+ | Shell scripts |
| **iptables** | 1.8+ | NAT configuration (optional) |
| **chrony** | any | NTP daemon managed by the Time Server page |
| **frr** / **frr-pythontools** | 8.4.x (apt) | L3 Routing (EIGRP/OSPF/BGP) — see note below on upgrading to a from-source build |

> **FRR note:** the Ubuntu `frr` apt package (8.4.4) has known long-standing `eigrpd` assertion-crash bugs ([#943](https://github.com/FRRouting/frr/issues/943), [#3701](https://github.com/FRRouting/frr/issues/3701)) that can cause intermittent route flaps and radio (S1AP/N2) disconnects under EIGRP. The L3 Routing page's **Reinstall (Source)** tab migrates to a from-source FRR build (10.6.1+) and automatically installs its own build toolchain (`git build-essential libtool automake autoconf pkg-config bison flex libreadline-dev libjson-c-dev libc-ares-dev python3-dev python3-sphinx libsnmp-dev libcap-dev libelf-dev libunwind-dev protobuf-c-compiler libprotobuf-c-dev cmake` plus a from-source `libyang` build) — you don't need to install these yourself, just make sure `/opt` has at least ~3GB free before starting a build.

### Optional Module Software

Each of these is installed on-demand from its own page in the NMS UI (an "Install" button that streams `apt-get install` output live) — none of it is required for a base deployment, only if you enable that specific module.

| Module | Packages Installed | Notes |
|--------|--------------------|-------|
| **IMS / VoLTE** | `kamailio kamailio-ims-modules kamailio-mysql-modules kamailio-tls-modules kamailio-extra-modules kamailio-utils-modules rtpengine mariadb-server bind9 bind9utils mariadb-client dnsutils git dpkg-dev libxml2-dev redis-server python3-pip python3-venv python3-dev` | The Diameter HSS is [PyHSS](https://github.com/nickvsnetworking/pyhss) — **installed automatically by the NMS** (cloned from GitHub, Python deps installed via pip), no separate manual install or JRE/JDK needed. |
| **SMS over SGs** | `osmo-stp osmo-hlr osmo-msc sqlite3` | Connects to the MME's SGs interface; OsmoHLR's subscriber DB lives at `/var/lib/osmocom/hlr.db` on the host. |
| **Syslog Forwarding** | `rsyslog` | Also modifies (never destructively) the host's AppArmor local-override file and adds the `syslog` system user to the `frr` group, both required for rsyslog to read logs outside `/var/log` and to read `frr.log` — both changes are additive and reversible. |
| **UE Validation** | Docker images only (no host packages) — `free5gc/ueransim:latest` pulled from Docker Hub, and a `srsran4g-noavx` image built locally from a Dockerfile in the repo | Needs internet access to pull/build on first use, same as the main app images. |
| **VoWiFi** *(alpha, highly experimental)* | Not an apt package — builds `osmo-epdg` (Erlang/OTP via `erlang rebar3`) and the `strongswan-epdg` plugin from source, plus a standard C build toolchain (`build-essential autoconf automake libtool pkg-config gperf bison flex`, `libgmp-dev libssl-dev libgcrypt-dev libtalloc-dev liburing-dev libpcsclite-dev libusb-1.0-0-dev libgnutls28-dev libsystemd-dev libmnl-dev libsctp-dev`, `nftables`) | Heaviest optional module install — a real from-source build, not a quick apt install. Needs internet access to clone both repos. |

### Installation Commands

**Ubuntu 24.04 / 22.04:**
```bash
# Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# Docker Compose (usually included with Docker)
sudo apt install docker-compose-plugin

# Open5GS
sudo add-apt-repository ppa:open5gs/latest
sudo apt update
sudo apt install open5gs

# MongoDB
sudo apt install mongodb-org

# Verify installations
docker --version          # Should be 24.0+
docker compose version    # Should be v2.20+
systemctl status open5gs-nrfd  # Should show open5gs service
mongod --version          # Should be 6.0+
```

### DNS Configuration

Ensure DNS is working properly:
```bash
# Test DNS resolution
nslookup registry.npmjs.org

# If DNS fails, configure resolv.conf
sudo nano /etc/resolv.conf
# Add:
nameserver 8.8.8.8
nameserver 8.8.4.4
nameserver 1.1.1.1

# Restart systemd-resolved
sudo systemctl restart systemd-resolved
```

---

## Network Requirements

### IP Addressing

**Static IP Recommended:**
- Makes accessing the NMS more reliable
- Required for production deployments
- Can use DHCP reservation as alternative

**Localhost Requirement:**
- MongoDB must be accessible on `127.0.0.1:27017`
- Open5GS services must be on localhost or accessible

### Port Requirements

**Required Ports (Open):**
- **8888/tcp** - NMS web interface (user access)
- Can be changed via `NGINX_PORT` environment variable

**Internal Ports (Localhost Only):**
- **3001/tcp** - Backend REST API AND WebSocket (both served on the same port since v2.0-beta_0.4 — the WebSocket upgrade is authenticated against the session cookie before the socket is accepted; there is no longer a separate 3002 listener)
- **27017/tcp** - MongoDB (localhost only, no external access)

**Firewall Configuration:**
```bash
# Allow NMS web access
sudo ufw allow 8888/tcp

# Deny direct backend access (should be proxied only)
sudo ufw deny 3001/tcp

# MongoDB should only listen on localhost
# Edit /etc/mongod.conf:
# net:
#   bindIp: 127.0.0.1
```

### Ports Used by Optional Modules

These are only relevant if you enable the corresponding module from the UI — none of them are required for a base install.

| Port | Protocol | Module | Purpose |
|------|----------|--------|---------|
| 80/tcp | HTTP | Core (nginx) | Web UI is also reachable here in addition to `NGINX_PORT` (default 8888) |
| 443/tcp | HTTPS | Core (nginx) | TLS vhost for `acs.sc.sercomm.com` — relays factory-reset Sercomm radios (which hardcode this ACS URL) into the local GenieACS instance |
| 514/udp or /tcp | Syslog | Syslog Forwarding | Outbound only — the NMS host connects out to *your* syslog server on this port (or whatever port you configure); nothing needs to be opened inbound on the NMS host itself |
| 5060/udp | SIP | IMS / VoLTE | P-CSCF SIP signaling |
| 3868–3871/tcp | Diameter | IMS / VoLTE | Cx (I/S-CSCF ↔ PyHSS) and Rx (P-CSCF ↔ PCRF) peer connections — all localhost-only in a single-host deployment |
| 29118/sctp | SGs | SMS over SGs | MME ↔ OsmoMSC signaling |
| 2905/tcp, 14001/tcp | M3UA / SUA | SMS over SGs | OsmoSTP internal signaling transport |
| 4222/tcp | GSUP | SMS over SGs | OsmoMSC ↔ OsmoHLR |
| 500/udp, 4500/udp | IKEv2 | VoWiFi | osmo-epdg IKEv2/IPsec (ePDG ↔ UE) — the actual internet-facing port for real handsets; localhost-only against the test emulator used during development |
| 8443/tcp | HTTPS | CBRS SAS | SAS-CBSD protocol endpoint (Sercomm radios require HTTPS) |

> **SEPP note:** SEPP's N32 port (7777, same as the other NFs' SBI port) is core, not
> optional — but unlike every other NF's SBI traffic, it's only genuinely
> internet-facing if you're doing real cross-operator roaming with a visited PLMN. In a
> single-host / lab deployment it stays localhost-only like the rest of the SBI mesh.

### Network Connectivity

**Internet Access Required For:**
- Docker image builds (npm registry, Docker Hub)
- Initial installation
- Software updates

**Can Run Offline After Installation:**
- All dependencies cached in Docker images
- No external API calls during operation
- Fully air-gapped deployment possible

### DNS Requirements

**Must Resolve:**
- `registry.npmjs.org` (for npm packages during build)
- `hub.docker.com` (for Docker base images)

**No DNS Required For:**
- Runtime operation (after images are built)
- Open5GS management
- Subscriber provisioning

---

## Open5GS Requirements

### Version Requirements

**Minimum:** Open5GS 2.7.0  
**Recommended:** Open5GS 2.7.2 or later  
**Tested:** Open5GS 2.7.0 - 2.7.2

### Configuration File Location

Open5GS configuration files **must** be located at:
```
/etc/open5gs/
├── nrf.yaml
├── scp.yaml
├── amf.yaml
├── smf.yaml
├── upf.yaml
├── ausf.yaml
├── udm.yaml
├── udr.yaml
├── pcf.yaml
├── nssf.yaml
├── bsf.yaml
├── mme.yaml
├── hss.yaml
├── pcrf.yaml
├── sgwc.yaml
└── sgwu.yaml
```

**Custom Paths:**
If using a different path, set `CONFIG_PATH` environment variable:
```bash
# In docker-compose.yml or .env
CONFIG_PATH=/custom/path/to/configs
```

### Service Names

Open5GS services must follow standard naming:
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

### MongoDB Configuration

**Database Name:** `open5gs`  
**Collection Name:** `subscribers`  
**Connection:** `mongodb://127.0.0.1:27017/open5gs`

**MongoDB must be:**
- Running before NMS starts
- Accessible on localhost
- Using default port 27017 (or configure via `MONGODB_URI`)

### Permissions

The backend container needs access to:
- `/etc/open5gs/` - Read/write for config files
- `/var/log/open5gs/` - Read for service logs
- `/run/systemd/system/` - Read for systemd socket
- `/var/run/dbus/system_bus_socket` - Read for D-Bus
- `/usr/bin/systemctl` - Execute for service control

These are mounted via Docker volumes in `docker-compose.yml`.

---

## Browser Requirements

### Supported Browsers

**Fully Supported:**
- **Google Chrome** 120+ ✅
- **Microsoft Edge** 120+ ✅
- **Mozilla Firefox** 121+ ✅
- **Safari** 17+ ✅

**Likely Compatible:**
- Chromium-based browsers (Brave, Vivaldi, Opera)
- Firefox ESR (Extended Support Release)

**Not Supported:**
- Internet Explorer (any version)
- Legacy Edge (pre-Chromium)
- Mobile browsers (UI not optimized for mobile)

### Browser Requirements

- **JavaScript:** Must be enabled
- **WebSocket:** Required for real-time updates
- **Cookies:** Required for session management (future feature)
- **Local Storage:** Required for UI preferences
- **Screen Resolution:** Minimum 1280x720, recommended 1920x1080

### Network Requirements

**From Browser to NMS:**
- HTTP connection to port 8888
- WebSocket upgrade capability
- No proxy or firewall blocking WebSocket

**Bandwidth:**
- Minimal during normal use (~10-50 KB/s)
- Higher during log streaming (~100-500 KB/s)
- Initial page load ~2-5 MB (JavaScript bundles)

---

## Storage Requirements

### Disk Space Breakdown

**Docker Images:** ~2GB
- nginx:alpine - ~50MB
- Node.js 20 base - ~200MB
- Backend built image - ~500MB
- Frontend built image - ~100MB

**Configuration Backups:** Variable
- ~10KB per NF config file × 17 = ~170KB per backup
- Retention: All backups kept unless manually deleted
- Estimate: ~100MB for 500 backups

**MongoDB Backups:** Variable
- Depends on subscriber count
- ~1KB per subscriber (base)
- ~10KB per subscriber (with session history)
- Estimate: 10MB for 1000 subscribers

**System Logs:** Variable
- Open5GS logs: ~100MB-1GB (depends on verbosity)
- NMS audit logs: ~10MB-100MB (depends on activity)
- Log rotation recommended

**Total Estimates:**

| Deployment Size | Minimum | Recommended |
|-----------------|---------|-------------|
| **Small** (1-10 subs) | 10GB | 20GB |
| **Medium** (10-100 subs) | 20GB | 50GB |
| **Large** (100-1000 subs) | 50GB | 100GB |
| **Enterprise** (1000+ subs) | 100GB | 200GB+ |

### IOPS Requirements

**Minimum:**
- 100 IOPS (HDD acceptable for testing)

**Recommended:**
- 500+ IOPS (SSD recommended)

**High Performance:**
- 1000+ IOPS (NVMe SSD for enterprise)

### Storage Locations

**Critical Paths:**
- `/etc/open5gs/` - Configuration files (must persist)
- `/etc/open5gs/backups/` - Backup storage (must persist)
- `/var/lib/docker/` - Docker images and volumes
- `/var/lib/mongodb/` - MongoDB database (must persist)

**Recommended:**
- Use separate disk/partition for `/var/lib/mongodb` in production
- Regular backups of `/etc/open5gs/` to external storage
- Log rotation configured to prevent disk space exhaustion

---

## Additional Requirements

### Time Synchronization

**NTP Required:**
- Accurate time sync critical for audit logs
- Service restart timestamps
- Backup timestamps

```bash
# Install and configure NTP
sudo apt install systemd-timesyncd
sudo timedatectl set-ntp true

# Verify time sync
timedatectl status
```

### User Permissions

**Docker Group:**
User running docker commands must be in `docker` group:
```bash
sudo usermod -aG docker $USER
# Logout and login for changes to take effect
```

**Systemd Access:**
Backend container runs with:
- `privileged: true` - Required for systemctl access
- `pid: host` - Required to see host processes
- User accepts security implications

### Security Requirements

**For Production Deployments:**
- Firewall configured (ufw, iptables)
- SSL/TLS certificates (Let's Encrypt recommended)
- VPN or IP whitelist for NMS access
- Regular security updates applied
- Audit log monitoring configured

See **[docs/deployment.md](deployment.md)** for production security hardening.

---

## Compatibility Matrix

| Component | Minimum | Recommended | Tested |
|-----------|---------|-------------|--------|
| **OS** | Ubuntu 20.04 | Ubuntu 24.04 | 24.04, 22.04 |
| **Kernel** | 5.4+ | 5.15+ | 6.8 |
| **Docker** | 24.0 | 27.0+ | 27.3.1 |
| **Docker Compose** | v2.20 | v2.30+ | v2.29.7 |
| **Open5GS** | 2.7.0 | 2.7.2+ | 2.7.0-2.7.2 |
| **MongoDB** | 6.0 | 6.0+ | 6.0.5 |
| **Node.js** | 20 LTS | 20 LTS | 20.18.0 |
| **systemd** | 245 | 255+ | 255.4 |

---

## Pre-Installation Checklist

Before installing Open5GS NMS, verify:

- [ ] Ubuntu 24.04 LTS or 22.04 LTS installed
- [ ] Docker Engine 24.0+ installed and running
- [ ] Docker Compose v2.20+ available
- [ ] Open5GS 2.7.0+ installed with configs in `/etc/open5gs/`
- [ ] MongoDB 6.0+ running on `localhost:27017`
- [ ] All 17 Open5GS services managed by systemd (16 core NFs + SEPP)
- [ ] DNS resolution working (`nslookup registry.npmjs.org`)
- [ ] At least 20GB free disk space
- [ ] Port 8888 available (or alternate port configured)
- [ ] User in `docker` group
- [ ] Firewall allows port 8888 (or alternate)
- [ ] Time synchronization configured (NTP)

---

## Troubleshooting Requirements

If installation fails, verify:

**Docker Issues:**
```bash
docker --version
docker compose version
docker ps
```

**Open5GS Issues:**
```bash
ls -la /etc/open5gs/
systemctl list-units | grep open5gs
systemctl status open5gs-nrfd
```

**MongoDB Issues:**
```bash
mongod --version
systemctl status mongod
mongo --eval "db.adminCommand('ping')"
```

**Network Issues:**
```bash
sudo netstat -tlnp | grep -E '8888|3001|3002|27017'
nslookup registry.npmjs.org
ping -c 4 8.8.8.8
```

**Permissions Issues:**
```bash
groups $USER  # Should include 'docker'
ls -la /etc/open5gs/
```

See **[docs/troubleshooting.md](troubleshooting.md)** for detailed solutions.

---

## Next Steps

Once requirements are met:
1. Follow **[INSTALL.md](../INSTALL.md)** for installation
2. Configure via **[docs/configuration.md](configuration.md)**
3. Deploy to production via **[docs/deployment.md](deployment.md)**
