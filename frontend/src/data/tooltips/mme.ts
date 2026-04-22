export const MME_TOOLTIPS = {
  freediameter: "Path to FreeDiameter configuration file for S6a/Diameter interface with HSS. Used for authentication and subscription data retrieval.",
  s1ap_address: "S1-MME interface address for eNodeB (eNB) connections. This is where eNodeBs connect to establish S1 control plane connections.",
  gtpc_server: "GTP-C (GPRS Tunneling Protocol - Control) server address for control plane signaling with SGW-C.",
  gtpc_sgwc: "SGW-C address for GTP-C signaling. MME communicates with SGW-C for session management and bearer setup.",
  gtpc_smf: "SMF address for 4G/5G interworking. Enables MME to communicate with 5G SMF for dual-mode network support.",
  gummei_mcc: "Mobile Country Code for GUMMEI (Globally Unique MME Identifier). 3 digits identifying the country (e.g., 001 for test, 310 for USA).",
  gummei_mnc: "Mobile Network Code for GUMMEI. 2-3 digits identifying the mobile network within a country.",
  mme_gid: "MME Group ID (0-65535). Groups MMEs in a pool for load balancing. eNodeBs can distribute UEs across MMEs with the same Group ID.",
  mme_code: "MME Code (0-255). Unique identifier for this specific MME instance within an MME pool/group.",
  tai_mcc: "Mobile Country Code for Tracking Area Identity. Defines the geographic tracking area this MME serves.",
  tai_mnc: "Mobile Network Code for Tracking Area Identity. Works with MCC to define the tracking area.",
  tai_tac: "Tracking Area Code (1-65535). Identifies a specific tracking area within a PLMN. Larger TAC = fewer location updates, more paging load.",
  
  // SGs-AP Interface (CSFB - Circuit Switched FallBack)
  sgsap_overview: "SGs-AP enables CSFB (Circuit Switched FallBack) - allows 4G LTE devices to fall back to 2G/3G networks for voice calls when VoLTE is unavailable. Connects MME to MSC/VLR.",
  sgsap_server_address: "MSC/VLR SCTP server address. Use an IP address (e.g. 127.0.0.88) wherever possible. If you use a hostname, Open5GS MME will call getaddrinfo() at startup — if DNS cannot resolve it at that moment, the MME will abort with a fatal error. IP addresses always work regardless of DNS.",
  sgsap_local_address: "MME's local SCTP bind address(es) for SGs interface. IP addresses the MME uses to communicate with the MSC/VLR.",
  
  // TAI (4G) - Used by LTE/4G network
  sgsap_tai_header: "4G TRACKING AREA (TAI) - Where the UE is registered in the LTE network. This is the 4G side of the mapping.",
  sgsap_tai_mcc: "4G Tracking Area MCC (Mobile Country Code). The country code in the LTE network where the UE is registered.",
  sgsap_tai_mnc: "4G Tracking Area MNC (Mobile Network Code). The operator code in the LTE network where the UE is registered.",
  sgsap_tai_tac: "4G Tracking Area Code (TAC). The specific LTE tracking area. Example: 4131 (decimal) or 0x1023 (hex).",
  
  // LAI (2G/3G) - Used by legacy network
  sgsap_lai_header: "2G/3G LOCATION AREA (LAI) - Where the UE appears to be registered in the legacy network. This is the 2G/3G side that MAPS FROM the 4G TAI above.",
  sgsap_lai_mcc: "2G/3G Location Area MCC. When UE falls back to 2G/3G for voice, it appears to be in this country. Usually matches TAI MCC.",
  sgsap_lai_mnc: "2G/3G Location Area MNC. When UE falls back to 2G/3G for voice, it appears to be in this operator's network. Usually matches TAI MNC.",
  sgsap_lai_lac: "2G/3G Location Area Code (LAC). The legacy location area the UE appears to be in. Example: 43691 (decimal) or 0xAAAAB (hex). Different from TAC!",
  
  // Mapping explanation
  sgsap_mapping_explanation: "TAI→LAI mapping tells the MSC/VLR: 'When a UE is in 4G TAI (MCC:001, MNC:01, TAC:4131), treat it as if it's in 2G/3G LAI (MCC:001, MNC:01, LAC:43691)'. This allows seamless fallback for voice calls.",

  // Network name & MME identity
  network_name_full: "Full network name broadcast to UEs in NAS messages. Shown on the device's network name display.",
  network_name_short: "Short network name broadcast to UEs. Used when display space is limited.",
  mme_name: "Identifies this MME instance. Used in Diameter S6a messages and logging.",

  // 3GPP mobility timers
  t3402: "T3402 timer (seconds). Controls how long a UE waits before re-attempting attach after a failed attempt. Default: 720s (12 minutes).",
  t3412: "T3412 timer (seconds). Periodic TAU (Tracking Area Update) timer — how often an idle UE checks in with the network. Default: 3240s (54 minutes).",
  t3423: "T3423 timer (seconds). IMSI detach timer for combined EPS/IMSI attach. Controls GPRS detach procedure timing. Default: 720s (12 minutes).",
};
