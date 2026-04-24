# Open5GS NMS — API Reference

Complete reference for all HTTP REST endpoints exposed by the backend on port `3001` (proxied through nginx on port `8888` at `/api/*`).

All endpoints except `/api/health`, `POST /api/auth/login` require a valid session cookie (`nms_session`). Unauthenticated requests return `401`.

Base URL (via nginx proxy): `http://YOUR_SERVER:8888/api`  
Base URL (direct backend): `http://YOUR_SERVER:3001/api`

---

## Table of Contents

1. [Health](#health)
2. [Authentication](#authentication)
3. [Users](#users)
4. [Configuration](#configuration)
5. [Services](#services)
6. [Subscribers](#subscribers)
7. [Interface Status](#interface-status)
8. [Backup & Restore](#backup--restore)
9. [Auto-Config](#auto-config)
10. [SUCI Keys](#suci-keys)
11. [Audit Log](#audit-log)
12. [Docker](#docker)
13. [WebSocket](#websocket)

---

## Health

### `GET /api/health`

Public endpoint. No authentication required. Used by Docker healthcheck.

**Response `200`**
```json
{
  "status": "ok",
  "timestamp": "2026-04-22T22:00:00.000Z",
  "wsConnections": 3
}
```

---

## Authentication

### `POST /api/auth/login`

Public endpoint. Rate-limited to **10 attempts per 15 minutes per IP** (failed attempts only).

**Request body**
```json
{
  "username": "admin",
  "password": "your-password"
}
```

**Response `200`** — Sets `nms_session` HttpOnly cookie.
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "abc123",
      "username": "admin",
      "role": "admin"
    }
  }
}
```

**Response `401`**
```json
{ "success": false, "error": "Invalid username or password" }
```

**Response `429`**
```json
{ "success": false, "error": "Too many login attempts, please try again later" }
```

---

### `POST /api/auth/logout`

Requires valid session. Invalidates the session and clears the cookie.

**Response `200`**
```json
{ "success": true }
```

---

### `GET /api/auth/me`

Returns the currently authenticated user.

**Response `200`**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "abc123",
      "username": "admin",
      "role": "admin"
    }
  }
}
```

---

## Users

### `GET /api/users`

List all NMS users.

**Response `200`**
```json
{
  "success": true,
  "data": {
    "users": [
      {
        "id": "abc123",
        "username": "admin",
        "role": "admin",
        "createdAt": "2026-04-01T00:00:00.000Z",
        "lastLoginAt": "2026-04-22T22:00:00.000Z"
      }
    ]
  }
}
```

---

### `POST /api/users`

Create a new NMS user.

**Request body**
```json
{
  "username": "operator1",
  "password": "SecurePass123!"
}
```

**Response `201`**
```json
{
  "success": true,
  "data": {
    "user": { "id": "def456", "username": "operator1", "role": "admin" }
  }
}
```

**Response `409`** — Username already exists.

**Response `400`** — Weak password or invalid username.

---

### `PUT /api/users/:id/password`

Change a user's password.

**URL params:** `id` — user ID string

**Request body**
```json
{ "password": "NewSecurePass456!" }
```

**Response `200`**
```json
{ "success": true }
```

**Response `404`** — User not found.

**Response `400`** — Weak password.

---

### `DELETE /api/users/:id`

Delete a user. Cannot delete yourself or the last remaining user.

**URL params:** `id` — user ID string

**Response `200`**
```json
{ "success": true }
```

**Response `400`** — Cannot delete self / cannot delete last user.

**Response `404`** — User not found.

---

## Configuration

Valid service names for all config endpoints:

`nrf` `scp` `amf` `smf` `upf` `ausf` `udm` `udr` `pcf` `nssf` `bsf` `mme` `hss` `pcrf` `sgwc` `sgwu`

---

### `GET /api/config`

Load all 16 NF configurations at once.

**Response `200`**
```json
{
  "success": true,
  "data": {
    "nrf": { ... },
    "amf": { ... },
    "smf": { ... },
    "..." : "..."
  }
}
```

---

### `GET /api/config/:service`

Load a single NF configuration.

**URL params:** `service` — one of the 16 valid service names

**Response `200`**
```json
{
  "success": true,
  "data": {
    "sbi": { "server": [{ "address": "10.0.1.155", "port": 7777 }] },
    "ngap": { "server": [{ "address": "10.0.1.155" }] },
    "rawYaml": { ... }
  }
}
```

**Response `400`** — Invalid service name.

---

### `POST /api/config/validate`

Validate all current on-disk configurations against Zod schemas without applying anything.

**Response `200`**
```json
{
  "success": true,
  "data": {
    "valid": true,
    "errors": []
  }
}
```

---

### `POST /api/config/apply`

Apply configuration changes to all NF YAML files. Automatically backs up current config first, restarts affected services in dependency order, and rolls back on failure. Also regenerates and live-reloads `prometheus.yml`.

**Request body** — Full configs object (same shape as `GET /api/config` response `data`)
```json
{
  "amf": { "rawYaml": { ... } },
  "smf": { "rawYaml": { ... } },
  "..."
}
```

**Response `200`**
```json
{
  "success": true,
  "data": {
    "success": true,
    "rollback": false,
    "backupCreated": "/etc/open5gs/backups/backup-2026-04-22T22-00-00",
    "restartedServices": ["open5gs-amfd", "open5gs-smfd"],
    "errors": [],
    "prometheusReloaded": true,
    "prometheusReloadError": null
  }
}
```

---

### `GET /api/config/topology/graph`

Returns node data for all 16 NFs including their addresses, ports, and current active status. Used by the topology page.

**Response `200`**
```json
{
  "success": true,
  "data": {
    "nodes": [
      { "id": "amf", "address": "10.0.1.155", "port": 7777, "active": true },
      { "id": "smf", "address": "10.0.1.155", "port": 7777, "active": true }
    ],
    "edges": []
  }
}
```

---

### `POST /api/config/sync-sd`

Sync a Slice Differentiator (SD) value across SMF config and all matching subscriber slices in MongoDB.

**Request body**
```json
{
  "sd": "000001",
  "sst": 1
}
```

**Response `200`**
```json
{
  "success": true,
  "data": {
    "smfUpdated": true,
    "subscribersUpdated": 12
  }
}
```

**Response `400`** — SD value is required.

---

## Services

Valid service names: `nrf` `scp` `amf` `smf` `upf` `ausf` `udm` `udr` `pcf` `nssf` `bsf` `mme` `hss` `pcrf` `sgwc` `sgwu`

Valid actions for single service: `start` `stop` `restart` `enable` `disable`

Valid actions for bulk: `start` `stop` `restart`

---

### `GET /api/services`

Get status of all 16 Open5GS services.

**Response `200`**
```json
{
  "success": true,
  "data": [
    {
      "name": "amf",
      "active": true,
      "enabled": true,
      "description": "open5gs-amfd.service",
      "subState": "running"
    }
  ]
}
```

---

### `GET /api/services/:name`

Get status of a single service.

**URL params:** `name` — service name

**Response `200`**
```json
{
  "success": true,
  "data": {
    "name": "amf",
    "active": true,
    "enabled": true,
    "subState": "running"
  }
}
```

**Response `400`** — Invalid service name.

---

### `POST /api/services/:name/:action`

Execute an action on a single service.

**URL params:** `name` — service name, `action` — one of `start` `stop` `restart` `enable` `disable`

**Response `200`**
```json
{ "success": true, "message": "Service amf restarted successfully" }
```

**Response `400`** — Invalid service name or action.

---

### `POST /api/services/all/:action`

Execute an action across all 16 services at once.

**URL params:** `action` — one of `start` `stop` `restart`

**Response `200`**
```json
{
  "success": true,
  "results": [
    { "service": "nrf", "success": true, "message": "Started" },
    { "service": "amf", "success": true, "message": "Started" }
  ]
}
```

---

## Subscribers

### `GET /api/subscribers`

List subscribers with optional pagination and search.

**Query params**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `skip` | number | `0` | Records to skip (pagination offset) |
| `limit` | number | `50` | Max records to return |
| `search` | string | — | Filter by IMSI (partial match) |

**Response `200`**
```json
{
  "subscribers": [
    {
      "imsi": "999700000053555",
      "msisdn": [],
      "imeisv": [],
      "slice": [...]
    }
  ],
  "total": 42
}
```

---

### `GET /api/subscribers/ip-assignments`

Get the current static IP assignments for all subscribers that have one configured.

**Response `200`**
```json
{
  "success": true,
  "data": [
    { "imsi": "999700000053555", "ipv4": "10.45.0.100" }
  ]
}
```

---

### `GET /api/subscribers/:imsi`

Get a single subscriber by IMSI.

**URL params:** `imsi` — 15-digit IMSI string

**Response `200`** — Full subscriber document from MongoDB.

**Response `404`** — Subscriber not found.

---

### `POST /api/subscribers`

Create a new subscriber.

**Request body** — Open5GS subscriber document
```json
{
  "imsi": "999700000053556",
  "security": {
    "k": "465B5CE8B199B49FAA5F0A2EE238A6BC",
    "opc": "E8ED289DEBA952E4283B54E88E6183CA",
    "amf": "8000"
  },
  "slice": [
    {
      "sst": 1,
      "session": [
        {
          "name": "internet",
          "type": 3,
          "qos": { "index": 9, "arp": { "priority_level": 8 } },
          "ambr": { "downlink": { "value": 1, "unit": 3 }, "uplink": { "value": 1, "unit": 3 } }
        }
      ]
    }
  ]
}
```

**Response `201`**
```json
{ "message": "Created" }
```

**Response `400`** — Validation error (e.g. duplicate IMSI, invalid key format).

---

### `PUT /api/subscribers/:imsi`

Update an existing subscriber.

**URL params:** `imsi` — 15-digit IMSI string

**Request body** — Same shape as `POST /api/subscribers`

**Response `200`**
```json
{ "message": "Updated" }
```

**Response `400`** — Validation error.

---

### `DELETE /api/subscribers/:imsi`

Delete a subscriber.

**URL params:** `imsi` — 15-digit IMSI string

**Response `200`**
```json
{ "message": "Deleted" }
```

---

### `POST /api/subscribers/auto-assign-ips`

Auto-assign sequential static IPv4 addresses from the session pool to all subscribers that do not already have one.

**Response `200`**
```json
{
  "success": true,
  "data": {
    "assigned": 5,
    "skipped": 12,
    "errors": []
  }
}
```

---

## Interface Status

### `GET /api/interface-status`

Returns live RAN interface status and active UE sessions. Runs netstat (N2, S1-MME), conntrack (S1-U, 4G sessions), and tshark (N3, 5G sessions) on the host.

**Response `200`**
```json
{
  "s1mme": {
    "active": true,
    "connectedEnodebs": ["10.0.1.100", "10.0.1.101", "10.0.1.102"]
  },
  "s1u": {
    "active": true,
    "connectedEnodebs": ["10.0.1.100", "10.0.1.101"]
  },
  "n2": {
    "active": true,
    "connectedGnodebs": ["10.0.1.48", "172.16.1.67"]
  },
  "n3": {
    "active": true,
    "connectedGnodebs": ["172.16.1.67"]
  },
  "activeUEs4G": [
    { "ip": "10.45.0.100", "imsi": "999700000053555" }
  ],
  "activeUEs5G": [
    { "ip": "10.45.0.102", "imsi": "999702959493689" }
  ]
}
```

**Detection methods:**

| Field | Method | Bound to |
|-------|--------|----------|
| `s1mme` | `netstat -an`, SCTP port 36412 | MME IP from `mme.yaml` |
| `s1u` | `conntrack` UDP/2152, `dst=<sgwu-ip>` | SGW-U IP from `sgwu.yaml` |
| `n2` | `netstat -an`, SCTP port 38412 | AMF NGAP IP from `amf.yaml` |
| `n3` | `tshark` UDP/2152, `host <upf-ip>` | UPF GTP-U IP from `upf.yaml` |
| `activeUEs4G` | `conntrack` + MongoDB correlation | Session pool subnets |
| `activeUEs5G` | `tshark` inner GTP + MongoDB correlation | UPF GTP-U IP from `upf.yaml` |

---

## Backup & Restore

### `GET /api/backup/list`

List all available backups.

**Response `200`**
```json
{
  "mongoBackups": [
    { "name": "mongo-backup-2026-04-22T22-00-00", "timestamp": "2026-04-22T22:00:00.000Z", "type": "mongodb" }
  ],
  "configBackups": [
    { "name": "config-backup-2026-04-22T22-00-00", "timestamp": "2026-04-22T22:00:00.000Z", "type": "config" }
  ]
}
```

---

### `POST /api/backup/config`

Create a manual config backup of all 16 YAML files immediately.

**Response `200`**
```json
{ "success": true, "backupName": "config-backup-2026-04-22T22-00-00" }
```

---

### `POST /api/backup/mongo`

Create a manual MongoDB backup using `mongodump`.

**Response `200`**
```json
{ "success": true, "backupName": "mongo-backup-2026-04-22T22-00-00" }
```

---

### `POST /api/backup/restore/config`

Restore all config files from a named config backup.

**Request body**
```json
{ "backupName": "config-backup-2026-04-22T22-00-00" }
```

**Response `200`**
```json
{ "success": true, "restoredFiles": ["amf.yaml", "smf.yaml", "..."] }
```

---

### `POST /api/backup/restore/mongo`

Restore MongoDB subscriber database from a named backup using `mongorestore`.

**Request body**
```json
{ "backupName": "mongo-backup-2026-04-22T22-00-00" }
```

**Response `200`**
```json
{ "success": true }
```

---

### `POST /api/backup/restore/both`

Restore both config and MongoDB in one operation.

**Request body**
```json
{
  "configBackupName": "config-backup-2026-04-22T22-00-00",
  "mongoBackupName": "mongo-backup-2026-04-22T22-00-00"
}
```

**Response `200`**
```json
{ "success": true, "configRestored": true, "mongoRestored": true, "errors": [] }
```

---

### `POST /api/backup/restore/selective`

Restore only specific NF config files from a backup, leaving others untouched.

**Request body**
```json
{
  "backupName": "config-backup-2026-04-22T22-00-00",
  "services": ["amf", "smf", "upf"]
}
```

**Response `200`**
```json
{ "success": true, "restored": ["amf.yaml", "smf.yaml", "upf.yaml"], "errors": {} }
```

---

### `POST /api/backup/diff`

Get a unified diff showing what changed between a backup and the current on-disk config.

**Request body**
```json
{ "backupName": "config-backup-2026-04-22T22-00-00" }
```

**Response `200`**
```json
{
  "success": true,
  "diffs": {
    "amf": "--- amf.yaml\n+++ amf.yaml\n@@ -10,7 +10,7 @@\n ...",
    "smf": ""
  }
}
```

---

### `GET /api/backup/last-config`

Get the name of the most recent config backup (useful for the auto-rollback display).

**Response `200`**
```json
{ "backupName": "config-backup-2026-04-22T22-00-00" }
```

---

### `GET /api/backup/settings`

Get current backup retention settings.

**Response `200`**
```json
{ "configBackupsToKeep": 10, "mongoBackupsToKeep": 5 }
```

---

### `PUT /api/backup/settings`

Update backup retention settings and immediately apply cleanup.

**Request body**
```json
{ "configBackupsToKeep": 10, "mongoBackupsToKeep": 5 }
```

**Response `200`**
```json
{ "configBackupsToKeep": 10, "mongoBackupsToKeep": 5 }
```

**Response `400`** — Retention values must be at least 1.

---

### `POST /api/backup/cleanup`

Manually trigger backup cleanup to enforce retention limits.

**Request body** (optional — defaults used if omitted)
```json
{ "configBackupsToKeep": 10, "mongoBackupsToKeep": 5 }
```

**Response `200`**
```json
{ "success": true }
```

---

### `POST /api/backup/restore-defaults`

Restore all 16 NF YAML configs to factory defaults (bundled with the NMS). Creates a backup of the current state first.

**Response `200`**
```json
{
  "success": true,
  "message": "Factory defaults restored. Backup created at /etc/open5gs/backups/...",
  "backupCreated": "/etc/open5gs/backups/pre-restore-defaults-2026-04-22T22-00-00"
}
```

---

## Auto-Config

### `POST /api/auto-config/preview`

Generate a YAML diff preview of what the auto-config wizard would change without actually applying anything.

**Request body**
```json
{
  "plmn4g": [{ "mcc": "999", "mnc": "70", "mme_gid": 2, "mme_code": 1, "tac": 1 }],
  "plmn5g": [{ "mcc": "999", "mnc": "70", "tac": 1 }],
  "s1mmeIP": "10.0.1.175",
  "sgwuGtpIP": "10.0.1.175",
  "amfNgapIP": "10.0.1.155",
  "upfGtpIP": "10.0.1.155",
  "sessionPoolIPv4Subnet": "10.45.0.0/16",
  "sessionPoolIPv4Gateway": "10.45.0.1",
  "sessionPoolIPv6Subnet": "2001:db8:cafe::/48",
  "sessionPoolIPv6Gateway": "2001:db8:cafe::1",
  "configureNAT": false
}
```

**Response `200`**
```json
{
  "success": true,
  "diffs": {
    "mme": "--- mme.yaml\n+++ mme.yaml\n@@ ...",
    "amf": "--- amf.yaml\n+++ amf.yaml\n@@ ...",
    "sgwu": "",
    "upf": "",
    "smf": ""
  }
}
```

---

### `POST /api/auto-config/apply`

Apply the auto-configuration wizard. Backs up current configs, writes MME, SGW-U, AMF, UPF, SMF YAML files, optionally configures NAT (persistent via `netfilter-persistent save`), then restarts affected services.

**Request body** — Same shape as `POST /api/auto-config/preview` plus optional NAT fields:

```json
{
  "...": "...(same as preview)...",
  "configureNAT": true,
  "natInterface": "ogstun"
}
```

**Response `200`**
```json
{
  "success": true,
  "message": "Auto-configuration applied successfully. Services restarted.",
  "backupCreated": "/etc/open5gs/backups/pre-autoconfig-2026-04-22T22-00-00",
  "updatedFiles": ["mme.yaml", "sgwu.yaml", "amf.yaml", "upf.yaml", "smf.yaml"]
}
```

---

## SUCI Keys

### `GET /api/suci/keys`

List all SUCI home network public/private keypairs.

**Response `200`**
```json
[
  {
    "id": 1,
    "scheme": 1,
    "publicKey": "5a8d38864820197c3394b92613b20b91633cbd897119273bf8e4a6f4eec0a650",
    "privateKey": "c80949f13ebe...",
    "createdAt": "2026-04-22T22:00:00.000Z"
  }
]
```

---

### `GET /api/suci/next-id`

Get the next available PKI ID (0–255).

**Response `200`**
```json
{ "nextId": 2 }
```

---

### `POST /api/suci/keys`

Generate a new SUCI keypair. Scheme 1 = Profile A (X25519), Scheme 2 = Profile B (secp256r1). Also updates UDM config with the new public key.

**Request body**
```json
{ "id": 1, "scheme": 1 }
```

**Response `200`**
```json
{
  "id": 1,
  "scheme": 1,
  "publicKey": "5a8d38864820197c3394b92613b20b91633cbd897119273bf8e4a6f4eec0a650",
  "privateKey": "c80949f13ebe...",
  "createdAt": "2026-04-22T22:00:00.000Z"
}
```

**Response `400`** — Missing fields or invalid scheme.

---

### `PUT /api/suci/keys/:id`

Regenerate an existing keypair (deletes old, creates new with same ID). Also updates UDM config.

**URL params:** `id` — PKI ID number

**Request body**
```json
{ "scheme": 1 }
```

**Response `200`** — Same shape as `POST /api/suci/keys`.

---

### `DELETE /api/suci/keys/:id`

Delete a SUCI keypair. Optionally deletes the key file from disk.

**URL params:** `id` — PKI ID number

**Query params:** `deleteFile=true` — also remove the key file from disk

**Response `200`**
```json
{ "success": true, "id": 1, "deletedFile": true }
```

---

## Audit Log

### `GET /api/audit`

Retrieve audit log entries with optional pagination and action filtering.

**Query params**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `skip` | number | `0` | Records to skip |
| `limit` | number | `100` | Max records to return |
| `action` | string | — | Filter by action type (see below) |

**Valid action values:** `config_apply` `config_load` `service_action` `subscriber_create` `subscriber_update` `subscriber_delete` `backup_create` `backup_restore` `suci_generate` `suci_delete` `auto_config`

**Response `200`**
```json
{
  "entries": [
    {
      "id": "abc123",
      "timestamp": "2026-04-22T22:00:00.000Z",
      "user": "admin",
      "action": "config_apply",
      "target": "amf",
      "details": "AMF configuration applied",
      "success": true
    }
  ],
  "total": 156
}
```

---

## Docker

### `GET /api/docker/containers`

List all NMS Docker containers (backend, frontend, nginx).

**Response `200`**
```json
{
  "success": true,
  "containers": [
    "open5gs-nms-backend",
    "open5gs-nms-frontend",
    "open5gs-nms-nginx"
  ]
}
```

---

### `GET /api/docker/logs/:container`

Get recent log lines from a specific NMS container.

**URL params:** `container` — container name (e.g. `open5gs-nms-backend`)

**Query params:** `limit` — number of lines to return (default `100`)

**Response `200`**
```json
{
  "success": true,
  "logs": [
    {
      "timestamp": "2026-04-22T22:00:00.000Z",
      "level": "info",
      "message": "HTTP server started",
      "container": "open5gs-nms-backend"
    }
  ]
}
```

---

## WebSocket

The WebSocket server runs on port `3002` (proxied via nginx at `ws://YOUR_SERVER:8888/ws`).

Used for real-time log streaming and service status updates. Authenticate before connecting — the WebSocket connection shares the same session cookie as HTTP.

### Service Status Broadcasts

The server broadcasts service status updates every 5 seconds to all connected clients automatically. No subscription message needed.

**Received message**
```json
{
  "type": "service_status_update",
  "payload": {
    "statuses": {
      "amf": { "name": "amf", "active": true, "enabled": true, "subState": "running" },
      "smf": { "name": "smf", "active": true, "enabled": true, "subState": "running" }
    }
  }
}
```

---

### Log Streaming — Subscribe

Send this message to start streaming logs from Open5GS services or Docker containers.

**Sent message**
```json
{
  "type": "subscribe_logs",
  "source": "open5gs",
  "services": ["amf", "smf", "upf"]
}
```

Or for Docker container logs:
```json
{
  "type": "subscribe_logs",
  "source": "docker",
  "services": ["open5gs-nms-backend", "open5gs-nms-nginx"]
}
```

Use `"services": []` or omit to subscribe to all services/containers for that source.

---

### Log Streaming — Received

**Received message**
```json
{
  "type": "log_entry",
  "payload": {
    "timestamp": "2026-04-22T22:00:00.000Z",
    "level": "info",
    "service": "amf",
    "message": "gNB-N2 accepted[addr:172.16.1.67]",
    "source": "open5gs"
  }
}
```

---

### Log Streaming — Unsubscribe

**Sent message**
```json
{
  "type": "unsubscribe_logs",
  "source": "open5gs"
}
```

---

## Error Responses

All endpoints return a consistent error shape on failure:

```json
{ "success": false, "error": "Human-readable error message" }
```

| Status | Meaning |
|--------|---------|
| `400` | Bad request — missing or invalid parameters |
| `401` | Unauthenticated — no valid session cookie |
| `404` | Resource not found |
| `409` | Conflict — e.g. duplicate username |
| `429` | Rate limited — too many login attempts |
| `500` | Internal server error |

---

## Quick Reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | No | Health check |
| POST | `/api/auth/login` | No | Login |
| POST | `/api/auth/logout` | Yes | Logout |
| GET | `/api/auth/me` | Yes | Current user |
| GET | `/api/users` | Yes | List users |
| POST | `/api/users` | Yes | Create user |
| PUT | `/api/users/:id/password` | Yes | Change password |
| DELETE | `/api/users/:id` | Yes | Delete user |
| GET | `/api/config` | Yes | Load all configs |
| GET | `/api/config/:service` | Yes | Load one config |
| POST | `/api/config/validate` | Yes | Validate configs |
| POST | `/api/config/apply` | Yes | Apply configs |
| GET | `/api/config/topology/graph` | Yes | Topology node data |
| POST | `/api/config/sync-sd` | Yes | Sync SD value |
| GET | `/api/services` | Yes | All service statuses |
| GET | `/api/services/:name` | Yes | One service status |
| POST | `/api/services/:name/:action` | Yes | Service action |
| POST | `/api/services/all/:action` | Yes | Bulk service action |
| GET | `/api/subscribers` | Yes | List subscribers |
| GET | `/api/subscribers/ip-assignments` | Yes | IP assignments |
| GET | `/api/subscribers/:imsi` | Yes | Get subscriber |
| POST | `/api/subscribers` | Yes | Create subscriber |
| PUT | `/api/subscribers/:imsi` | Yes | Update subscriber |
| DELETE | `/api/subscribers/:imsi` | Yes | Delete subscriber |
| POST | `/api/subscribers/auto-assign-ips` | Yes | Auto-assign IPs |
| GET | `/api/interface-status` | Yes | RAN + UE status |
| GET | `/api/backup/list` | Yes | List backups |
| POST | `/api/backup/config` | Yes | Create config backup |
| POST | `/api/backup/mongo` | Yes | Create MongoDB backup |
| POST | `/api/backup/restore/config` | Yes | Restore config |
| POST | `/api/backup/restore/mongo` | Yes | Restore MongoDB |
| POST | `/api/backup/restore/both` | Yes | Restore both |
| POST | `/api/backup/restore/selective` | Yes | Restore selected NFs |
| POST | `/api/backup/diff` | Yes | Config diff vs backup |
| GET | `/api/backup/last-config` | Yes | Latest backup name |
| GET | `/api/backup/settings` | Yes | Retention settings |
| PUT | `/api/backup/settings` | Yes | Update retention |
| POST | `/api/backup/cleanup` | Yes | Trigger cleanup |
| POST | `/api/backup/restore-defaults` | Yes | Factory defaults |
| POST | `/api/auto-config/preview` | Yes | Preview auto-config |
| POST | `/api/auto-config/apply` | Yes | Apply auto-config |
| GET | `/api/suci/keys` | Yes | List SUCI keys |
| GET | `/api/suci/next-id` | Yes | Next PKI ID |
| POST | `/api/suci/keys` | Yes | Generate key |
| PUT | `/api/suci/keys/:id` | Yes | Regenerate key |
| DELETE | `/api/suci/keys/:id` | Yes | Delete key |
| GET | `/api/audit` | Yes | Audit log entries |
| GET | `/api/docker/containers` | Yes | List containers |
| GET | `/api/docker/logs/:container` | Yes | Container logs |
| WS | `ws://host:8888/ws` | Yes | Log stream + status |
