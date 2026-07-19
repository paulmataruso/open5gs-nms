// UI module toggles — controlled via .env (ENABLE_SMS_MODULE / ENABLE_IMS_MODULE /
// ENABLE_VALIDATION_MODULE), baked in at build time like the other VITE_* vars
// in this app (see frontend/Dockerfile). Requires a frontend rebuild to take effect.
// Defaults to enabled unless explicitly set to 'false'.
export const FEATURES = {
  sms: import.meta.env.VITE_ENABLE_SMS !== 'false',
  ims: import.meta.env.VITE_ENABLE_IMS !== 'false',
  validation: import.meta.env.VITE_ENABLE_VALIDATION !== 'false',
  vowifi: import.meta.env.VITE_ENABLE_VOWIFI !== 'false',
  dnsMigration: import.meta.env.VITE_ENABLE_DNS_MIGRATION !== 'false',
  pcap: import.meta.env.VITE_ENABLE_PCAP !== 'false',
};
