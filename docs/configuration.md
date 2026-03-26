# Network Function Configuration Reference

Complete reference for configuring all 16 Open5GS network functions through the NMS.

---

## Configuration Overview

Open5GS NMS manages configuration for all network functions through YAML files located in `/etc/open5gs/`. Each network function has its own configuration file with service-specific parameters.

### Common Configuration Sections

All network functions share these common sections:

**Logger:**
- `file.path` - Log file location (e.g., `/var/log/open5gs/nrf.log`)
- `level` - Log verbosity: `fatal`, `error`, `warn`, `info`, `debug`, `trace`

**SBI (Service-Based Interface):**
- `server` - Where this NF listens for SBI requests
  - `address` - IP address to bind (IPv4 or IPv6)
  - `port` - TCP port number (typically 7777)
- `client` - How this NF connects to other NFs
  - `nrf.uri` - NRF address for service registration
  - `scp.uri` - Optional SCP address for proxied communication

---

## 5G Core Network Functions

### NRF (NF Repository Function)

**Purpose:** Service discovery and NF registration for 5G core.

**Key Configuration:**
```yaml
nrf:
  sbi:
    server:
      - address: 127.0.0.10
        port: 7777
```

**Important Fields:**
- `sbi.server` - Where NRF listens (must be accessible to all NFs)

**Notes:**
- NRF must start before other 5G NFs
- All 5G NFs register with NRF at startup

---

### SCP (Service Communication Proxy)

**Purpose:** Optional HTTP/2 proxy for indirect SBI communication.

**Key Configuration:**
```yaml
scp:
  sbi:
    server:
      - address: 127.0.0.200
        port: 7777
    client:
      nrf:
        - uri: http://127.0.0.10:7777
```

**Use Cases:**
- Simplify NF-to-NF communication
- Load balancing
- Service mesh integration

---

### AMF (Access and Mobility Management Function)

**Purpose:** UE registration, mobility management, and authentication for 5G.

**Key Configuration:**
```yaml
amf:
  sbi:
    server:
      - address: 127.0.0.5
        port: 7777
    client:
      nrf:
        - uri: http://127.0.0.10:7777
  ngap:
    server:
      - address: 10.0.1.175  # NGAP interface for gNodeB
  guami:
    - plmn_id:
        mcc: "001"
        mnc: "01"
      amf_id:
        region: 2
        set: 1
  tai:
    - plmn_id:
        mcc: "001"
        mnc: "01"
      tac: 1
  plmn_support:
    - plmn_id:
        mcc: "001"
        mnc: "01"
      s_nssai:
        - sst: 1
  security:
    integrity_order: [NIA2, NIA1, NIA0]
    ciphering_order: [NEA0, NEA1, NEA2]
  network_name:
    full: "Open5GS"
    short: "Next"
```

**Important Fields:**
- `ngap.server.address` - IP for gNodeB N2 interface
- `guami` - Global Unique AMF Identifier
- `tai` - Tracking Area Identity list
- `plmn_support` - Supported PLMNs and network slices
- `security` - NAS security algorithm preferences

---

### SMF (Session Management Function)

**Purpose:** PDU session management, UPF selection, and IP address allocation.

**Key Configuration:**
```yaml
smf:
  sbi:
    server:
      - address: 127.0.0.4
        port: 7777
    client:
      nrf:
        - uri: http://127.0.0.10:7777
  pfcp:
    server:
      - address: 127.0.0.4
    client:
      upf:
        - address: 127.0.0.7
  gtpc:
    server:
      - address: 127.0.0.4
  gtpu:
    server:
      - address: 127.0.0.4
  session:
    - subnet: 10.45.0.0/16
      gateway: 10.45.0.1
    - subnet: 2001:db8:cafe::/48
      gateway: 2001:db8:cafe::1
  dns:
    - 8.8.8.8
    - 8.8.4.4
  mtu: 1400
```

**Important Fields:**
- `pfcp.client.upf` - UPF address for PFCP (N4 interface)
- `session` - IPv4/IPv6 pools for UE IP assignment
- `dns` - DNS servers provided to UEs
- `mtu` - Maximum Transmission Unit for UE sessions

---

### UPF (User Plane Function)

**Purpose:** Packet forwarding, QoS enforcement, and data plane for 5G.

**Key Configuration:**
```yaml
upf:
  pfcp:
    server:
      - address: 127.0.0.7
  gtpu:
    server:
      - address: 127.0.0.7
  session:
    - subnet: 10.45.0.0/16
    - subnet: 2001:db8:cafe::/48
```

**Important Fields:**
- `pfcp.server.address` - Where SMF connects for PFCP
- `gtpu.server.address` - GTP-U interface for user data
- `session` - Must match SMF session configuration

**Network Integration:**
- Typically requires NAT/routing for UE internet access
- Use `ogstun` interface for UE traffic

---

### AUSF (Authentication Server Function)

**Purpose:** 5G-AKA authentication.

**Key Configuration:**
```yaml
ausf:
  sbi:
    server:
      - address: 127.0.0.11
        port: 7777
    client:
      nrf:
        - uri: http://127.0.0.10:7777
```

---

### UDM (Unified Data Management)

**Purpose:** Subscriber data management and credential generation.

**Key Configuration:**
```yaml
udm:
  sbi:
    server:
      - address: 127.0.0.12
        port: 7777
    client:
      nrf:
        - uri: http://127.0.0.10:7777
  hnet:
    - id: 1
      scheme: 1  # Profile A (X25519)
      key: "PUBLIC_KEY_HEX"
```

**Important Fields:**
- `hnet` - Home network public keys for SUCI (5G privacy)

---

### UDR (Unified Data Repository)

**Purpose:** Database interface for subscription data.

**Key Configuration:**
```yaml
udr:
  sbi:
    server:
      - address: 127.0.0.20
        port: 7777
    client:
      nrf:
        - uri: http://127.0.0.10:7777
```

---

### PCF (Policy Control Function)

**Purpose:** Policy decisions and QoS management.

**Key Configuration:**
```yaml
pcf:
  sbi:
    server:
      - address: 127.0.0.13
        port: 7777
    client:
      nrf:
        - uri: http://127.0.0.10:7777
```

---

### NSSF (Network Slice Selection Function)

**Purpose:** Network slice selection based on S-NSSAI.

**Key Configuration:**
```yaml
nssf:
  sbi:
    server:
      - address: 127.0.0.14
        port: 7777
    client:
      nrf:
        - uri: http://127.0.0.10:7777
  nsi:
    - s_nssai:
        sst: 1
      nrf:
        - uri: http://127.0.0.10:7777
```

---

### BSF (Binding Support Function)

**Purpose:** Binding information storage and retrieval.

**Key Configuration:**
```yaml
bsf:
  sbi:
    server:
      - address: 127.0.0.15
        port: 7777
    client:
      nrf:
        - uri: http://127.0.0.10:7777
```

---

## 4G EPC Network Functions

### MME (Mobility Management Entity)

**Purpose:** UE tracking, bearer management, and authentication for 4G.

**Key Configuration:**
```yaml
mme:
  s1ap:
    server:
      - address: 10.0.1.175  # S1-MME interface for eNodeB
  gtpc:
    server:
      - address: 127.0.0.2
    client:
      sgwc:
        - address: 127.0.0.3
      smf:
        - address: 127.0.0.4
  gummei:
    - plmn_id:
        mcc: "001"
        mnc: "01"
      mme_gid: 2
      mme_code: 1
  tai:
    - plmn_id:
        mcc: "001"
        mnc: "01"
      tac: 1
  security:
    integrity_order: [EIA2, EIA1, EIA0]
    ciphering_order: [EEA0, EEA1, EEA2]
```

**Important Fields:**
- `s1ap.server.address` - IP for eNodeB S1-MME interface
- `gummei` - Global Unique MME Identifier
- `tai` - Tracking Area Identity list
- `security` - NAS security algorithm preferences

---

### HSS (Home Subscriber Server)

**Purpose:** Authentication and subscriber profiles for 4G.

**Key Configuration:**
```yaml
hss:
  freeDiameter: /etc/freeDiameter/hss.conf
```

**Notes:**
- Uses Diameter protocol
- Separate configuration file for Diameter settings

---

### PCRF (Policy and Charging Rules Function)

**Purpose:** QoS policies and charging rules for 4G.

**Key Configuration:**
```yaml
pcrf:
  freeDiameter: /etc/freeDiameter/pcrf.conf
```

---

### SGW-C (Serving Gateway Control Plane)

**Purpose:** S11/S5 control plane for 4G.

**Key Configuration:**
```yaml
sgwc:
  gtpc:
    server:
      - address: 127.0.0.3
  pfcp:
    server:
      - address: 127.0.0.3
    client:
      sgwu:
        - address: 127.0.0.6
```

---

### SGW-U (Serving Gateway User Plane)

**Purpose:** S1-U/S5-U user plane for 4G data.

**Key Configuration:**
```yaml
sgwu:
  pfcp:
    server:
      - address: 127.0.0.6
  gtpu:
    server:
      - address: 127.0.0.6
        address: 10.0.1.176  # S1-U interface for eNodeB
```

---

## Configuration Best Practices

### IP Address Planning

**Loopback Addresses (127.0.0.x):**
- Used for SBI and PFCP (internal communication)
- Each NF gets unique IP in 127.0.0.0/8 range

**External Addresses:**
- NGAP (AMF): IP accessible from gNodeB
- S1-MME (MME): IP accessible from eNodeB
- GTP-U (UPF, SGW-U): IP accessible from RAN

### PLMN ID Configuration

**Format:**
- MCC: 3 digits (Mobile Country Code)
- MNC: 2-3 digits (Mobile Network Code)

**Examples:**
- US Verizon: MCC 311, MNC 480
- US CBRS: MCC 315, MNC 010
- Test: MCC 001, MNC 01

**Consistency:**
- Same PLMN ID across all NFs
- Match PLMN in USIM/SIM cards
- Configure in AMF, MME, and all relevant NFs

### Network Slicing

**S-NSSAI Format:**
- SST (Slice/Service Type): 1-255
- SD (Slice Differentiator): 24-bit hex (optional)

**Common SST Values:**
- 1: eMBB (Enhanced Mobile Broadband)
- 2: URLLC (Ultra-Reliable Low Latency)
- 3: MIoT (Massive IoT)

### Security Algorithms

**5G (NIA/NEA):**
- NIA0/NEA0: Null (no security)
- NIA1/NEA1: SNOW 3G
- NIA2/NEA2: AES (recommended)
- NIA3/NEA3: ZUC

**4G (EIA/EEA):**
- EIA0/EEA0: Null (no security)
- EIA1/EEA1: SNOW 3G
- EIA2/EEA2: AES (recommended)
- EIA3/EEA3: ZUC

**Recommendation:** Use AES (NIA2/NEA2 or EIA2/EEA2) for production

---

## Troubleshooting Configuration Issues

### Service Won't Start

1. Check YAML syntax: `yamllint /etc/open5gs/service.yaml`
2. Check service logs: `journalctl -u open5gs-xxxd -n 50`
3. Verify IP addresses are correct and interfaces exist
4. Check firewall isn't blocking ports

### UE Can't Register

1. Verify PLMN ID matches SIM card
2. Check TAI configuration includes cell's TAI
3. Verify security algorithms match UE capabilities
4. Check NGAP/S1-MME interface is reachable from RAN

### No Internet Access

1. Verify session pool configuration in SMF/UPF
2. Check NAT is configured on UPF host
3. Verify DNS servers are correct
4. Check routing table on UPF host

---

For more details, see:
- **[Open5GS Documentation](https://open5gs.org/open5gs/docs/)**
- **[Troubleshooting Guide](troubleshooting.md)**
- **[Deployment Guide](deployment.md)**
