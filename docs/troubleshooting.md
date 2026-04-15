# Troubleshooting Guide

Common issues and solutions for Open5GS NMS deployment and operation.

---

## Table of Contents

1. [Installation Issues](#installation-issues)
2. [Docker Issues](#docker-issues)
3. [Backend Issues](#backend-issues)
4. [Frontend Issues](#frontend-issues)
5. [Configuration Issues](#configuration-issues)
6. [Service Management Issues](#service-management-issues)
7. [Network Issues](#network-issues)
8. [Performance Issues](#performance-issues)
9. [Database Issues](#database-issues)
10. [Getting More Help](#getting-more-help)

---

## Installation Issues

### Docker Build Fails with DNS Errors

**Symptom:**
```
npm error code EAI_AGAIN
npm error errno EAI_AGAIN
npm error request to https://registry.npmjs.org/ failed
```

**Cause:** Docker build containers cannot resolve DNS

**Solution:**
```bash
# Fix host DNS first
sudo nano /etc/resolv.conf
# Add these lines:
nameserver 8.8.8.8
nameserver 8.8.4.4
nameserver 1.1.1.1

# Restart systemd-resolved
sudo systemctl restart systemd-resolved

# Test DNS resolution
nslookup registry.npmjs.org

# The docker-compose.yml already uses network: host for builds
# Rebuild without cache:
docker compose build --no-cache
```

**Note:** The `docker-compose.yml` file includes `network: host` in build sections to use host DNS automatically.

---

### Port 8888 Already in Use

**Symptom:**
```
Error starting userland proxy: listen tcp4 0.0.0.0:8888: bind: address already in use
```

**Solution:**
```bash
# Find what's using port 8888
sudo netstat -tlnp | grep 8888
# or
sudo lsof -i :8888

# Option 1: Stop the conflicting service
sudo systemctl stop <service-name>

# Option 2: Change NMS port
# Edit docker-compose.yml or .env:
NGINX_PORT=8889  # Use different port

# Restart NMS
docker compose down
docker compose up -d
```

---

### Permission Denied Errors

**Symptom:**
```
permission denied while trying to connect to Docker daemon socket
```

**Solution:**
```bash
# Add user to docker group
sudo usermod -aG docker $USER

# Logout and login for changes to take effect
# Or use:
newgrp docker

# Verify
groups  # Should show 'docker' in the list
docker ps  # Should work without sudo
```

---

### Configuration Files Not Found

**Symptom:**
```
Error: ENOENT: no such file or directory, open '/etc/open5gs/nrf.yaml'
```

**Solution:**
```bash
# Verify Open5GS is installed
dpkg -l | grep open5gs

# Check config directory
ls -la /etc/open5gs/

# If configs don't exist, install Open5GS:
sudo add-apt-repository ppa:open5gs/latest
sudo apt update
sudo apt install open5gs

# Verify all 16 config files exist:
ls /etc/open5gs/*.yaml | wc -l  # Should show 16
```

---

## Docker Issues

### Container Won't Start

**Symptom:**
```
docker compose up
Container exited with code 1
```

**Diagnosis:**
```bash
# Check container logs
docker compose logs backend
docker compose logs frontend
docker compose logs nginx

# Check container status
docker compose ps
```

**Common Causes:**

1. **MongoDB not running:**
```bash
sudo systemctl status mongod
sudo systemctl start mongod
```

2. **Port conflict:**
```bash
sudo netstat -tlnp | grep -E '8888|3001|3002'
```

3. **Missing volumes:**
```bash
ls -la /etc/open5gs/
ls -la /var/log/open5gs/
```

---

### Containers Keep Restarting

**Symptom:**
```
docker compose ps
# Shows containers with "Restarting" status
```

**Solution:**
```bash
# Check restart logs
docker compose logs --tail=50 backend

# Common issues:
# 1. MongoDB connection failed
sudo systemctl status mongod

# 2. Config files not accessible
ls -la /etc/open5gs/

# 3. systemctl not working
docker exec open5gs-nms-backend systemctl --version
```

---

### Cannot Remove Containers

**Symptom:**
```
Error response from daemon: cannot remove container: container is running
```

**Solution:**
```bash
# Stop all containers first
docker compose down

# If that fails, force stop:
docker compose down --remove-orphans

# If still stuck, force remove:
docker rm -f open5gs-nms-backend open5gs-nms-frontend open5gs-nms-nginx

# Remove all project containers:
docker compose down --volumes --remove-orphans
```

---

## Backend Issues

### Backend Container Starts but API Doesn't Respond

**Symptom:**
- Container shows as "Up" in `docker compose ps`
- But `curl http://localhost:3001/api/health` fails

**Diagnosis:**
```bash
# Check backend logs
docker compose logs backend | tail -50

# Check if backend is listening
docker exec open5gs-nms-backend netstat -tlnp | grep 3001

# Test from inside container
docker exec open5gs-nms-backend curl http://localhost:3001/api/health
```

**Common Causes:**

1. **MongoDB not accessible:**
```bash
# From host
mongo --eval "db.adminCommand('ping')"

# Check MongoDB URI in backend
docker compose exec backend env | grep MONGODB_URI
```

2. **Backend crashed after start:**
```bash
docker compose logs backend
# Look for errors like:
# - "Cannot connect to MongoDB"
# - "EACCES: permission denied"
# - "MODULE_NOT_FOUND"
```

---

### systemctl Commands Don't Work in Container

**Symptom:**
```
Failed to connect to bus: No such file or directory
```

**Cause:** Container doesn't have proper systemd access

**Solution:**
```bash
# Verify privileged mode
docker inspect open5gs-nms-backend | grep Privileged
# Should show: "Privileged": true

# Verify pid mode
docker inspect open5gs-nms-backend | grep PidMode
# Should show: "PidMode": "host"

# Verify D-Bus socket is mounted
docker inspect open5gs-nms-backend | grep -A 5 Mounts | grep dbus

# If any are wrong, fix docker-compose.yml and restart:
docker compose down
docker compose up -d
```

---

### Configuration Apply Fails with Validation Errors

**Symptom:**
- Click "Apply Configuration"
- Get validation error message

**Diagnosis:**
Check the validation error details in the UI or logs:
```bash
docker compose logs backend | grep -i validation
```

**Common Issues:**

1. **Invalid IP address format:**
```
Address must be valid IPv4 or IPv6
Solution: Use format like "127.0.0.1" or "2001:db8::1"
```

2. **Invalid PLMN ID:**
```
MCC must be 3 digits, MNC must be 2-3 digits
Solution: MCC like "001", MNC like "01" or "001"
```

3. **Invalid port number:**
```
Port must be between 1-65535
Solution: Use valid port numbers only
```

4. **Missing required fields:**
```
Field 'address' is required
Solution: Fill in all required fields
```

---

### Configuration Apply Succeeds but Services Don't Restart

**Symptom:**
- Configuration apply shows success
- But services show as "inactive" or "failed"

**Diagnosis:**
```bash
# Check individual service status
systemctl status open5gs-nrfd
systemctl status open5gs-amfd

# Check service logs
journalctl -u open5gs-nrfd -n 50
journalctl -u open5gs-amfd -n 50

# Check backend logs for restart attempts
docker compose logs backend | grep restart
```

**Common Causes:**

1. **Invalid YAML syntax:**
```bash
# Validate YAML manually
cat /etc/open5gs/nrf.yaml | python3 -c "import yaml, sys; yaml.safe_load(sys.stdin)"
```

2. **Service dependency issues:**
```bash
# Restart in correct order manually:
sudo systemctl restart open5gs-nrfd
sleep 2
sudo systemctl restart open5gs-amfd
sudo systemctl restart open5gs-smfd
```

3. **Permission issues:**
```bash
ls -la /etc/open5gs/
# All files should be readable (644)
sudo chmod 644 /etc/open5gs/*.yaml
```

---

## Frontend Issues

### Web UI Won't Load

**Symptom:**
- Browser shows "Connection refused" or "Can't reach this page"

**Solution:**
```bash
# Check nginx container
docker compose ps nginx
docker compose logs nginx

# Check if port 8888 is accessible
curl http://localhost:8888
# Should return HTML

# Check firewall
sudo ufw status
sudo ufw allow 8888/tcp

# Check from browser on another machine
# If that fails, check host firewall
```

---

### Web UI Loads but Shows Blank Page

**Symptom:**
- Page loads but shows white/blank screen
- Browser console shows JavaScript errors

**Diagnosis:**
Open browser Developer Tools (F12) and check Console tab

**Common Causes:**

1. **API not accessible:**
```javascript
// Console shows:
Failed to load resource: net::ERR_CONNECTION_REFUSED
http://localhost:3001/api/config/all
```
```bash
# Solution: Check backend is running
docker compose ps backend
curl http://localhost:3001/api/health
```

2. **CORS errors:**
```javascript
// Console shows:
Access to XMLHttpRequest blocked by CORS policy
```
```bash
# Check backend CORS configuration
docker compose logs backend | grep -i cors
```

3. **WebSocket connection fails:**
```javascript
// Console shows:
WebSocket connection failed
```
```bash
# Check WebSocket server
docker compose logs backend | grep -i websocket

# Verify WebSocket port
docker compose exec backend netstat -tlnp | grep 3002
```

---

### Features Not Working (Buttons Don't Respond)

**Symptom:**
- UI loads correctly
- But clicking buttons doesn't do anything

**Diagnosis:**
```javascript
// Open browser console (F12)
// Look for errors when clicking buttons
```

**Common Causes:**

1. **API endpoint returns errors:**
```bash
# Check backend logs when clicking button
docker compose logs -f backend
# Then click the button and watch for errors
```

2. **JavaScript errors:**
```javascript
// Browser console shows:
Uncaught TypeError: Cannot read property 'x' of undefined
```
```bash
# This might be a bug, check GitHub issues
# Or report a new issue with steps to reproduce
```

---

## Configuration Issues

### Changes Not Persisted After Container Restart

**Symptom:**
- Make configuration changes
- Restart container
- Changes are gone

**Cause:** Configurations not saved to host filesystem

**Solution:**
```bash
# Verify volume mount
docker inspect open5gs-nms-backend | grep -A 10 Mounts | grep open5gs

# Should show:
# "Source": "/etc/open5gs"
# "Destination": "/etc/open5gs"

# If mount is missing, fix docker-compose.yml
# Then rebuild:
docker compose down
docker compose up -d
```

---

### Backup Creation Fails

**Symptom:**
- Click "Create Backup"
- Get error message

**Diagnosis:**
```bash
# Check backup directory exists and is writable
ls -la /etc/open5gs/backups/
sudo mkdir -p /etc/open5gs/backups/config
sudo mkdir -p /etc/open5gs/backups/mongodb
sudo chmod 755 /etc/open5gs/backups

# Check disk space
df -h /etc/open5gs
```

---

### Restore from Backup Fails

**Symptom:**
- Click "Restore"
- Services don't restart or fail to start

**Diagnosis:**
```bash
# Check backup files exist
ls -la /etc/open5gs/backups/config/<timestamp>/

# Verify backup content
cat /etc/open5gs/backups/config/<timestamp>/nrf.yaml

# Check service logs after restore
journalctl -u open5gs-nrfd -n 50
```

**Solution:**
```bash
# Manual restore if automatic fails:
sudo cp /etc/open5gs/backups/config/<timestamp>/*.yaml /etc/open5gs/
sudo systemctl restart open5gs-nrfd
sudo systemctl restart open5gs-amfd
# ... restart all services
```

---

## Service Management Issues

### Services Show as "Unknown" Status

**Symptom:**
- Services page shows all services as "Unknown"
- Or services show incorrect status

**Diagnosis:**
```bash
# Test systemctl from container
docker exec open5gs-nms-backend systemctl status open5gs-nrfd

# If that fails:
# Check privileged mode
docker inspect open5gs-nms-backend | grep Privileged

# Check systemctl mount
docker inspect open5gs-nms-backend | grep systemctl
```

**Solution:**
```bash
# Ensure proper Docker configuration in docker-compose.yml:
# - privileged: true
# - pid: host
# - volume mount for systemctl

# Restart backend
docker compose restart backend
```

---

### Service Restart Takes Too Long

**Symptom:**
- Click "Restart"
- Operation times out or takes minutes

**Cause:** Service has dependency issues or is hung

**Diagnosis:**
```bash
# Check if service is actually stopping
systemctl status open5gs-amfd

# Check for hung processes
ps aux | grep open5gs

# Check service logs
journalctl -u open5gs-amfd -n 100
```

**Solution:**
```bash
# Force stop the service
sudo systemctl stop open5gs-amfd
sudo killall -9 open5gs-amfd  # If stop doesn't work

# Then start fresh
sudo systemctl start open5gs-amfd
```

---

### Bulk Restart Fails for Some Services

**Symptom:**
- Click "Restart All"
- Some services restart successfully, others fail

**Cause:** Service dependency order not respected

**Solution:**
The NMS already restarts in dependency order. If this fails:

```bash
# Manual restart in correct order:
sudo systemctl restart open5gs-nrfd
sleep 2
sudo systemctl restart open5gs-scp open5gs-udr
sleep 2
sudo systemctl restart open5gs-udm open5gs-ausf
sleep 2
sudo systemctl restart open5gs-pcf open5gs-nssf open5gs-bsf
sleep 2
sudo systemctl restart open5gs-amf
sleep 2
sudo systemctl restart open5gs-smf
sleep 2
sudo systemctl restart open5gs-upf
sleep 2
sudo systemctl restart open5gs-mme open5gs-hss open5gs-pcrf open5gs-sgwc open5gs-sgwu
```

---

## Network Issues

### WebSocket Connection Keeps Dropping

**Symptom:**
- Real-time updates stop working
- Service status doesn't update
- Logs don't stream

**Diagnosis:**
```javascript
// Check browser console (F12)
// Look for WebSocket errors:
WebSocket connection to 'ws://...' failed
```

**Causes:**

1. **Proxy timeout:**
```nginx
# nginx config needs longer timeout
# Check nginx/nginx.conf
proxy_read_timeout 3600s;
```

2. **Firewall blocking WebSocket:**
```bash
# Ensure firewall allows WebSocket upgrade
sudo ufw allow 8888/tcp
```

3. **Backend WebSocket server crashed:**
```bash
docker compose logs backend | grep -i websocket
docker compose restart backend
```

---

### Cannot Access NMS from Other Machines

**Symptom:**
- NMS works on localhost
- But can't access from other computers on network

**Solution:**
```bash
# Check nginx is listening on all interfaces
docker compose exec nginx netstat -tlnp | grep 8888
# Should show 0.0.0.0:8888 not 127.0.0.1:8888

# Check host firewall
sudo ufw status
sudo ufw allow from 192.168.1.0/24 to any port 8888

# Check if Docker uses host networking
docker inspect open5gs-nms-nginx | grep NetworkMode
# Should show: "NetworkMode": "host"
```

---

## Performance Issues

### NMS UI is Slow/Laggy

**Symptoms:**
- Pages take long to load
- Buttons slow to respond
- Scrolling is choppy

**Solutions:**

1. **Check CPU/Memory usage:**
```bash
docker stats
top
```

2. **Check if backend is overwhelmed:**
```bash
docker compose logs backend | grep -i error
```

3. **Reduce polling frequency:**
```bash
# Edit environment variable (future feature)
# Or restart with lower load
```

4. **Clear browser cache:**
```
Browser Settings → Clear browsing data
```

---

### Service Status Updates Are Slow

**Symptom:**
- Services page takes 10+ seconds to update status

**Cause:** systemctl is slow to query status

**Solution:**
```bash
# Check systemctl performance on host
time systemctl status open5gs-nrfd
# Should be < 1 second

# If slow, check systemd journal size
journalctl --disk-usage
# If > 1GB, clean old logs:
sudo journalctl --vacuum-time=7d
```

---

### Configuration Apply Takes Too Long

**Symptom:**
- Apply operation takes > 30 seconds

**Cause:** Service restarts are slow

**Diagnosis:**
```bash
# Time individual service restart
time sudo systemctl restart open5gs-nrfd
# Should be < 5 seconds

# Check service logs for startup issues
journalctl -u open5gs-nrfd -n 50
```

---

## Database Issues

### MongoDB Connection Errors

**Symptom:**
```
MongoServerError: connect ECONNREFUSED 127.0.0.1:27017
```

**Solution:**
```bash
# Check MongoDB is running
sudo systemctl status mongod

# If not running:
sudo systemctl start mongod
sudo systemctl enable mongod

# Verify MongoDB is listening
sudo netstat -tlnp | grep 27017

# Test connection
mongo --eval "db.adminCommand('ping')"
```

---

### Subscriber Creation Fails

**Symptom:**
- Create subscriber in UI
- Get error message

**Common Causes:**

1. **Duplicate IMSI:**
```bash
# Check if IMSI already exists
mongo open5gs --eval "db.subscribers.findOne({imsi: '001010000000001'})"

# Delete duplicate if needed
mongo open5gs --eval "db.subscribers.deleteOne({imsi: '001010000000001'})"
```

2. **Invalid subscriber data:**
```bash
# Check backend logs for validation errors
docker compose logs backend | grep -i subscriber | tail -20
```

3. **MongoDB disk space full:**
```bash
df -h /var/lib/mongodb
# If full, clean up or add more space
```

---

### MongoDB Backup Fails

**Symptom:**
- Click "Create Backup"
- MongoDB backup portion fails

**Solution:**
```bash
# Verify mongodump is available
which mongodump

# If not installed:
sudo apt install mongodb-database-tools

# Verify backup directory
sudo mkdir -p /etc/open5gs/backups/mongodb
sudo chmod 755 /etc/open5gs/backups/mongodb

# Test manual backup
mongodump --db=open5gs --out=/tmp/test_backup
```

---

## Docker Logging Issues

### Docker Container Logs Not Showing in UI

**Symptom:**
- Switch to "Docker Containers" log source
- Container list is empty or containers don't appear

**Diagnosis:**
```bash
# Check if containers are running
docker compose ps

# Verify container names match filter
docker ps --filter "name=open5gs-nms"

# Check if backend can access Docker socket
docker exec open5gs-nms-backend docker ps
```

**Solution:**
```bash
# Ensure Docker socket is mounted
# Check docker-compose.yml for backend service:
# volumes:
#   - /var/run/docker.sock:/var/run/docker.sock:ro

# Restart backend container
docker compose restart backend

# Verify socket permissions
ls -la /var/run/docker.sock
# Should be accessible by docker group

# If permission denied, ensure container can access socket
sudo chmod 666 /var/run/docker.sock  # Temporary fix
# OR add backend container to docker group (preferred)
```

---

### Docker Logs Stream Disconnects Frequently

**Symptom:**
- Docker container logs stop streaming after a few seconds
- Connection drops repeatedly

**Diagnosis:**
```bash
# Check backend logs for docker process errors
docker compose logs backend | grep -i "docker logs"

# Check if docker logs command is timing out
docker logs -f --tail 10 open5gs-nms-backend
# If this hangs or fails, docker daemon may have issues
```

**Solution:**
```bash
# Restart Docker daemon
sudo systemctl restart docker

# Reduce log verbosity if logs are overwhelming
# Edit docker-compose.yml logging section:
# logging:
#   options:
#     max-size: "10m"  # Reduce from 50m

# Clear old container logs
docker compose down
docker system prune -a --volumes  # WARNING: removes unused data
docker compose up -d
```

---

### Verbose Docker Logging Not Working

**Symptom:**
- `docker compose up` output doesn't show timestamps
- Logs are not verbose enough

**Solution:**
```bash
# Verify logging configuration in docker-compose.yml
# Each service should have:
# logging:
#   driver: "json-file"
#   options:
#     max-size: "50m"
#     max-file: "5"
#     labels: "service,container"

# Rebuild containers with new logging config
docker compose down
docker compose up --build

# View logs with timestamps
docker compose logs -f --timestamps

# Or view specific container
docker logs -f --timestamps open5gs-nms-backend
```

---

### Docker Socket Permission Denied

**Symptom:**
```
Error: Cannot connect to the Docker daemon at unix:///var/run/docker.sock
permission denied
```

**Solution:**
```bash
# Option 1: Add current user to docker group (host level)
sudo usermod -aG docker $USER
# Logout and login for changes to take effect

# Option 2: Ensure backend container mounts socket correctly
# In docker-compose.yml:
# volumes:
#   - /var/run/docker.sock:/var/run/docker.sock:ro

# Option 3: Temporary permission fix (not recommended for production)
sudo chmod 666 /var/run/docker.sock

# Verify socket is accessible
ls -la /var/run/docker.sock
# Should show: srw-rw---- 1 root docker
```

---

## Getting More Help

### Collecting Diagnostic Information

When reporting issues, include:

```bash
# System information
uname -a
lsb_release -a

# Docker versions
docker --version
docker compose version

# Open5GS version
dpkg -l | grep open5gs

# Container status
docker compose ps

# Recent logs
docker compose logs --tail=100 backend > backend.log
docker compose logs --tail=100 frontend > frontend.log
docker compose logs --tail=100 nginx > nginx.log

# Service status
systemctl status open5gs-* > services.log

# MongoDB status
mongo --eval "db.adminCommand('ping')" > mongo.log 2>&1
```

### Getting Support

- **Documentation:** Check [docs/](.) directory
- **GitHub Issues:** https://github.com/YOUR_ORG/open5gs-nms/issues
- **GitHub Discussions:** https://github.com/YOUR_ORG/open5gs-nms/discussions
- **Open5GS Forum:** https://open5gs.org/open5gs/forum/

### Reporting Bugs

Use the bug report template:
https://github.com/YOUR_ORG/open5gs-nms/issues/new?template=bug_report.md

Include:
- Steps to reproduce
- Expected behavior
- Actual behavior
- Screenshots (if applicable)
- Log files (from above diagnostic commands)
- Environment details (OS, versions, etc.)

---

## Emergency Procedures

### Complete Reset

If everything is broken and you want to start fresh:

```bash
# WARNING: This will delete all data and configurations

# Stop and remove all containers
docker compose down --volumes --remove-orphans

# Remove all images
docker rmi $(docker images -q '*open5gs-nms*')

# Remove all NMS data (but preserve Open5GS configs)
sudo rm -rf /etc/open5gs/backups/*
# Do NOT delete /etc/open5gs/*.yaml

# Reinstall from scratch
git pull
docker compose build --no-cache
docker compose up -d
```

### Restore from Backup

If you need to restore to a known good state:

```bash
# List available backups
ls -la /etc/open5gs/backups/config/

# Restore configs
sudo cp /etc/open5gs/backups/config/YYYY-MM-DD-HHMM/*.yaml /etc/open5gs/

# Restore MongoDB
mongorestore --db=open5gs --drop /etc/open5gs/backups/mongodb/YYYY-MM-DD-HHMM/open5gs/

# Restart all services
sudo systemctl restart open5gs-*

# Restart NMS
docker compose restart
```

---

**Still having issues?** Open an issue on GitHub with detailed information and we'll help you troubleshoot!
