// Common tooltips used across multiple NFs
export const COMMON_TOOLTIPS = {
  sbi_address: "Service-Based Interface bind address. IP address this NF listens on for HTTP/2 connections from other NFs",
  sbi_port: "Service-Based Interface port. Default: 7777 for most NFs. Must be unique if multiple NFs on same host",
  scp_uri: "Service Communication Proxy URI. When set, NF uses SCP for indirect communication. Empty = direct NRF discovery",
  nrf_uri: "Network Repository Function URI. Used for direct NF discovery mode. Format: http://ip:port",
  log_path: "Full path to log file. Parent directory must exist and be writable by the NF process",
  log_level: "Logging verbosity: fatal, error, warn, info, debug, trace. Higher = more detail. Use info for production, debug for troubleshooting",
  mongodb_uri: "MongoDB connection string. Format: mongodb://host:port/database. Used for persistent data storage",
  mcc: "Mobile Country Code - 3-digit country identifier per ITU-T E.212. Examples: 001=test, 310=USA, 234=UK, 262=Germany",
  mnc: "Mobile Network Code - 2 or 3-digit operator identifier. Identifies specific mobile network within a country",
};

// UPF (User Plane Function) Tooltips
export const UPF_TOOLTIPS = {
  pfcp_address: "PFCP interface address for SMF control plane. Receives session management and QoS rules via N4 interface",
  pfcp_port: "PFCP protocol port. Default: 8805. PFCP = Packet Forwarding Control Protocol",
  gtpu_address: "GTP-U tunnel endpoint address. Receives encapsulated user data from gNodeB/eNodeB via N3/S1-U interface",
  gtpu_port: "GTP-U port for data plane. Default: 2152. GTP-U = GPRS Tunneling Protocol User plane",
  session_subnet: "IP address pool for UE data sessions (CIDR notation). UPF assigns IPs from this range. Size for expected concurrent users",
  session_gateway: "Gateway IP for UE traffic. Default route for all UE-originated packets. Usually first usable IP in session subnet",
  advertise: "External IP address to advertise if behind NAT. Leave empty if directly reachable. Used in PFCP setup procedures",
  log_path: "UPF log file path. Contains packet forwarding decisions, PFCP events, and throughput statistics",
  log_level: "UPF log verbosity. Trace shows per-packet decisions (performance impact). Info sufficient for production",
};

// AUSF (Authentication Server Function) Tooltips
export const AUSF_TOOLTIPS = {
  ...COMMON_TOOLTIPS,
  ausf_specific: "AUSF handles UE authentication via 5G AKA (Authentication and Key Agreement). Coordinates with UDM for subscriber credentials",
};

// UDM (Unified Data Management) Tooltips
export const UDM_TOOLTIPS = {
  ...COMMON_TOOLTIPS,
  hnet_id: "Home Network Public Key Identifier (1-255). Used in SUCI decryption to identify which private key to use",
  hnet_scheme: "SUCI protection scheme: 1=Profile A (X25519), 2=Profile B (secp256r1). Must match what's provisioned on SIMs",
  hnet_key: "Path to private key file for SUCI decryption. Paired with public key on SIMs. Format: /etc/open5gs/hnet/curve25519-{id}.key",
};

// UDR (Unified Data Repository) Tooltips
export const UDR_TOOLTIPS = {
  ...COMMON_TOOLTIPS,
  mongodb_uri: "MongoDB for subscriber data, authentication vectors, and policy information. Shared with UDM, PCF, BSF",
};

// PCF (Policy Control Function) Tooltips
export const PCF_TOOLTIPS = {
  ...COMMON_TOOLTIPS,
  mongodb_uri: "MongoDB for policy rules, charging rules, and QoS policies. Can be shared with UDR",
  policy_specific: "PCF controls QoS, charging, and access policies. Interfaces with SMF (N7) and AF (N5) for dynamic policy decisions",
};

// NSSF (Network Slice Selection Function) Tooltips
export const NSSF_TOOLTIPS = {
  ...COMMON_TOOLTIPS,
  nsi: "Network Slice Instance ID. Maps S-NSSAI (slice identifier) to actual AMF/SMF instances serving that slice",
  nsi_sst: "Slice Service Type for this instance (1-255). Must match subscriber slice configuration",
  nsi_sd: "Slice Differentiator (optional). 24-bit hex value for additional slice differentiation",
  nsi_nrf: "NRF Group ID or URI for this slice. Directs UE to NRF managing NFs for this specific slice",
};

// BSF (Binding Support Function) Tooltips
export const BSF_TOOLTIPS = {
  ...COMMON_TOOLTIPS,
  mongodb_uri: "MongoDB for PCF binding information. Maintains which PCF instance handles which UE session",
  bsf_specific: "BSF helps SMF find the correct PCF for a UE. Stores UE-PCF bindings for session continuity",
};

// SCP (Service Communication Proxy) Tooltips
export const SCP_TOOLTIPS = {
  ...COMMON_TOOLTIPS,
  scp_port: "SCP HTTP/2 proxy port. All NF-to-NF traffic routes through SCP in indirect communication mode",
  info_port_http: "HTTP port for SCP configuration/status API. Used for SCP management and monitoring",
  info_port_https: "HTTPS port for secure SCP configuration. Use when TLS is required for management interface",
  domain_name: "Fully qualified domain name for this SCP. Used in service routing and load balancing",
  domain_fqdn: "FQDN in full format. Must resolve to SCP address for proper routing",
};
