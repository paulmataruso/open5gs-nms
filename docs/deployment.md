# Production Deployment Guide

Guidelines for deploying Open5GS NMS in production environments.

---

## Table of Contents

1. [Production Checklist](#production-checklist)
2. [Security Hardening](#security-hardening)
3. [SSL/TLS Configuration](#ssltls-configuration)
4. [Network Security](#network-security)
5. [Backup Strategy](#backup-strategy)
6. [Monitoring and Logging](#monitoring-and-logging)
7. [High Availability](#high-availability)
8. [Performance Tuning](#performance-tuning)
9. [Maintenance](#maintenance)

---

## Production Checklist

Before deploying to production, verify:

### Infrastructure

- [ ] **Hardware meets recommended specs** (4+ cores, 8GB+ RAM, 50GB+ SSD)
- [ ] **Static IP address configured** or DHCP reservation in place
- [ ] **DNS resolution working** and stable
- [ ] **NTP time synchronization** configured and verified
- [ ] **Firewall rules** properly configured
- [ ] **Backup storage** configured (off-site recommended)

### Software

- [ ] **Ubuntu 24.04 LTS** (or 22.04 LTS) with latest updates
- [ ] **Docker Engine 24.0+** installed and tested
- [ ] **Docker Compose v2.20+** installed
- [ ] **Open5GS 2.7.0+** installed, configured, and tested
- [ ] **MongoDB 6.0+** installed with authentication enabled
- [ ] **SSL certificates** obtained (Let's Encrypt or commercial)

### Security

- [ ] **SSL/TLS enabled** for HTTPS access (set `COOKIE_SECURE=true` in `.env`)
- [ ] **Firewall configured** with minimal open ports
- [ ] **VPN or IP whitelist** for NMS access
- [ ] **MongoDB authentication** enabled
- [ ] **`FIRST_RUN_PASSWORD`** cleared from `.env` after first login
- [ ] **Strong admin password** set (not the auto-generated default)
- [ ] **Regular security updates** scheduled
- [ ] **Audit logging** enabled and monitored

### Operations

- [ ] **Automated backup** schedule configured
- [ ] **Monitoring system** in place (Prometheus, Grafana, etc.)
- [ ] **Alert notifications** configured (email, Slack, etc.)
- [ ] **Documentation** for your deployment
- [ ] **Disaster recovery plan** documented and tested
- [ ] **Change management process** defined
- [ ] **Support contact information** documented

---

## Security Hardening

### 1. Enable SSL/TLS

**Never run production without HTTPS!**

#### Option A: Let's Encrypt (Recommended)

```bash
# Install certbot
sudo apt install certbot

# Get certificate (standalone method)
sudo certbot certonly --standalone -d nms.yourdomain.com

# Certificates will be in:
# /etc/letsencrypt/live/nms.yourdomain.com/
```

#### Option B: Commercial Certificate

Purchase certificate from trusted CA and install according to their instructions.

#### Configure nginx for SSL

Edit `nginx/nginx.conf`:

```nginx
server {
    listen 443 ssl http2;
    server_name nms.yourdomain.com;
    
    # SSL Certificates
    ssl_certificate /etc/letsencrypt/live/nms.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/nms.yourdomain.com/privkey.pem;
    
    # SSL Configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    
    # HSTS
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    
    # Security Headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    
    # ... rest of config
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name nms.yourdomain.com;
    return 301 https://$server_name$request_uri;
}
```

Update `docker-compose.yml` to mount certificates:

```yaml
nginx:
  volumes:
    - ./nginx/nginx.conf:/etc/nginx/conf.d/nms.conf:ro
    - /etc/letsencrypt:/etc/letsencrypt:ro  # Add this line
```

### 2. MongoDB Authentication

Enable MongoDB authentication:

```bash
# Connect to MongoDB
mongo

# Create admin user
use admin
db.createUser({
  user: "admin",
  pwd: "STRONG_PASSWORD_HERE",
  roles: ["root"]
})

# Create NMS user
use open5gs
db.createUser({
  user: "nms",
  pwd: "ANOTHER_STRONG_PASSWORD",
  roles: [{role: "readWrite", db: "open5gs"}]
})

exit
```

Enable authentication in `/etc/mongod.conf`:

```yaml
security:
  authorization: enabled
```

Restart MongoDB:

```bash
sudo systemctl restart mongod
```

Update NMS MongoDB URI in `.env`:

```bash
MONGODB_URI=mongodb://nms:ANOTHER_STRONG_PASSWORD@127.0.0.1:27017/open5gs?authSource=open5gs
```

### 3. Container Security

Update `docker-compose.yml` for better security:

```yaml
backend:
  # Add security options
  security_opt:
    - no-new-privileges:true
  
  # Drop unnecessary capabilities (if possible)
  cap_drop:
    - ALL
  
  # Add only required capabilities
  cap_add:
    - SYS_ADMIN  # For systemctl
    - DAC_OVERRIDE  # For file access
  
  # Read-only root filesystem (if possible)
  # read_only: true  # May conflict with systemctl requirements
  
  # Resource limits
  mem_limit: 2g
  cpus: "2.0"
```

### 4. Environment Variables Security

Never commit `.env` file to git:

```bash
# Verify .env is in .gitignore
cat .gitignore | grep "^\.env$"

# Set proper permissions
chmod 600 .env

# Store backup of .env securely
# (encrypted storage, password manager, etc.)
```

### 5. Regular Security Updates

```bash
# Enable automatic security updates
sudo apt install unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades

# Manual updates
sudo apt update
sudo apt upgrade -y

# Update Docker images regularly
docker compose pull
docker compose up -d
```

---

## SSL/TLS Configuration

### Automatic Certificate Renewal

Let's Encrypt certificates expire every 90 days. Set up automatic renewal:

```bash
# Test renewal
sudo certbot renew --dry-run

# Add renewal to crontab
sudo crontab -e

# Add this line (runs daily at 3 AM):
0 3 * * * certbot renew --quiet --deploy-hook "docker compose -f /opt/open5gs-nms/docker-compose.yml restart nginx"
```

### SSL Best Practices

1. **Use TLS 1.2+ only** (disable TLS 1.0/1.1)
2. **Strong cipher suites** (no RC4, no 3DES)
3. **Enable HSTS** (HTTP Strict Transport Security)
4. **Certificate pinning** (optional, for high-security environments)
5. **Regular certificate monitoring** (expiry alerts)

### Test SSL Configuration

```bash
# Online tools:
# https://www.ssllabs.com/ssltest/
# Should achieve A or A+ rating

# Command line test:
openssl s_client -connect nms.yourdomain.com:443 -tls1_2
nmap --script ssl-enum-ciphers -p 443 nms.yourdomain.com
```

---

## Network Security

### Firewall Configuration

Use `ufw` (Uncomplicated Firewall):

```bash
# Enable firewall
sudo ufw enable

# Default policies
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Allow SSH (important! Don't lock yourself out)
sudo ufw allow 22/tcp

# Allow HTTPS only (no HTTP in production)
sudo ufw allow 443/tcp

# Allow HTTP only for Let's Encrypt challenges
# (or use DNS challenges instead)
sudo ufw allow 80/tcp

# Deny direct access to backend ports
sudo ufw deny 3001/tcp
sudo ufw deny 3002/tcp

# Check status
sudo ufw status numbered
```

### IP Whitelisting

Restrict access to specific IP addresses:

```bash
# Allow only from specific IP
sudo ufw allow from 192.168.1.0/24 to any port 443

# Or in nginx config:
location / {
    allow 192.168.1.0/24;
    allow 10.0.0.0/8;
    deny all;
    
    # ... rest of config
}
```

### VPN Access

For maximum security, require VPN access:

1. **Set up VPN server** (WireGuard, OpenVPN, etc.)
2. **Configure NMS to listen only on VPN interface**
3. **Firewall blocks all access except from VPN network**

Example nginx config for VPN-only access:

```nginx
server {
    listen 10.8.0.1:443 ssl;  # VPN IP only
    # ... rest of config
}
```

### Reverse Proxy with Authentication

Add an authentication layer before NMS:

```nginx
# Install apache2-utils for htpasswd
sudo apt install apache2-utils

# Create password file
sudo htpasswd -c /etc/nginx/.htpasswd admin

# Add to nginx config:
location / {
    auth_basic "NMS Admin Access";
    auth_basic_user_file /etc/nginx/.htpasswd;
    
    # ... proxy settings
}
```

---

## Backup Strategy

### Automated Backup Schedule

Create backup script `/usr/local/bin/nms-backup.sh`:

```bash
#!/bin/bash
set -e

BACKUP_DIR="/backup/open5gs-nms"
DATE=$(date +%Y-%m-%d-%H%M)

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Backup configs
cp -r /etc/open5gs/*.yaml "$BACKUP_DIR/config-$DATE/"

# Backup MongoDB
mongodump --db=open5gs --out="$BACKUP_DIR/mongodb-$DATE/"

# Backup NMS environment
cp /opt/open5gs-nms/.env "$BACKUP_DIR/env-$DATE"

# Create archive
tar czf "$BACKUP_DIR/complete-$DATE.tar.gz" \
    "$BACKUP_DIR/config-$DATE" \
    "$BACKUP_DIR/mongodb-$DATE" \
    "$BACKUP_DIR/env-$DATE"

# Clean up uncompressed backups
rm -rf "$BACKUP_DIR/config-$DATE" \
       "$BACKUP_DIR/mongodb-$DATE" \
       "$BACKUP_DIR/env-$DATE"

# Delete backups older than 30 days
find "$BACKUP_DIR" -name "complete-*.tar.gz" -mtime +30 -delete

# Upload to off-site storage (optional)
# aws s3 cp "$BACKUP_DIR/complete-$DATE.tar.gz" s3://my-bucket/backups/
# or rsync to remote server
```

Make executable:

```bash
sudo chmod +x /usr/local/bin/nms-backup.sh
```

Schedule via cron:

```bash
sudo crontab -e

# Daily backup at 2 AM
0 2 * * * /usr/local/bin/nms-backup.sh >> /var/log/nms-backup.log 2>&1
```

### Off-Site Backup

**Critical:** Always maintain off-site backups!

Options:
- **Cloud storage** (AWS S3, Google Cloud Storage, Azure Blob)
- **Remote server** (rsync over SSH)
- **NAS** (Network Attached Storage)
- **Backup service** (Backblaze, Wasabi, etc.)

Example rsync to remote server:

```bash
# Add to backup script
rsync -avz --delete \
    "$BACKUP_DIR/complete-$DATE.tar.gz" \
    user@backup-server:/backups/nms/
```

### Backup Testing

**Test your backups regularly!**

```bash
# Monthly backup restore test
# 1. Restore to test environment
# 2. Verify configs load correctly
# 3. Verify MongoDB data is intact
# 4. Verify services start successfully
# 5. Document any issues
```

---

## Monitoring and Logging

### System Monitoring

#### Option A: Prometheus + Grafana

Install Prometheus and Grafana for comprehensive monitoring.

**Metrics to monitor:**
- CPU usage
- Memory usage
- Disk usage and I/O
- Network traffic
- Docker container stats
- MongoDB performance
- Open5GS service status
- NMS API response times

#### Option B: Cloud Monitoring

Use cloud provider monitoring:
- AWS CloudWatch
- Google Cloud Monitoring
- Azure Monitor
- Datadog
- New Relic

### Log Aggregation

Centralize logs for easier troubleshooting:

```yaml
# docker-compose.yml
services:
  backend:
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
    
    # Or send to syslog
    logging:
      driver: "syslog"
      options:
        syslog-address: "tcp://log-server:514"
        tag: "nms-backend"
```

### Alert Configuration

Set up alerts for critical issues:

**Critical Alerts:**
- All Open5GS services down
- NMS backend crashed
- MongoDB connection failed
- Disk space < 10%
- CPU usage > 90% for 5+ minutes
- Memory usage > 90%

**Warning Alerts:**
- Any Open5GS service down
- Backup failed
- Certificate expiring in < 7 days
- Disk space < 20%

**Tools:**
- Prometheus Alertmanager
- CloudWatch Alarms
- PagerDuty
- Slack/Email notifications

---

## High Availability

### Load Balancing

For high-traffic deployments, use multiple NMS instances behind a load balancer:

```
            ┌─────────────┐
            │Load Balancer│
            │  (nginx)    │
            └──────┬──────┘
                   │
         ┌─────────┼─────────┐
         │         │         │
    ┌────▼───┐ ┌──▼────┐ ┌──▼────┐
    │ NMS #1 │ │NMS #2 │ │NMS #3 │
    └────┬───┘ └───┬───┘ └───┬───┘
         │         │         │
         └─────────┴─────────┘
                   │
            ┌──────▼──────┐
            │  MongoDB    │
            │  (Primary)  │
            └─────────────┘
```

### MongoDB Replica Set

For database high availability:

```bash
# Configure MongoDB replica set
# See MongoDB documentation for detailed setup
```

### Disaster Recovery

Document and test disaster recovery procedures:

1. **RTO (Recovery Time Objective)** - How quickly can you restore?
2. **RPO (Recovery Point Objective)** - How much data loss is acceptable?
3. **Failover procedures** - Step-by-step instructions
4. **Contact information** - Who to call for each scenario

---

## Performance Tuning

### System Optimization

```bash
# Increase file descriptor limits
sudo nano /etc/security/limits.conf
# Add:
* soft nofile 65536
* hard nofile 65536

# Optimize kernel parameters
sudo nano /etc/sysctl.conf
# Add:
net.core.somaxconn = 1024
net.ipv4.tcp_max_syn_backlog = 2048
vm.swappiness = 10

# Apply changes
sudo sysctl -p
```

### MongoDB Optimization

```javascript
// Create indexes for faster queries
use open5gs
db.subscribers.createIndex({imsi: 1}, {unique: true})
db.subscribers.createIndex({msisdn: 1})
```

### Docker Optimization

```yaml
# docker-compose.yml
services:
  backend:
    # Set resource limits
    mem_limit: 2g
    cpus: "2.0"
    
    # Optimize logging
    logging:
      options:
        max-size: "10m"
        max-file: "3"
```

### nginx Caching

```nginx
# nginx.conf
# Cache static assets
location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}
```

---

## Maintenance

### Regular Maintenance Schedule

**Daily:**
- Check service status
- Review critical alerts
- Monitor disk space

**Weekly:**
- Review logs for errors
- Check backup success
- Review security alerts
- Update monitoring dashboards

**Monthly:**
- Test backup restore
- Review and update documentation
- Check for software updates
- Review access logs
- Performance analysis

**Quarterly:**
- Disaster recovery drill
- Security audit
- Capacity planning review
- Documentation review

### Update Procedures

**Minor Updates (patches):**

```bash
cd /opt/open5gs-nms

# Backup first!
/usr/local/bin/nms-backup.sh

# Pull latest changes
git fetch
git checkout v1.0.1  # Or specific version

# Rebuild images
docker compose build

# Restart with new version
docker compose down
docker compose up -d

# Verify functionality
curl https://nms.yourdomain.com/api/health
```

**Major Updates (version changes):**

1. Review CHANGELOG.md for breaking changes
2. Test in staging environment first
3. Schedule maintenance window
4. Notify users
5. Create backup
6. Perform update
7. Verify all functionality
8. Monitor for issues

### Rollback Procedure

If update fails:

```bash
# Stop current version
docker compose down

# Checkout previous version
git checkout v1.0.0

# Rebuild
docker compose build

# Restore backup if needed
sudo cp /backup/open5gs-nms/config-TIMESTAMP/*.yaml /etc/open5gs/

# Start services
docker compose up -d

# Verify
curl https://nms.yourdomain.com/api/health
```

---

## Production Deployment Checklist

Final verification before going live:

### Pre-Deployment

- [ ] All requirements met (see [docs/requirements.md](requirements.md))
- [ ] SSL/TLS configured and tested
- [ ] Firewall configured and tested
- [ ] MongoDB authentication enabled
- [ ] VPN or IP whitelist configured
- [ ] Backup system configured and tested
- [ ] Monitoring configured and tested
- [ ] Alerts configured and tested
- [ ] Documentation complete
- [ ] Disaster recovery plan documented
- [ ] Staging environment tested successfully

### Deployment Day

- [ ] Announce maintenance window
- [ ] Create final backup of current state
- [ ] Deploy new installation
- [ ] Verify all services starting correctly
- [ ] Test critical functionality
- [ ] Monitor for errors (30 minutes minimum)
- [ ] Update documentation with actual IPs/URLs
- [ ] Notify users of completion

### Post-Deployment

- [ ] Monitor for 24 hours
- [ ] Review logs for errors
- [ ] Verify backups running
- [ ] Verify alerts working
- [ ] Document any issues encountered
- [ ] Schedule follow-up review (1 week)

---

## Support

For production deployment assistance:
- **GitHub Issues:** https://github.com/YOUR_ORG/open5gs-nms/issues
- **GitHub Discussions:** https://github.com/YOUR_ORG/open5gs-nms/discussions
- **Documentation:** [docs/](.)

**Remember:** Production deployments require careful planning and testing. When in doubt, test in a staging environment first!
