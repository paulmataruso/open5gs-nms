// UI module toggles — controlled via .env (ENABLE_SMS_MODULE / ENABLE_IMS_MODULE /
// ENABLE_VALIDATION_MODULE), baked in at build time like the other VITE_* vars
// in this app (see frontend/Dockerfile). Requires a frontend rebuild to take effect.
// Defaults to enabled unless explicitly set to 'false' — EXCEPT `pstn`, which
// defaults to *disabled* (opt-in via ENABLE_PSTN_MODULE=true): it's the first
// module where a bug/misconfiguration can cause real-world billing on a linked
// SIP trunk account, not just a broken lab feature.
export const FEATURES = {
  sms: import.meta.env.VITE_ENABLE_SMS !== 'false',
  ims: import.meta.env.VITE_ENABLE_IMS !== 'false',
  validation: import.meta.env.VITE_ENABLE_VALIDATION !== 'false',
  vowifi: import.meta.env.VITE_ENABLE_VOWIFI !== 'false',
  dnsMigration: import.meta.env.VITE_ENABLE_DNS_MIGRATION !== 'false',
  pcap: import.meta.env.VITE_ENABLE_PCAP !== 'false',
  pstn: import.meta.env.VITE_ENABLE_PSTN === 'true',
  // Same opt-in-by-default posture as pstn: MMS depends on a from-source-built
  // third-party binary (VectorCore MMSC) running as a host service, not just a
  // config toggle — defaults off until explicitly enabled.
  mms: import.meta.env.VITE_ENABLE_MMS === 'true',
};
