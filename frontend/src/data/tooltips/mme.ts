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
};
