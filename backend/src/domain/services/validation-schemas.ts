import { z } from 'zod';

// ── Primitives ──
export const mccSchema = z
  .string()
  .regex(/^\d{3}$/, 'MCC must be exactly 3 digits');

export const mncSchema = z
  .string()
  .regex(/^\d{2,3}$/, 'MNC must be 2 or 3 digits');

export const tacSchema = z
  .number()
  .int()
  .min(0)
  .max(65535, 'TAC must be 0–65535');

export const ipv4Schema = z
  .string()
  .regex(
    /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/,
    'Invalid IPv4 address',
  );

export const cidrSchema = z
  .string()
  .regex(
    /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\/(?:[12]?\d|3[0-2])$/,
    'Invalid CIDR notation',
  );

export const portSchema = z.number().int().min(1).max(65535);

export const ipOrArraySchema = z.union([ipv4Schema, z.array(ipv4Schema).min(1)]);

export const imsiSchema = z
  .string()
  .regex(/^\d{15}$/, 'IMSI must be exactly 15 digits');

export const hexKeySchema = z
  .string()
  .regex(/^[0-9a-fA-F]{32}$/, 'Must be 32 hex characters');

export const ambrValueSchema = z.object({
  value: z.number().int().positive(),
  unit: z.number().int().min(0).max(4),
});

export const ambrSchema = z.object({
  uplink: ambrValueSchema,
  downlink: ambrValueSchema,
});

// ── PLMN ──
export const plmnIdSchema = z.object({
  mcc: mccSchema,
  mnc: mncSchema,
});

// ── S-NSSAI ──
export const snssaiSchema = z.object({
  sst: z.number().int().min(0).max(255),
  sd: z.string().regex(/^[0-9a-fA-F]{6}$/).optional(),
});

// ── SBI ──
export const sbiSchema = z.object({
  addr: ipOrArraySchema,
  port: portSchema.optional(),
});

// ── PFCP ──
export const pfcpSchema = z.object({
  addr: ipv4Schema,
  port: portSchema.optional(),
});

// ── GTPU ──
export const gtpuSchema = z.object({
  addr: ipv4Schema,
  port: portSchema.optional(),
});

// ── Logger ──
export const loggerSchema = z.object({
  file: z.string().optional(),
  level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).optional(),
}).optional();

// ── NRF ──
export const nrfConfigSchema = z.object({
  sbi: sbiSchema,
  logger: loggerSchema,
});

// ── AMF ──
export const amfGuamiSchema = z.object({
  plmn_id: plmnIdSchema,
  amf_id: z.object({
    region: z.number().int().min(0).max(255),
    set: z.number().int().min(0).max(1023),
    pointer: z.number().int().min(0).max(63),
  }),
});

export const amfTaiSchema = z.object({
  plmn_id: plmnIdSchema,
  tac: z.union([tacSchema, z.array(tacSchema).min(1)]),
});

export const amfPlmnSupportSchema = z.object({
  plmn_id: plmnIdSchema,
  s_nssai: z.array(snssaiSchema).min(1),
});

export const amfConfigSchema = z.object({
  sbi: sbiSchema,
  ngap: z.object({
    addr: ipOrArraySchema,
    port: portSchema.optional(),
  }),
  guami: z.array(amfGuamiSchema).min(1),
  tai: z.array(amfTaiSchema).min(1),
  plmn_support: z.array(amfPlmnSupportSchema).min(1),
  security: z.object({
    integrity_order: z.array(z.string()).optional(),
    ciphering_order: z.array(z.string()).optional(),
  }).optional(),
  network_name: z.object({
    full: z.string().optional(),
    short: z.string().optional(),
  }).optional(),
  amf_name: z.string().optional(),
  nrf: z.object({
    sbi: sbiSchema,
  }).optional(),
  logger: loggerSchema,
});

// ── SMF ──
export const smfSubnetSchema = z.object({
  addr: cidrSchema,
  dnn: z.string().optional(),
});

export const smfSessionSchema = z.object({
  subnet: z.array(smfSubnetSchema).min(1),
  dns: z.array(z.object({ addr: ipOrArraySchema.optional() })).optional(),
});

export const smfInfoSchema = z.object({
  s_nssai: z.array(snssaiSchema).min(1),
  dnn: z.array(z.string()).min(1),
});

export const smfConfigSchema = z.object({
  sbi: sbiSchema,
  pfcp: pfcpSchema,
  gtpc: z.object({ addr: ipOrArraySchema }).optional(),
  gtpu: gtpuSchema.optional(),
  session: z.array(smfSessionSchema).optional(),
  dns: z.array(z.string()).optional(),
  mtu: z.number().int().min(576).max(9000).optional(),
  freeDiameter: z.string().optional(),
  info: z.array(smfInfoSchema).optional(),
  nrf: z.object({ sbi: sbiSchema }).optional(),
  logger: loggerSchema,
});

// ── UPF ──
export const upfSubnetSchema = z.object({
  addr: cidrSchema,
  dnn: z.string().optional(),
  dev: z.string().optional(),
});

export const upfSessionSchema = z.object({
  subnet: z.array(upfSubnetSchema).min(1),
});

export const upfConfigSchema = z.object({
  pfcp: pfcpSchema,
  gtpu: gtpuSchema,
  session: z.array(upfSessionSchema).optional(),
  logger: loggerSchema,
});

// ── AUSF ──
export const ausfConfigSchema = z.object({
  sbi: sbiSchema,
  nrf: z.object({ sbi: sbiSchema }).optional(),
  logger: loggerSchema,
});

// ── Subscriber ──
export const subscriberSecuritySchema = z.object({
  k: hexKeySchema,
  op: z.string().regex(/^[0-9a-fA-F]{32}$/).nullable().optional(),
  opc: hexKeySchema,
  amf: z.string().regex(/^[0-9a-fA-F]{4}$/, 'AMF must be 4 hex chars'),
  sqn: z.number().int().optional(),
});

export const subscriberQosSchema = z.object({
  index: z.number().int().min(1).max(255),
  arp: z.object({
    priority_level: z.number().int().min(1).max(15),
    pre_emption_capability: z.number().int().min(1).max(2),
    pre_emption_vulnerability: z.number().int().min(1).max(2),
  }),
});

export const subscriberSessionSchema = z.object({
  _id: z.string().optional(),
  name: z.string().min(1),  // DNN/APN
  type: z.number().int().min(1).max(3),  // 1=IPv4, 2=IPv6, 3=IPv4v6
  ambr: ambrSchema,
  qos: subscriberQosSchema,
  pcc_rule: z.array(z.unknown()).optional(),
  ue: z.object({
    ipv4: ipv4Schema.optional(),   // UE IPv4 address (note: ipv4, not addr)
    ipv6: z.string().optional(),  // UE IPv6 address (note: ipv6, not addr6)
  }).optional(),
  smf: z.object({
    ipv4: ipv4Schema.optional(),   // SMF IPv4 address
    ipv6: z.string().optional(),   // SMF IPv6 address
  }).optional(),
});

export const subscriberSliceSchema = z.object({
  _id: z.string().optional(),
  sst: z.number().int().min(0).max(255),
  sd: z.string().regex(/^[0-9a-fA-F]{6}$/).optional(),
  default_indicator: z.boolean().optional(),
  session: z.array(subscriberSessionSchema).min(1),
});

export const subscriberSchema = z.object({
  imsi: imsiSchema,
  msisdn: z.array(z.string()).optional(),
  imeisv: z.union([z.string(), z.array(z.string())]).optional(),
  mme_host: z.union([z.string(), z.array(z.string())]).optional(),
  mme_realm: z.union([z.string(), z.array(z.string())]).optional(),
  purge_flag: z.union([z.boolean(), z.array(z.boolean())]).optional(),
  mme_timestamp: z.number().int().optional(),
  security: subscriberSecuritySchema,
  ambr: ambrSchema,
  slice: z.array(subscriberSliceSchema).min(1),
  subscribed_rau_tau_timer: z.number().int().min(0).optional(),  // in minutes
  subscriber_status: z.number().int().min(0).max(1).optional(),  // 0=SERVICE_GRANTED, 1=OPERATOR_DETERMINED_BARRING
  operator_determined_barring: z.number().int().min(0).optional(),  // Bitmask
  access_restriction_data: z.number().int().min(0).optional(),  // Bitmask (32 = default)
  network_access_mode: z.number().int().min(0).max(2).optional(),  // 0=PACKET_AND_CIRCUIT, 2=ONLY_PACKET
  schema_version: z.number().optional(),
});
