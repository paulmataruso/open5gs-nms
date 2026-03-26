// 4G EPC Network Functions Tooltips

// MME (Mobility Management Entity) Tooltips
export const MME_TOOLTIPS = {
  freediameter: "Path to FreeDiameter configuration file for S6a/Diameter interface with HSS. Used for authentication and subscription data retrieval.",
  s1ap_address: "S1-MME interface address for eNodeB connections. Must be reachable by 4G base stations. SCTP protocol",
  s1ap_port: "S1-MME port. Default: 36412. Used for control plane with eNodeBs",
  gtpc_server: "GTP-C server address for S11 interface to SGW-C. Control plane for bearer management",
  gtpc_sgwc: "SGW-C address for GTP-C signaling. MME communicates with SGW-C for session management and bearer setup.",
  gtpc_smf: "SMF address for 4G/5G interworking. Enables MME to communicate with 5G SMF for dual-mode network support.",
  gtpc_address: "GTP-C address for S11 interface to SGW-C. Control plane for bearer management",
  gtpc_port: "GTP-C port. Default: 2123. GPRS Tunneling Protocol Control plane",
  mcc: "Mobile Country Code for 4G PLMN. Must match USIM cards and broadcast by eNodeBs",
  mnc: "Mobile Network Code for 4G PLMN. Identifies your 4G operator network",
  gummei_mcc: "Mobile Country Code for GUMMEI (Globally Unique MME Identifier). 3 digits identifying the country (e.g., 001 for test, 310 for USA).",
  gummei_mnc: "Mobile Network Code for GUMMEI. 2-3 digits identifying the mobile network within a country.",
  mme_gid: "MME Group ID (16-bit: 0-65535). Pool identifier for load balancing across multiple MMEs. Part of GUMMEI",
  mme_code: "MME Code (8-bit: 0-255). Unique MME identifier within the group. Part of GUMMEI for specific MME identification",
  tai_mcc: "Mobile Country Code for Tracking Area Identity. Defines the geographic tracking area this MME serves.",
  tai_mnc: "Mobile Network Code for Tracking Area Identity. Works with MCC to define the tracking area.",
  tai_tac: "Tracking Area Code (1-65535). Identifies a specific tracking area within a PLMN. Larger TAC = fewer location updates, more paging load.",
  tac: "Tracking Area Code (1-65535). Groups eNodeBs for paging and location updates. Lower TAC = more frequent updates",
  tai_list: "Tracking Area Identity list. Defines which TAs this MME serves. Broadcast by eNodeBs for UE selection",
  security_eia: "Integrity protection algorithm order for NAS messages. EIA2 (AES) recommended. Format: [EIA2, EIA1, EIA0]",
  security_eea: "Encryption algorithm order for NAS/user data. EEA2 (AES) recommended. EEA0 = no encryption (testing only)",
  network_name_full: "Full 4G network name (max 63 chars). Displayed to users during LTE attach and in phone settings",
  network_name_short: "Short 4G network name (max 31 chars). Shown when full name doesn't fit on device screen",
  mme_name: "MME identifier name (FQDN format). Used for logging, debugging, and Diameter routing",
  log_path: "MME log file path. Contains attach procedures, handovers, and S1 events",
  log_level: "MME log verbosity. Debug for UE attachment troubleshooting, info for production monitoring",
};

// HSS (Home Subscriber Server) Tooltips  
export const HSS_TOOLTIPS = {
  diameter_address: "Diameter protocol address for S6a interface to MME. Provides authentication and subscriber data",
  diameter_port: "Diameter port. Default: 3868. Used for S6a (MME), S6d (SGSN), and Cx (IMS) interfaces",
  mongodb_uri: "MongoDB connection for 4G subscriber database. Stores IMSI, Ki, OPc, and subscription profiles",
  freediameter_conf: "FreeDiameter configuration file path. Defines Diameter realm, identity, and peer connections",
  log_path: "HSS log file path. Contains authentication requests, location updates, and subscriber data queries",
  log_level: "HSS log verbosity. Info sufficient for production, debug for authentication troubleshooting",
};

// PCRF (Policy and Charging Rules Function) Tooltips
export const PCRF_TOOLTIPS = {
  diameter_address: "Diameter address for Gx interface to PGW. Provides dynamic QoS and charging rules",
  diameter_port: "Diameter port. Default: 3868. Gx interface for policy and charging control",
  mongodb_uri: "MongoDB for 4G policy rules, charging rules, and spending limits",
  freediameter_conf: "FreeDiameter config for PCRF. Defines Diameter realm and PGW peer connections",
  log_path: "PCRF log file path. Contains policy decisions, Gx messages, and rule installations",
  log_level: "PCRF log verbosity. Debug shows per-session policy decisions, info for normal operation",
};

// SGW-C (Serving Gateway Control Plane) Tooltips
export const SGWC_TOOLTIPS = {
  gtpc_address: "GTP-C address for S11 (MME) and S5 (PGW) interfaces. Control plane for bearer management",
  gtpc_port: "GTP-C port. Default: 2123. Handles bearer setup, modification, deletion procedures",
  pfcp_address: "PFCP address for Sxb interface to SGW-U. Control plane to user plane communication",
  pfcp_port: "PFCP port. Default: 8805. Used to install packet forwarding rules in SGW-U",
  log_path: "SGW-C log file path. Contains bearer events, PFCP sessions, and S11/S5 procedures",
  log_level: "SGW-C log verbosity. Info for production, debug for bearer establishment troubleshooting",
};

// SGW-U (Serving Gateway User Plane) Tooltips
export const SGWU_TOOLTIPS = {
  gtpu_address: "GTP-U address for S1-U (eNodeB) and S5-U (PGW) interfaces. Data plane for user traffic",
  gtpu_port: "GTP-U port. Default: 2152. Forwards encapsulated user packets between eNodeB and PGW",
  pfcp_address: "PFCP address for Sxb interface from SGW-C. Receives packet forwarding rules and QoS policies",
  pfcp_port: "PFCP port. Default: 8805. Control plane from SGW-C configures data plane forwarding",
  log_path: "SGW-U log file path. Contains packet forwarding statistics, tunnel events, and PFCP actions",
  log_level: "SGW-U log verbosity. Warn/error for production (high traffic). Debug impacts performance",
};

// PGW-C (PDN Gateway Control Plane) Tooltips - Often combined with SMF
export const PGWC_TOOLTIPS = {
  gtpc_address: "GTP-C address for S5 interface from SGW. Also S2a/S2b for non-3GPP access",
  apn: "Access Point Name. Defines external data network (internet, IMS, enterprise). Routes to specific IP pool",
  dns_primary: "Primary DNS provided to 4G UEs. Used for hostname resolution by applications",
  dns_secondary: "Secondary DNS for 4G UEs. Backup if primary DNS unreachable",
  ue_pool: "IP address pool for 4G UE sessions (CIDR). PGW assigns from this range. Size for peak concurrent users",
  pcrf_diameter: "PCRF address for Gx interface. Retrieves dynamic policies and charging rules per UE session",
};

// PGW-U (PDN Gateway User Plane) Tooltips - Often combined with UPF
export const PGWU_TOOLTIPS = {
  gtpu_address: "GTP-U address for S5-U interface from SGW. Tunnel endpoint for user data",
  sgi_interface: "SGi interface to external packet data networks (internet). Physical or virtual interface name",
  nat_enable: "Enable NAT (Network Address Translation) for UE traffic to internet. Required if UE pool uses private IPs",
};
