// SMF (Session Management Function) Tooltips
export const SMF_TOOLTIPS = {
  sbi_address: "Address for SMF Service-Based Interface. Manages PDU sessions, QoS policies, and UPF selection",
  sbi_port: "Port for SMF SBI. Default: 7777. Handles N7 (PCF), N11 (AMF) interfaces",
  scp_uri: "URI of SCP for NF discovery. Required if not using direct NRF mode. Format: http://ip:port",
  pfcp_server: "Address for PFCP interface to UPF. Control plane for managing user plane packet forwarding and QoS rules",
  pfcp_port: "PFCP protocol port. Default: 8805. Used for N4 interface to UPF",
  upf_address: "Address of UPF to connect via PFCP. Must match UPF's PFCP server address. SMF sends session rules here",
  gtpc_address: "GTP Control plane address for S11 interface. Used for 4G/5G interworking with SGW-C",
  gtpu_address: "GTP User plane address for S5 interface. Forwards data between 4G and 5G networks",
  session_subnet: "IP pool for UE PDU sessions in CIDR notation (e.g., 10.45.0.0/16). UPF assigns IPs from this range",
  session_gateway: "Gateway IP for the session pool. Used as default route by UEs. Typically first IP in subnet",
  dns_primary: "Primary DNS server address provided to UEs. Used for hostname resolution by user applications",
  dns_secondary: "Secondary DNS server address. Fallback if primary is unreachable. Recommended: 8.8.8.8, 1.1.1.1",
  mtu: "Maximum Transmission Unit for user plane packets. Default: 1400 bytes. Accounts for GTP/IP overhead (typical internet MTU is 1500)",
  freediameter: "Path to FreeDiameter configuration file for Gx interface. Used for 4G policy control with PCRF",
  log_path: "Path where SMF logs are written. Includes PDU session establishment, modifications, and QoS changes",
  log_level: "SMF log verbosity. Debug for session troubleshooting, info for production, warn/error for problems only",
};
