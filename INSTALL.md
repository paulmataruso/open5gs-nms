# Installation Guide - Open5GS NMS

Complete step-by-step installation instructions for deploying the Open5GS Network Management System.

---

## Table of Contents

1. [System Requirements](#system-requirements)
2. [Prerequisites](#prerequisites)
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
- RAM: 4GB
- Disk: 20GB free space

**Recommended:**
- CPU: 4 cores
- RAM: 8GB
- Disk: 50GB free space (for logs and backups)

### Network Requirements
- Static IP address or DHCP reservation recommended
- DNS resolution must be working
- Internet access for Docker builds (npm registry)
- Open ports:
  - 8888/tcp - NMS web interface
  - 3001/tcp - Backend API (internal, proxied by nginx)
  - 3002/tcp - WebSocket (internal, proxied by nginx)

---

## Prerequisites

### 2. Install MongoDB

```bash
# Install MongoDB
sudo apt update
sudo apt install gnupg

#Install mongoDB repo key
curl -fsSL https://pgp.mongodb.com/server-8.0.asc | sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor

#Add mongoDB repo to system
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/8.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list

#Update packages
sudo apt update

#Install MongoDB
apt install -y mongodb-org

# Enable and start MongoDB
sudo systemctl enable mongod
sudo systemctl start mongod

# Verify MongoDB is running, if not see below
sudo systemctl status mongod

#MongoDB AVX Workaround
Starting with MongoDB 5.0, MongoDB needs AVX support on your CPU. If your machine does not have AVX you can do one of two things:
In this root folder of this repo, is a folder called "mongo_docker". Just run the docker compose file(docker compose up -d" instead of installing docker to your machine then skip to the install open5gs section
You can also find an older version of mongoDB that does not need AVX and install it, you will also need to find a copy of libssl that works with it. I reccommned just going
the docker route. It is much easier to setup, but it is not secure.

```

### 1. Install Open5GS

```bash
# Add Open5GS PPA repository
sudo add-apt-repository ppa:open5gs/latest
sudo apt update

# Install all Open5GS components
sudo apt install -y open5gs

# Enable and start services
sudo systemctl enable open5gs-nrfd
sudo systemctl enable open5gs-amfd
sudo systemctl enable open5gs-smfd
sudo systemctl enable open5gs-upfd
# ... (enable all 16 services)

# Start services
sudo systemctl start open5gs-nrfd
sudo systemctl start open5gs-amfd
# ... (or use systemctl start open5gs-* for all)
```

### 3. Install Docker

```bash
# Install Docker using the official script
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add current user to docker group (logout/login required)
sudo usermod -aG docker $USER

# Install Docker Compose v2
sudo apt install -y docker-compose-plugin

# Verify installation
docker --version
docker compose version
```

### 4. Configure DNS Resolution

If you're on a fresh Ubuntu install, ensure DNS is working:

```bash
# Test DNS resolution
nslookup registry.npmjs.org

# If DNS fails, fix it:
sudo nano /etc/resolv.conf
# Add these lines:
nameserver 8.8.8.8
nameserver 8.8.4.4
nameserver 1.1.1.1

# Restart systemd-resolved
sudo systemctl restart systemd-resolved
```

---

## Installation Steps

### Step 1: Clone the Repository

```bash
# Navigate to installation directory
cd /opt

# Clone the repository
sudo git clone https://github.com/paulmataruso/open5gs-nms

# Set ownership
sudo chown -R $USER:$USER open5gs-nms

# Navigate into directory
cd open5gs-nms
```

### Step 2: Configure Environment (Optional)

The default configuration works for most deployments. If you need custom settings:

```bash
# Copy example environment file
cp .env.example .env

# Edit configuration
nano .env
```

**Default values (usually don't need changing):**
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
# Create backup directories
sudo mkdir -p /etc/open5gs/backups/config
sudo mkdir -p /etc/open5gs/backups/mongodb

# Set permissions
sudo chmod 755 /etc/open5gs/backups
```

### Step 4: Build and Deploy

```bash
# Build Docker images (this may take 5-10 minutes)
docker compose build --no-cache

# Start all services
docker compose up -d

# View logs to ensure everything started correctly
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

# If using UFW firewall, ensure DNS is allowed
sudo ufw allow 53/udp
sudo ufw allow 53/tcp

# Reload firewall
sudo ufw reload

# Check firewall status
sudo ufw status
```

---

## Post-Installation Configuration

### Access the Web Interface

1. Open your browser and navigate to:
   ```
   http://YOUR_SERVER_IP:8888
   ```

2. You should see the Open5GS NMS dashboard

### Initial Configuration Wizard (Optional)

For quick setup of a basic 4G/5G network:

1. Click **"Auto Config"** in the sidebar
2. Enter your network parameters:
   - PLMN ID (MCC/MNC)
   - Control plane IP addresses
   - User plane IP addresses
   - Session pool subnets
3. Preview the configuration changes
4. Click **"Apply Configuration"**

### Create Your First Subscriber

1. Navigate to **"Subscribers"** page
2. Click **"Add Subscriber"** or use the **"SIM Generator"**
3. For SIM Generator:
   - Select country (MCC)
   - Enter MNC
   - Set number of SIMs to generate
   - **Check "Auto-provision to Open5GS database"** to add them automatically
   - Click **"Generate SIM Data"**
4. For manual creation:
   - Enter IMSI (15 digits)
   - Generate or enter K and OPc keys (32 hex characters each)
   - Configure AMBR, slices, and sessions
   - Click **"Create"**

### Configure Network Topology

The network topology will automatically display once your services are configured and running.

1. Navigate to **"Topology"** page
2. View your network function status
3. Green indicators = active services
4. Red indicators = inactive services

---

## Verification

### Check Docker Containers

```bash
# View running containers
docker compose ps

# Expected output (all should be "Up"):
# NAME                    STATUS
# open5gs-nms-nginx       Up
# open5gs-nms-backend     Up (healthy)
# open5gs-nms-frontend    Up (healthy)
```

### Health Check

```bash
# Backend API health check
curl http://localhost:3001/api/health

# Expected response:
# {"status":"ok","timestamp":"2026-03-23T..."}

# Frontend check
curl http://localhost:8080

# Should return HTML
```

### Verify Open5GS Services

In the NMS web interface:

1. Navigate to **"Services"** page
2. All 16 services should show status
3. Check that critical services are **active** (green):
   - NRF (required for 5G)
   - AMF, SMF, UPF (5G core)
   - MME, HSS, SGW-C, SGW-U (4G core)

Or via command line:

```bash
# Check all Open5GS services
systemctl status open5gs-*

# Check specific service
systemctl status open5gs-amfd
```

### Test Configuration Management

1. Navigate to **"Configuration"** → **"5G Core"** → **"NRF"**
2. Make a small change (e.g., change log level)
3. Click **"Apply Configuration"**
4. Verify:
   - Backup was created
   - Service restarted successfully
   - Change appears in `/etc/open5gs/nrf.yaml`

---

## Troubleshooting

### Docker Build Fails with DNS Errors

**Error:** `npm error code EAI_AGAIN`

**Solution:**
```bash
# Fix host DNS first
sudo nano /etc/resolv.conf
# Add: nameserver 8.8.8.8

# The docker-compose.yml already uses network: host for builds
# Just rebuild:
docker compose build --no-cache
```

### Backend Container Won't Start

**Check logs:**
```bash
docker compose logs backend
```

**Common issues:**

1. **MongoDB not accessible:**
   ```bash
   sudo systemctl status mongod
   sudo systemctl start mongod
   ```

2. **Permission denied on /etc/open5gs:**
   ```bash
   ls -la /etc/open5gs
   sudo chmod 755 /etc/open5gs
   ```

3. **systemctl not accessible:**
   ```bash
   # Verify privileged mode in docker-compose.yml
   docker inspect open5gs-nms-backend | grep Privileged
   # Should show: "Privileged": true
   ```

### Can't Access Web Interface

1. **Check nginx is running:**
   ```bash
   docker compose ps nginx
   docker compose logs nginx
   ```

2. **Verify port 8888 is not blocked:**
   ```bash
   sudo ufw status
   sudo ufw allow 8888/tcp
   ```

3. **Check if something else is using port 8888:**
   ```bash
   sudo netstat -tlnp | grep 8888
   ```

### Services Won't Restart

**Check backend has proper permissions:**
```bash
docker inspect open5gs-nms-backend | grep -E 'Privileged|PidMode'
```

**Should show:**
```
"Privileged": true,
"PidMode": "host",
```

**Test systemctl from container:**
```bash
docker exec open5gs-nms-backend systemctl status open5gs-nrfd
```

### Configuration Apply Fails

1. **Check audit logs:**
   ```bash
   tail -f /opt/open5gs-nms/logs/audit/*.log
   ```

2. **Verify YAML syntax:**
   - Use the text editor mode to check for syntax errors
   - Look for the validation errors in the preview

3. **Check service logs:**
   ```bash
   journalctl -u open5gs-nrfd -n 50
   ```

---

## Next Steps

### Recommended Actions

1. **Create a Backup:**
   - Navigate to **Backup** page
   - Click **"Create Backup"**
   - Verify backup was created in `/etc/open5gs/backups/`

2. **Review Configuration:**
   - Check each network function configuration
   - Verify PLMN IDs, IP addresses, ports
   - Ensure TAI/TAC lists are correct

3. **Set Up Monitoring:**
   - Enable real-time log streaming for critical services
   - Monitor the Dashboard for service health

4. **Configure NAT/Routing:**
   - If using UPF for internet access, configure NAT:
     ```bash
     sudo sysctl -w net.ipv4.ip_forward=1
     sudo sysctl -w net.ipv6.conf.all.forwarding=1
     sudo iptables -t nat -A POSTROUTING -s 10.45.0.0/16 ! -o ogstun -j MASQUERADE
     ```

5. **Test with UE:**
   - Provision a subscriber
   - Connect a UE (phone or modem)
   - Verify registration in logs
   - Check active sessions in topology

### Production Deployment

For production use, consider:

1. **Enable HTTPS:**
   - Set up SSL certificates (Let's Encrypt)
   - Configure nginx SSL termination
   - See [Deployment Guide](docs/deployment.md)

2. **Regular Backups:**
   - Set up automated backup cron jobs
   - Store backups off-site

3. **Monitoring:**
   - Set up external monitoring (Prometheus, Grafana)
   - Configure alerts for service failures

4. **Security:**
   - Restrict NMS access to management network only
   - Consider VPN or firewall rules
   - Plan for authentication implementation

### Getting Help

- **Documentation:** [README.md](../README.md), [docs/](../docs/)
- **Troubleshooting:** [docs/troubleshooting.md](docs/troubleshooting.md)
- **GitHub Issues:** https://github.com/YOUR_ORG/open5gs-nms/issues
- **Discussions:** https://github.com/YOUR_ORG/open5gs-nms/discussions

---

## Uninstallation

To completely remove the NMS:

```bash
# Stop and remove containers
cd /opt/open5gs-nms
docker compose down -v

# Remove images
docker rmi $(docker images -q '*open5gs-nms*')

# Remove installation directory
sudo rm -rf /opt/open5gs-nms

# Optional: Remove backups
sudo rm -rf /etc/open5gs/backups
```

**Note:** This does NOT remove Open5GS itself or MongoDB.

---

**Installation complete!** Access your NMS at `http://YOUR_SERVER_IP:8888`
