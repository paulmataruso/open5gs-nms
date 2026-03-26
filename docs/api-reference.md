# API Reference

Complete reference for the Open5GS NMS REST API.

---

## Base URL

All API endpoints are relative to: `http://YOUR_SERVER:3001/api` (or `/api` when accessed through nginx proxy)

---

## Authentication

**Current:** No authentication required (designed for trusted networks)

**Future:** JWT-based authentication planned

---

## Response Format

All responses follow this format:

**Success:**
```json
{
  "success": true,
  "data": { ... }
}
```

**Error:**
```json
{
  "success": false,
  "error": "Error message"
}
```

---

## Configuration Endpoints

### GET /api/config/all

Get all network function configurations.

**Response:**
```json
{
  "success": true,
  "configs": {
    "nrf": { ... },
    "amf": { ... },
    "smf": { ... },
    // ... all 16 NFs
  }
}
```

---

### GET /api/config/:service

Get specific network function configuration.

**Parameters:**
- `service` - Service name (nrf, amf, smf, upf, etc.)

**Example:**
```
GET /api/config/nrf
```

**Response:**
```json
{
  "success": true,
  "config": {
    "nrf": {
      "sbi": {
        "server": [
          { "address": "127.0.0.10", "port": 7777 }
        ]
      }
    },
    "logger": {
      "level": "info"
    }
  }
}
```

---

### POST /api/config/validate

Validate configuration before applying.

**Request Body:**
```json
{
  "nrf": { ... },
  "amf": { ... },
  // ... configs to validate
}
```

**Response:**
```json
{
  "success": true,
  "valid": true,
  "errors": []
}
```

**Error Response:**
```json
{
  "success": true,
  "valid": false,
  "errors": [
    {
      "service": "amf",
      "field": "ngap.server.address",
      "message": "Invalid IP address"
    }
  ]
}
```

---

### POST /api/config/apply

Apply new configuration with automatic backup and service restart.

**Request Body:**
```json
{
  "nrf": { ... },
  "amf": { ... },
  // ... all 16 NFs
}
```

**Response:**
```json
{
  "success": true,
  "backup": "/etc/open5gs/backups/config/2026-03-23-1430",
  "diff": "...",
  "restartResults": [
    { "service": "nrf", "success": true },
    { "service": "amf", "success": true }
  ],
  "rollback": false
}
```

**Error Response (with rollback):**
```json
{
  "success": false,
  "error": "Failed to restart amf",
  "restartResults": [
    { "service": "nrf", "success": true },
    { "service": "amf", "success": false, "error": "..." }
  ],
  "rollback": true,
  "restoredFrom": "/etc/open5gs/backups/config/2026-03-23-1430"
}
```

---

### GET /api/config/topology

Get network topology graph.

**Response:**
```json
{
  "success": true,
  "topology": {
    "nodes": [
      { "id": "nrf", "label": "NRF", "status": "active" },
      { "id": "amf", "label": "AMF", "status": "active" }
    ],
    "edges": [
      { "from": "amf", "to": "nrf", "label": "SBI" }
    ]
  }
}
```

---

## Service Endpoints

### GET /api/services/statuses

Get status of all services.

**Response:**
```json
{
  "success": true,
  "statuses": [
    {
      "name": "nrf",
      "active": true,
      "pid": 12345,
      "uptime": "2d 14h 32m",
      "memory": "45.2 MB"
    }
  ]
}
```

---

### GET /api/services/:service

Get status of specific service.

**Parameters:**
- `service` - Service name (nrf, amf, etc.)

**Response:**
```json
{
  "success": true,
  "status": {
    "name": "nrf",
    "active": true,
    "pid": 12345,
    "uptime": "2d 14h 32m"
  }
}
```

---

### POST /api/services/:service/start

Start a service.

**Response:**
```json
{
  "success": true,
  "status": "active"
}
```

---

### POST /api/services/:service/stop

Stop a service.

**Response:**
```json
{
  "success": true,
  "status": "inactive"
}
```

---

### POST /api/services/:service/restart

Restart a service.

**Response:**
```json
{
  "success": true,
  "status": "active"
}
```

---

## Subscriber Endpoints

### GET /api/subscribers

List subscribers with pagination.

**Query Parameters:**
- `skip` (optional) - Number of records to skip (default: 0)
- `limit` (optional) - Number of records to return (default: 50, max: 100)
- `search` (optional) - Search by IMSI or MSISDN

**Example:**
```
GET /api/subscribers?skip=0&limit=50&search=001
```

**Response:**
```json
{
  "success": true,
  "subscribers": [
    {
      "imsi": "001010000000001",
      "msisdn": ["1234567890"],
      "security": {
        "k": "465B5CE8B199B49FAA5F0A2EE238A6BC",
        "opc": "E8ED289DEBA952E4283B54E88E6183CA",
        "amf": "8000",
        "sqn": 0
      },
      "ambr": {
        "downlink": { "value": 1, "unit": 3 },
        "uplink": { "value": 1, "unit": 3 }
      },
      "slice": [
        {
          "sst": 1,
          "default_indicator": true,
          "session": [
            {
              "name": "internet",
              "type": 3,
              "qos": { "index": 9 },
              "ambr": {
                "downlink": { "value": 1, "unit": 3 },
                "uplink": { "value": 1, "unit": 3 }
              }
            }
          ]
        }
      ]
    }
  ],
  "total": 100,
  "skip": 0,
  "limit": 50
}
```

---

### GET /api/subscribers/:imsi

Get specific subscriber.

**Parameters:**
- `imsi` - 15-digit IMSI

**Response:**
```json
{
  "success": true,
  "subscriber": { ... }
}
```

---

### POST /api/subscribers

Create new subscriber.

**Request Body:**
```json
{
  "imsi": "001010000000001",
  "msisdn": ["1234567890"],
  "security": {
    "k": "465B5CE8B199B49FAA5F0A2EE238A6BC",
    "opc": "E8ED289DEBA952E4283B54E88E6183CA",
    "amf": "8000"
  },
  "ambr": {
    "downlink": { "value": 1, "unit": 3 },
    "uplink": { "value": 1, "unit": 3 }
  },
  "slice": [
    {
      "sst": 1,
      "default_indicator": true,
      "session": [
        {
          "name": "internet",
          "type": 3,
          "qos": { "index": 9 },
          "ambr": {
            "downlink": { "value": 1, "unit": 3 },
            "uplink": { "value": 1, "unit": 3 }
          }
        }
      ]
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "subscriber": { ... }
}
```

---

### PUT /api/subscribers/:imsi

Update existing subscriber.

**Request Body:** Same as POST

**Response:**
```json
{
  "success": true,
  "subscriber": { ... }
}
```

---

### DELETE /api/subscribers/:imsi

Delete subscriber.

**Response:**
```json
{
  "success": true,
  "deleted": true
}
```

---

## SUCI Key Management

### GET /api/suci/keys

List all SUCI keys.

**Response:**
```json
{
  "success": true,
  "keys": [
    {
      "pki": 1,
      "scheme": 1,
      "publicKey": "0123456789ABCDEF...",
      "keyFile": "/etc/open5gs/hnet/1.key"
    }
  ]
}
```

---

### POST /api/suci/generate

Generate new SUCI keypair.

**Request Body:**
```json
{
  "scheme": 1,
  "pki": 1,
  "routingIndicator": "0000"
}
```

**Response:**
```json
{
  "success": true,
  "key": {
    "pki": 1,
    "scheme": 1,
    "publicKey": "0123456789ABCDEF...",
    "keyFile": "/etc/open5gs/hnet/1.key"
  }
}
```

---

### PUT /api/suci/regenerate/:pki

Regenerate existing keypair.

**Response:**
```json
{
  "success": true,
  "key": { ... }
}
```

---

### DELETE /api/suci/:pki

Delete SUCI key.

**Query Parameters:**
- `deleteFile` (optional) - Whether to delete key file (default: false)

**Response:**
```json
{
  "success": true,
  "deleted": true
}
```

---

## Backup Endpoints

### GET /api/backup/list

List all backups.

**Response:**
```json
{
  "success": true,
  "backups": [
    {
      "timestamp": "2026-03-23-1430",
      "configPath": "/etc/open5gs/backups/config/2026-03-23-1430",
      "mongoPath": "/etc/open5gs/backups/mongodb/2026-03-23-1430",
      "configSize": "45.2 KB",
      "mongoSize": "2.3 MB"
    }
  ]
}
```

---

### POST /api/backup/create

Create new backup.

**Response:**
```json
{
  "success": true,
  "backup": {
    "timestamp": "2026-03-23-1430",
    "configPath": "...",
    "mongoPath": "..."
  }
}
```

---

### POST /api/backup/restore

Restore from backup.

**Request Body:**
```json
{
  "timestamp": "2026-03-23-1430",
  "restoreConfig": true,
  "restoreMongo": true
}
```

**Response:**
```json
{
  "success": true,
  "restored": {
    "config": true,
    "mongo": true
  }
}
```

---

## Auto-Configuration

### POST /api/auto-config/preview

Preview auto-configuration changes.

**Request Body:**
```json
{
  "mcc4g": "001",
  "mnc4g": "01",
  "mcc5g": "001",
  "mnc5g": "01",
  "s1mmeAddress": "10.0.1.175",
  "sgwuGtpuAddress": "10.0.1.176",
  "amfNgapAddress": "10.0.1.175",
  "upfGtpuAddress": "10.0.1.177",
  "sessionPoolIPv4Subnet": "10.45.0.0/16",
  "sessionPoolIPv4Gateway": "10.45.0.1",
  "configureNAT": true,
  "natInterface": "ogstun"
}
```

**Response:**
```json
{
  "success": true,
  "diffs": {
    "mme": "...",
    "amf": "...",
    "smf": "...",
    "upf": "..."
  },
  "natCommands": [
    "sysctl -w net.ipv4.ip_forward=1",
    "iptables -t nat -A POSTROUTING ..."
  ]
}
```

---

### POST /api/auto-config/apply

Apply auto-configuration.

**Request Body:** Same as preview

**Response:**
```json
{
  "success": true,
  "appliedServices": ["mme", "sgwu", "amf", "upf", "smf"],
  "natConfigured": true,
  "restartResults": [...]
}
```

---

## Health Check

### GET /api/health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-03-23T14:30:45.123Z",
  "version": "1.0.0"
}
```

---

## WebSocket API

### Connection

Connect to: `ws://YOUR_SERVER:3002` (or `ws://YOUR_SERVER:8888/ws` through nginx)

### Subscribe to Service Status Updates

**Client → Server:**
```json
{
  "type": "subscribe_services"
}
```

**Server → Client:**
```json
{
  "type": "service_status_update",
  "payload": {
    "statuses": [...]
  }
}
```

### Subscribe to Log Streaming

**Client → Server:**
```json
{
  "type": "subscribe_logs",
  "service": "open5gs-amfd"
}
```

**Server → Client:**
```json
{
  "type": "log_line",
  "line": "2026-03-23 14:30:45.123 [INFO] AMF started"
}
```

---

## Error Codes

| HTTP Status | Meaning |
|-------------|---------|
| 200 | Success |
| 400 | Bad Request (validation error) |
| 404 | Not Found |
| 409 | Conflict (duplicate IMSI) |
| 500 | Internal Server Error |

---

## Rate Limiting

- **Limit:** 100 requests per 15 minutes per IP address
- **Response when exceeded:**
```json
{
  "error": "Too many requests, please try again later"
}
```

---

## Example Usage

### cURL

```bash
# Get all configs
curl http://localhost:3001/api/config/all

# Create subscriber
curl -X POST http://localhost:3001/api/subscribers \
  -H "Content-Type: application/json" \
  -d '{"imsi":"001010000000001",...}'

# Restart service
curl -X POST http://localhost:3001/api/services/nrf/restart
```

### JavaScript (Axios)

```javascript
import axios from 'axios';

const client = axios.create({
  baseURL: 'http://localhost:3001/api'
});

// Get configs
const configs = await client.get('/config/all');

// Create subscriber
const subscriber = await client.post('/subscribers', {
  imsi: '001010000000001',
  // ...
});

// Restart service
await client.post('/services/nrf/restart');
```

---

For integration examples, see **[docs/development.md](development.md)**.
