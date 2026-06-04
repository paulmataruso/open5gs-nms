// ─── WinnForum WINNF-TS-0016-V1.2.7 types ────────────────────────────────────

export type CbsdRegistrationState = 'UNREGISTERED' | 'REGISTERED';
export type GrantState = 'GRANTED' | 'AUTHORIZED' | 'TERMINATED' | 'PENDING';
export type ChannelType           = 'GAA' | 'PAL';

// ─── CBSD document stored in MongoDB ─────────────────────────────────────────
export interface SasCbsd {
  cbsdId:           string;
  cbsdSerialNumber: string;
  fccId:            string;
  userId:           string;
  cbsdCategory:     'A' | 'B';
  state:            CbsdRegistrationState;
  airInterface?:    { radioTechnology: string };
  installationParam?: {
    latitude?:        number;
    longitude?:       number;
    height?:          number;
    heightType?:      string;
    indoorDeployment?: boolean;
    antennaGain?:     number;
    eirpCapability?:  number;
  };
  measCapability?:  string[];
  groupingParam?:   Array<{ groupType: string; groupId: string }>;
  registeredAt:     Date;
  lastSeen:         Date;
}

// ─── Grant document stored in MongoDB ────────────────────────────────────────
export interface SasGrant {
  grantId:          string;
  cbsdId:           string;
  state:            GrantState;
  channelType:      ChannelType;
  operationParam: {
    maxEirp:                  number;
    operationFrequencyRange: { lowFrequency: number; highFrequency: number };
  };
  grantExpireTime:  Date;
  heartbeatInterval: number;   // seconds
  lastHeartbeat?:   Date;
  transmitExpireTime?: Date;
  createdAt:        Date;
  // Last operationState reported by the radio in a heartbeat:
  // 'AUTHORIZED' = radio is actively transmitting
  // 'GRANTED'    = radio holds the grant but RF is off
  lastOperationState?: 'GRANTED' | 'AUTHORIZED';
}

// ─── Per-device frequency band entry ─────────────────────────────────────────
export interface SasFrequencyBand {
  id:               string;   // uuid
  label:            string;   // e.g. "Baicells Nova 436"
  lowFrequency:     number;   // Hz
  highFrequency:    number;   // Hz
  maxBandwidthMhz:  number;   // max grant width e.g. 20
  maxEirp?:         number;   // override global maxEirpGAA if set
}

// ─── SAS configuration stored in MongoDB ─────────────────────────────────────
export interface SasConfig {
  _id:                      'sas_config';
  // Legacy single-band fields (kept for backward compat, used as fallback)
  allowedBandLow:           number;
  allowedBandHigh:          number;
  maxEirpGAA:               number;
  heartbeatInterval:        number;
  grantExpireHours:         number;
  defaultGrantBandwidthMhz: number;
  autoApprove:              boolean;
  // Multi-band support
  frequencyBands:           SasFrequencyBand[];
  updatedAt:                Date;
}

// ─── Custom slot for interference-group band policy ───────────────────────────
export interface GroupBandSlot {
  low:    number;   // Hz
  high:   number;   // Hz
  label?: string;
}

// ─── Per-interference-group band policy ──────────────────────────────────────
export interface GroupBandPolicy {
  _id:          string;   // groupId e.g. "baicells"
  bandId:       string;   // SasFrequencyBand.id
  notes?:       string;
  // Optional custom slots — if set, returned verbatim instead of auto-slicing.
  // Empty array = give the FULL band to every CBSD in the group (no slicing).
  customSlots?: GroupBandSlot[];
  updatedAt:    Date;
}

// ─── Per-CBSD band policy override ───────────────────────────────────────────
// Keyed by "fccId:serial" so it survives Clear DB (cbsdId is regenerated)
export interface CbsdBandPolicy {
  _id:       string;   // "fccId:cbsdSerialNumber"
  fccId:     string;
  serial:    string;
  bandId:    string;   // SasFrequencyBand.id
  notes?:    string;
  updatedAt: Date;
}



export interface FrequencyRange {
  lowFrequency:  number;
  highFrequency: number;
}

export interface OperationParam {
  maxEirp:                  number;
  operationFrequencyRange: FrequencyRange;
}

export interface SasResponse {
  responseCode:    number;
  responseMessage: string;
  responseData?:   string[];
}

// Registration
export interface RegistrationRequest {
  userId:           string;
  fccId:            string;
  cbsdSerialNumber: string;
  callSign?:        string;
  cbsdCategory?:    'A' | 'B';
  airInterface?:    { radioTechnology: string };
  installationParam?: Record<string, any>;
  measCapability?:  string[];
  groupingParam?:   Array<{ groupType: string; groupId: string }>;
}

export interface RegistrationResponse {
  cbsdId?:          string;
  measReportConfig?: string[];
  response:         SasResponse;
}

// Spectrum Inquiry
export interface SpectrumInquiryRequest {
  cbsdId:           string;
  inquiredSpectrum: FrequencyRange[];
  measReport?:      Record<string, any>;
}

export interface AvailableChannel {
  frequencyRange: FrequencyRange;
  channelType:    ChannelType;
  ruleApplied:    string;
  maxEirp?:       number;
}

export interface SpectrumInquiryResponse {
  cbsdId?:           string;
  availableChannel?: AvailableChannel[];
  response:          SasResponse;
}

// Grant
export interface GrantRequest {
  cbsdId:         string;
  operationParam: OperationParam;
  measReport?:    Record<string, any>;
}

export interface GrantResponse {
  cbsdId?:          string;
  grantId?:         string;
  grantExpireTime?: string;
  heartbeatInterval?: number;
  operationParam?:  OperationParam;
  channelType?:     ChannelType;
  response:         SasResponse;
}

// Heartbeat
export interface HeartbeatRequest {
  cbsdId:          string;
  grantId:         string;
  grantRenew?:     boolean;
  operationState:  'GRANTED' | 'AUTHORIZED';
  measReport?:     Record<string, any>;
}

export interface HeartbeatResponse {
  cbsdId?:           string;
  grantId?:          string;
  transmitExpireTime: string;
  grantExpireTime?:  string;
  heartbeatInterval?: number;
  operationParam?:   OperationParam;
  response:          SasResponse;
}

// Relinquishment
export interface RelinquishmentRequest {
  cbsdId:  string;
  grantId: string;
}

export interface RelinquishmentResponse {
  cbsdId?:  string;
  grantId?: string;
  response: SasResponse;
}

// Deregistration
export interface DeregistrationRequest {
  cbsdId: string;
}

export interface DeregistrationResponse {
  cbsdId?:  string;
  response: SasResponse;
}

// ─── Response code helpers (Table 39) ────────────────────────────────────────
export const RC = {
  SUCCESS:              0,
  VERSION:              100,
  BLACKLISTED:          101,
  MISSING_PARAM:        102,
  INVALID_VALUE:        103,
  CERT_ERROR:           104,
  DEREGISTER:           105,
  REG_PENDING:          200,
  GROUP_ERROR:          201,
  UNSUPPORTED_SPECTRUM: 300,
  INTERFERENCE:         400,
  GRANT_CONFLICT:       401,
  TERMINATED_GRANT:     500,
  SUSPENDED_GRANT:      501,
  UNSYNC_OP_PARAM:      502,
} as const;

export const RC_MSG: Record<number, string> = {
  0:   'SUCCESS',
  100: 'VERSION',
  101: 'BLACKLISTED',
  102: 'MISSING_PARAM',
  103: 'INVALID_VALUE',
  104: 'CERT_ERROR',
  105: 'DEREGISTER',
  200: 'REG_PENDING',
  201: 'GROUP_ERROR',
  300: 'UNSUPPORTED_SPECTRUM',
  400: 'INTERFERENCE',
  401: 'GRANT_CONFLICT',
  500: 'TERMINATED_GRANT',
  501: 'SUSPENDED_GRANT',
  502: 'UNSYNC_OP_PARAM',
};

export function makeResponse(code: number, data?: string[]): SasResponse {
  return {
    responseCode:    code,
    responseMessage: RC_MSG[code] ?? 'UNKNOWN',
    ...(data ? { responseData: data } : {}),
  };
}

// ─── Timestamp format ──────────────────────────────────────────────────────
// WInnForum WINNF-TS-0016 allows both compact (20260523T211500UTC) and ISO 8601
// (2026-05-23T21:15:00Z) formats. Baicells BaiBLQ firmware only accepts ISO 8601.
export function sasFmt(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
  // e.g. "2026-05-23T21:15:00Z"
}
