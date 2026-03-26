import { ObjectId } from 'mongodb';

export interface SubscriberSecurity {
  k: string;
  op?: string | null;
  opc: string;
  amf: string;
  sqn?: number;
}

export interface SubscriberAmbr {
  uplink: { value: number; unit: number };
  downlink: { value: number; unit: number };
}

export interface SubscriberQos {
  index: number;
  arp: {
    priority_level: number;
    pre_emption_capability: number;
    pre_emption_vulnerability: number;
  };
}

export interface SubscriberSession {
  _id?: string;
  name: string;  // DNN/APN
  type: number;  // 1=IPv4, 2=IPv6, 3=IPv4v6
  ambr: SubscriberAmbr;
  qos: SubscriberQos;
  pcc_rule?: unknown[];
  ue?: {
    ipv4?: string;   // UE IPv4 address (note: ipv4, not addr)
    ipv6?: string;   // UE IPv6 address (note: ipv6, not addr6)
  };
  smf?: {
    ipv4?: string;   // SMF IPv4 address
    ipv6?: string;   // SMF IPv6 address
  };
}

export interface SubscriberSlice {
  _id?: string;
  sst: number;
  sd?: string;
  default_indicator?: boolean;
  session: SubscriberSession[];
}

export interface Subscriber {
  _id?: ObjectId;
  imsi: string;
  msisdn?: string[];
  imeisv?: string | string[];  // Can be string or array
  mme_host?: string | string[];  // MME hostname
  mme_realm?: string | string[];  // MME realm
  purge_flag?: boolean | boolean[];  // Purge flag for detach
  mme_timestamp?: number;  // MME timestamp
  security: SubscriberSecurity;
  ambr: SubscriberAmbr;
  slice: SubscriberSlice[];
  subscribed_rau_tau_timer?: number;  // in minutes
  subscriber_status?: number;  // 0=SERVICE_GRANTED, 1=OPERATOR_DETERMINED_BARRING
  operator_determined_barring?: number;  // Bitmask: 0=all-packet-oriented-services-barred, etc.
  access_restriction_data?: number;  // Bitmask for access restrictions (32 = default)
  network_access_mode?: number;  // 0=PACKET_AND_CIRCUIT, 1=Reserved, 2=ONLY_PACKET
  schema_version?: number;
  __v?: number;
}

export interface SubscriberListItem {
  imsi: string;
  msisdn?: string[];
  slice_count: number;
  session_count: number;
}
