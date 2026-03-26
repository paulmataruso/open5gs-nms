// NRF (Network Repository Function) Tooltips
export const NRF_TOOLTIPS = {
  sbi_address: "Bind address for Service-Based Interface. Use 127.0.0.10 for localhost or specific IP for external NF access",
  sbi_port: "Service-Based Interface port. Default: 7777. Must be unique per NF on same host",
  serving_mcc: "Mobile Country Code for served PLMN - 3 digits identifying the country (e.g., 001 for test, 310 for USA)",
  serving_mnc: "Mobile Network Code for served PLMN - 2-3 digits identifying the mobile network operator",
  log_path: "Path where NRF logs will be written. Ensure directory exists and is writable by open5gs-nrfd",
  log_level: "Logging verbosity. Use debug/trace for troubleshooting, info for production, warn/error to reduce noise",
};
