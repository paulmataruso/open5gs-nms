# Installation Guide — Open5GS NMS

Complete step-by-step installation instructions for deploying the Open5GS Network Management System.

---

## Table of Contents

1. [System Requirements](#system-requirements)
2. [Prerequisites](#prerequisites)
   - [1. Install Required System Packages](#1-install-required-system-packages)
   - [2. Install Docker](#2-install-docker)
   - [3. Install MongoDB](#3-install-mongodb)
   - [4. Install Open5GS](#4-install-open5gs)
   - [5. Configure DNS Resolution](#5-configure-dns-resolution)
3. [Installation Steps](#installation-steps)
4. [Post-Installation Configuration](#post-installation-configuration)
5. [Verification](#verification)
6. [Troubleshooting](#troubleshooting)
7. [Next Steps](#next-steps)

---

## System Requirements

### Tested Platform

- **Operating System:** Ubuntu 24.04 LTS (x86_64)
- **Kernel:** Linux 5.15+ recommended

### Hardware Requirements

**Minimum:**
- CPU: 2 cores
- RAM: 4 GB
- Disk: 20 GB free space

**Recommended:**
- CPU: 4 cores
- RAM: 8 GB
- Disk: 50 GB free space (for logs and backups)

### Network Requirements

- Static IP address or DHCP reservation recommended
- DNS resolution must be working
- Internet access for Docker builds (npm registry)
- Open ports:
  - `8888/tcp` — NMS web interface
  - `3001/tcp` — Backend API (internal, proxied by nginx)
  - `3002/tcp` — WebSocket (internal, proxied by nginx)

---

## Prerequisites

### 1. Install Required System Packages

```bash
sudo apt update
sudo apt install -y iptables-persistent conntrack tshark
```

- **`iptables-persistent`** — Saves and restores iptables NAT rules across reboots. Required if you configure UPF internet access (MASQUERADE rules). During install, answer **Yes** to both prompts to save current IPv4 and IPv6 rules.
- **`conntrack`** — Connection tracking tools required by Open5GS UPF and SGW-U for GTP session management.
- **`tshark`** — Network packet analyser used by the NMS to detect active 5G UE sessions via GTP-U inner packet inspection. Required for the 5G active sessions feature on the Topology and RAN Network pages.

---

### 2. Install Docker

```bash
# Install Docker using the official script
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add current user to the docker group (logout/login required)
sudo usermod -aG docker $USER

# Install Docker Compose v2
sudo apt install -y docker-compose-plugin

# Verify installation
docker --version
docker compose version
```

### 3. Install MongoDB

```bash
# Install prerequisites
sudo apt update
sudo apt install -y gnupg

# Add MongoDB repo key
curl -fsSL https://pgp.mongodb.com/server-8.0.asc | \
  sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor

# Add MongoDB repo to system
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg] \
  https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/8.0 multiverse" | \
  sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list

# Update packages and install
sudo apt update
sudo apt install -y mongodb-org

# Enable and start MongoDB
sudo systemctl enable mongod
sudo systemctl start mongod

# Verify MongoDB is running
sudo systemctl status mongod
```

> **MongoDB AVX Workaround**
>
> Starting with MongoDB 5.0, AVX CPU support is required. If your machine does not have AVX, you have two options:
>
> - **Recommended:** Use the included Docker Compose file. In the root of this repo is a `mongo_docker/` folder — run `docker compose -f docker-compose-basic.yaml up -d`, then skip to the [Install Open5GS](#3-install-open5gs) section. To enable direct document editing via Mongo Express, use `docker-compose-mongoexp.yaml` instead, which exposes Mongo Express at `http://<host-ip>:8081/`.
>
> - **Alternative:** Find and install an older version of MongoDB that does not require AVX (you will also need a compatible version of `libssl`).
>
> **Note:** If you use MongoDB in Docker, you will need to build Open5GS from source. This is because `apt` hangs on the MongoDB install step. As a workaround, you can install any version of MongoDB on the host and then disable the service — this satisfies the dependency check and allows `apt` to install Open5GS without errors.

### 4. Install Open5GS

```bash
# Note: If MongoDB is running in Docker, either build Open5GS from source,
# or install MongoDB on the host (then disable it) to avoid apt dependency errors.

# Add Open5GS PPA repository
sudo add-apt-repository ppa:open5gs/latest
sudo apt update

# Install all Open5GS components
sudo apt install -y open5gs

# Enable services
sudo systemctl enable open5gs-nrfd
sudo systemctl enable open5gs-amfd
sudo systemctl enable open5gs-smfd
sudo systemctl enable open5gs-upfd
# ... (repeat for all 16 services, or use the service_control.sh script below)

# Start services
sudo systemctl start open5gs-nrfd
sudo systemctl start open5gs-amfd
# ... (or start all with: sudo systemctl start open5gs-*)
```

> **Quick Service Control**
>
> A helper script is included in the project folder:
> ```bash
> chmod +x service_control.sh
> ./service_control.sh start|stop|restart
> ```

#### Building Open5GS from Source

```bash
# Install build dependencies
sudo apt update && sudo apt install -y \
  build-essential git meson ninja-build pkg-config cmake \
  libglib2.0-dev libgnutls28-dev libgcrypt-dev libidn11-dev \
  libmongoc-dev libbson-dev libyaml-dev libmicrohttpd-dev \
  libnghttp2-dev libsctp-dev lksctp-tools flex bison libssl-dev \
  libtalloc-dev libcurl4-openssl-dev uuid-dev liblz4-dev

# Clone repository
If you have not already cloned the github repo then
git clone https://github.com/open5gs/open5gs

Otherwise we can move to the project folder.
cd open5gs

# Configure and build
meson setup build \
  --prefix=/usr \
  --sysconfdir=/etc \
  --localstatedir=/var

ninja -C build
sudo ninja -C build install
sudo ldconfig

# Verify installation
ls /usr/bin/open5gs-*
ls /etc/open5gs/*

# Create systemd service files for open5gs and start the services.
chmod +x ./generate_open5gs_systemd.sh
./generate_open5gs_systemd.sh
./service_control.sh start
```

### 5. Configure DNS Resolution

If you are on a fresh Ubuntu install, verify DNS is working:

```bash
# Test DNS resolution
nslookup registry.npmjs.org

# If DNS fails, add nameservers manually:
sudo nano /etc/resolv.conf
# Add:
# nameserver 8.8.8.8
# nameserver 8.8.4.4
# nameserver 1.1.1.1

# Restart systemd-resolved
sudo systemctl restart systemd-resolved
```

---

## Installation Steps

### Step 1: Clone the Repository

```bash
cd /opt
sudo git clone https://github.com/paulmataruso/open5gs-nms
sudo chown -R $USER:$USER open5gs-nms
cd open5gs-nms
```

### Step 2: Configure Environment

Copy the example file and review it before deploying:

```bash
cp .env.example .env
nano .env
```

**Authentication settings (review before first deploy):**

```bash
# Set a password for the initial admin account.
# If left empty, a random password is generated and printed to container logs.
FIRST_RUN_PASSWORD=your-secure-password-here

# Session lifetime in seconds (default: 24 hours)
SESSION_MAX_AGE=86400

# Set to 'true' ONLY if you are serving over HTTPS.
# Leave as 'false' for plain HTTP deployments — setting this wrong silently breaks login.
COOKIE_SECURE=false
```

**Other settings (defaults work for most deployments):**

```bash
NODE_ENV=production
PORT=3001
MONGODB_URI=mongodb://127.0.0.1:27017/open5gs
CONFIG_PATH=/etc/open5gs
BACKUP_PATH=/etc/open5gs/backups/config
MONGO_BACKUP_PATH=/etc/open5gs/backups/mongodb
LOG_LEVEL=info
WS_PORT=3002
HOST_SYSTEMCTL_PATH=/usr/bin/systemctl
```

### Step 3: Create Backup Directories

```bash
sudo mkdir -p /etc/open5gs/backups/config
sudo mkdir -p /etc/open5gs/backups/mongodb
sudo chmod 755 /etc/open5gs/backups
```

### Step 4: Build and Deploy

```bash
# Build Docker images (this may take 5–10 minutes)
docker compose build --no-cache

# Start all services
docker compose up -d

# View logs to confirm everything started correctly
docker compose logs -f
```

**Expected output:**

```
open5gs-nms-nginx     | ... nginx started
open5gs-nms-backend   | ... Server listening on port 3001
open5gs-nms-backend   | ... WebSocket server listening on port 3002
open5gs-nms-frontend  | ... Frontend server ready
```

Press `Ctrl+C` to exit log view.

### Step 5: Configure Firewall

```bash
# Allow NMS web interface
sudo ufw allow 8888/tcp

# Allow DNS (if needed)
sudo ufw allow 53/udp
sudo ufw allow 53/tcp

# Reload and verify
sudo ufw reload
sudo ufw status
```

---

## Post-Installation Configuration

### First Login

The NMS requires authentication. On first startup, an admin account is created automatically.

**If you set `FIRST_RUN_PASSWORD` in your `.env`:**
- Log in with username `admin` and the password you set.
- Remove or clear `FIRST_RUN_PASSWORD` from `.env` after your first login.

**If you left `FIRST_RUN_PASSWORD` empty:**
- A random password is generated and printed **once** to the backend container logs.
- Retrieve it before logging in:

```bash
docker logs open5gs-nms-backend 2>&1 | grep -A4 "FIRST RUN"
```

Expected output:
```
════════════════════════════════════════════════════
  FIRST RUN — Admin account created
  Username : admin
  Password : Xk7mQ2pL9nRv4wYa
  Change this password after first login!
════════════════════════════════════════════════════
```

> **Note:** This password is only printed once. If you miss it, delete the auth database and restart:
> ```bash
> docker compose down
> rm -f ./data/auth.db
> docker compose up -d
> docker logs open5gs-nms-backend 2>&1 | grep -A4 "FIRST RUN"
> ```

### Access the Web Interface

Open your browser and navigate to:

```
http://YOUR_SERVER_IP:8888
```

You should see the Open5GS NMS dashboard.

### Initial Configuration Wizard (Optional)

For quick setup of a basic 4G/5G network:

1. Click **Auto Config** in the sidebar.
2. Enter your network parameters:
   - PLMN ID (MCC/MNC)
   - Control plane IP addresses
   - User plane IP addresses
   - Session pool subnets
3. Preview the configuration changes.
4. Click **Apply Configuration**.

### Create Your First Subscriber

1. Navigate to the **Subscribers** page.
2. Click **Add Subscriber**, or use the **SIM Generator**:
   - Select country (MCC) and enter MNC.
   - Set the number of SIMs to generate.
   - Check **Auto-provision to Open5GS database** to add them automatically.
   - Click **Generate SIM Data**.
3. For manual creation:
   - Enter IMSI (15 digits).
   - Generate or enter K and OPc keys (32 hex characters each).
   - Configure AMBR, slices, and sessions.
   - Click **Create**.

### Configure Network Topology

The network topology will automatically populate once your services are configured and running.

1. Navigate to the **Topology** page.
2. View your network function status.
   - **Green** = service active
   - **Red** = service inactive

---

## Verification

### Check Docker Containers

```bash
docker compose ps
```

**Expected output (all should show "Up"):**

```
NAME                    STATUS
open5gs-nms-nginx       Up
open5gs-nms-backend     Up (healthy)
open5gs-nms-frontend    Up (healthy)
```

### Health Check

```bash
# Backend API health check
curl http://localhost:3001/api/health
# Expected: {"status":"ok","timestamp":"2026-..."}

# Frontend check
curl http://localhost:8080
# Expected: HTML response
```

### Verify Open5GS Services

In the NMS web interface:

1. Navigate to the **Services** page.
2. All 16 services should display their status.
3. Verify that critical services are **active** (green): NRF, AMF, SMF, UPF (5G core) and MME, HSS, SGW-C, SGW-U (4G core).

Or via the command line:

```bash
# Check all Open5GS services
systemctl status open5gs-*

# Check a specific service
systemctl status open5gs-amfd
```

### Test Configuration Management

1. Navigate to **Configuration** → **5G Core** → **NRF**.
2. Make a small change (e.g., change the log level).
3. Click **Apply Configuration**.
4. Verify:
   - A backup was created.
   - The service restarted successfully.
   - The change appears in `/etc/open5gs/nrf.yaml`.

---

## Troubleshooting

### Docker Build Fails with DNS Errors

**Error:** `npm error code EAI_AGAIN`

**Solution:**

```bash
# Fix host DNS
sudo nano /etc/resolv.conf
# Add: nameserver 8.8.8.8

# The docker-compose.yml already uses network: host for builds.
# Just rebuild:
docker compose build --no-cache
```

### Backend Container Won't Start

**Check logs:**

```bash
docker compose logs backend
```

**Common causes:**

- **MongoDB not accessible:**
  ```bash
  sudo systemctl status mongod
  sudo systemctl start mongod
  ```

- **Permission denied on `/etc/open5gs`:**
  ```bash
  ls -la /etc/open5gs
  sudo chmod 755 /etc/open5gs
  ```

- **`systemctl` not accessible from container:**
  ```bash
  # Verify privileged mode
  docker inspect open5gs-nms-backend | grep Privileged
  # Expected: "Privileged": true
  ```

### Can't Access Web Interface

1. Confirm nginx is running:
   ```bash
   docker compose ps nginx
   docker compose logs nginx
   ```

2. Verify port 8888 is open:
   ```bash
   sudo ufw status
   sudo ufw allow 8888/tcp
   ```

3. Check for port conflicts:
   ```bash
   sudo netstat -tlnp | grep 8888
   ```

### Services Won't Restart

**Verify backend container privileges:**

```bash
docker inspect open5gs-nms-backend | grep -E 'Privileged|PidMode'
```

**Expected:**

```
"Privileged": true,
"PidMode": "host",
```

**Test `systemctl` from inside the container:**

```bash
docker exec open5gs-nms-backend systemctl status open5gs-nrfd
```

### Configuration Apply Fails

1. **Check audit logs:**
   ```bash
   tail -f /opt/open5gs-nms/logs/audit/*.log
   ```

2. **Verify YAML syntax:** Use the text editor mode to check for syntax errors and review the validation output in the preview pane.

3. **Check service logs:**
   ```bash
   journalctl -u open5gs-nrfd -n 50
   ```

---

## Next Steps

### Recommended Actions

1. **Create a Backup** — Navigate to the **Backup** page, click **Create Backup**, and verify the backup was created in `/etc/open5gs/backups/`.

2. **Review Configuration** — Check each network function configuration. Verify PLMN IDs, IP addresses, ports, and TAI/TAC lists.

3. **Set Up Monitoring** — Enable real-time log streaming for critical services and monitor the Dashboard for service health.

4. **Configure NAT/Routing** — If using UPF for internet access:
   ```bash
   sudo sysctl -w net.ipv4.ip_forward=1
   sudo sysctl -w net.ipv6.conf.all.forwarding=1
   sudo iptables -t nat -A POSTROUTING -s 10.45.0.0/16 ! -o ogstun -j MASQUERADE
   ```

5. **Test with a UE** — Provision a subscriber, connect a UE (phone or modem), verify registration in the logs, and check active sessions in the topology view.

### Production Deployment

For production use, consider the following:

- **Enable HTTPS** — Set up SSL certificates (e.g., Let's Encrypt) and configure nginx SSL termination. Set `COOKIE_SECURE=true` in `.env` when HTTPS is active. See [Deployment Guide](docs/deployment.md).
- **Regular Backups** — Automate backup jobs via cron and store copies off-site.
- **Monitoring** — Set up external monitoring (Prometheus, Grafana) and configure alerts for service failures.
- **Network Security** — Restrict NMS access to the management network or behind a VPN. The NMS requires login but network-level restrictions are still recommended for internet-exposed deployments.

### Getting Help

- **Documentation:** [README.md](../README.md), [docs/](../docs/)
- **Troubleshooting:** [docs/troubleshooting.md](docs/troubleshooting.md)
- **GitHub Issues:** https://github.com/paulmataruso/open5gs-nms/issues
- **Discussions:** https://github.com/paulmataruso/open5gs-nms/discussions

---

## Uninstallation

To completely remove the NMS:

```bash
cd /opt/open5gs-nms

# Stop and remove containers and volumes
docker compose down -v

# Remove images
docker rmi $(docker images -q '*open5gs-nms*')

# Remove installation directory
sudo rm -rf /opt/open5gs-nms

# Optional: Remove backups
sudo rm -rf /etc/open5gs/backups
```

> **Note:** This does **not** remove Open5GS itself or MongoDB.

---

**Installation complete!** Access your NMS at `http://YOUR_SERVER_IP:8888`
