// PLMN Input Component Tooltips

export const PLMN_INPUT_TOOLTIPS = {
  mcc: "Mobile Country Code - 3-digit code identifying the country (e.g., 001 for test networks, 310-316 for USA, 999 for private/test use)",
  mnc: "Mobile Network Code - 2 or 3-digit code identifying the mobile network operator within a country",
  mme_gid: "MME Group ID (0-65535) - Identifies a pool of MMEs for load balancing. All MMEs in the same pool must have the same Group ID. Part of GUMMEI (Globally Unique MME Identifier).",
  mme_code: "MME Code (0-255) - Uniquely identifies a specific MME instance within an MME Group. Each MME in a pool needs a unique code. Part of GUMMEI.",
  tac: "Tracking Area Code (1-65535) - Identifies a tracking area for paging and location updates. Smaller TAC = more frequent location updates but less paging load. Broadcast by eNodeBs/gNodeBs.",
};
