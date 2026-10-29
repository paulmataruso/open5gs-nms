import axios from 'axios';

// SASBench, the CBRS SAS. It runs as its own container and owns the SAS-CBSD
// protocol ports directly — radios talk to it, not to this NMS. Everything
// that changes SAS *state* lives in SASBench's own admin UI, which the SAS
// page links to; nothing here writes it.
//
// The one thing this NMS does own is keeping SASBench itself current: it
// tracks the upstream checkout and applies updates (see getVersion/update).
const api = axios.create({ baseURL: '/api/sas', withCredentials: true });

export interface SasListener {
  enabled: boolean;
  listening: boolean;
  port: number;
  error: string | null;
}

export interface SasOccupancy {
  bandLowHz: number;
  bandHighHz: number;
  bandMHz: number;
  /** Sum of grant widths — SASBench's own authorizedMHz. Can exceed the band. */
  grantedMHz: number;
  /** Union of grant ranges: distinct spectrum in use. Never exceeds bandMHz. */
  distinctMHz: number;
  occupancyPct: number;
  /** Most grants sharing any one frequency. 1 = nothing is co-channel. */
  maxOverlap: number;
  largestGapMHz: number;
  liveGrants: number;
}

/** Derived by the NMS from the real grant ranges, not reported by SASBench. */
export interface SasDerived {
  occupancy: SasOccupancy;
  radiosWithGrant: number;
  radiosIdle: number;
  byCategory: { A: number; B: number; unknown: number };
  byChannelType: Record<string, number>;
}

export interface SasProtection {
  id: string;
  name: string;
  kind: string;
  source: string;
  low: number;
  high: number;
  active: boolean;
  /** Sub-ranges this protection blocks; null means the whole low..high span. */
  channels: number[][] | null;
  action: 'suspend' | 'terminate';
}

export interface SasPpa {
  id: string;
  name: string;
  channels: Array<{ low: number; high: number; palId: string | null }>;
  members: string[];
}

export interface SasSpectrumGrant {
  grantId: string;
  cbsdId: string;
  state: 'GRANTED' | 'AUTHORIZED';
  suspended: boolean;
  low: number;
  high: number;
  maxEirp: number;
  channelType: string;
}

export interface SasSpectrumCbsd {
  cbsdId: string;
  fccId: string;
  serial: string;
  category: string | null;
  indoor: boolean | null;
}

export interface SasSpectrum {
  reachable: boolean;
  error?: string;
  band: { low: number; high: number } | null;
  gaaRanges: Array<{ low: number; high: number }>;
  protections: SasProtection[];
  ppas: SasPpa[];
  grants: SasSpectrumGrant[];
  cbsds: SasSpectrumCbsd[];
  derived?: SasDerived;
}

export interface SasStatus {
  /** False when SASBench could not be reached at all — the card's main state. */
  reachable: boolean;
  /** Host port of SASBench's own admin UI, for the link out. */
  uiPort: number;
  error?: string;
  httpStatus?: number;

  version?: string;
  startedAt?: number;
  now?: number;
  hostname?: string;
  /** Null when the live settings match no named preset. */
  profile?: string | null;
  listeners?: {
    http: SasListener;
    https: SasListener & {
      clientAuth: string;
      /** Names of the server certificates in use, e.g. one RSA and one ECDSA. */
      serverCerts?: string[];
      /** How many CAs SASBench will accept a client certificate from. */
      trustAnchors?: number;
      /** Colon-separated OpenSSL suite names, as SASBench reports them. */
      ciphers?: string;
      protocols?: string;
    };
  };
  /** The protocol URLs SASBench advertises, one per host address. */
  urls?: string[];
  /** Band occupancy and radio/grant breakdowns the NMS derives itself. */
  derived?: SasDerived;
  /** Whether SASBench asks radios for a measurement report, and when. */
  triggers?: { measInRegistration: boolean; measInHeartbeat: boolean };
  flags?: {
    ntiaExclusionZones: boolean;
    scheduledDailyActivities: boolean;
    /** ESC (Environmental Sensing Capability) feed state. */
    escConnected: boolean;
  };
  /** Elevation tiles backing the Category A HAAT check. */
  terrain?: { directory: string; tiles: number };
  counts?: {
    cbsdsRegistered: number;
    cbsdsPending: number;
    cbsdsTotal: number;
    grantsByState: Record<string, number>;
    authorizedMHz: number;
    messagesLastHour: number;
    errorsLastHour: number;
    activeProtections: number;
    ppas: number;
    faultRules: number;
  };
}

export interface SasCbsd {
  cbsdId: string;
  fccId: string;
  serial: string;
  state: 'REGISTERED' | 'PENDING' | 'UNREGISTERED';
  category: string | null;
  userId: string | null;
  remoteAddr: string | null;
  transport: string | null;
  lastSeen: number | null;
  /** Grant count by state. */
  grants: Record<string, number>;
}

export interface SasGrant {
  grantId: string;
  cbsdId: string;
  fccId: string | null;
  serial: string | null;
  state: 'GRANTED' | 'AUTHORIZED' | 'TERMINATED' | 'RELINQUISHED' | 'EXPIRED' | 'DELETED';
  suspended: boolean;
  /** Hz. */
  low: number;
  high: number;
  /** dBm/MHz. */
  maxEirp: number;
  channelType: 'GAA' | 'PAL';
  /** Epoch ms. SASBench stores every timestamp this way, not as an ISO string. */
  grantExpireTime: number;
  transmitExpireTime: number | null;
  heartbeatInterval: number;
  lastHeartbeat: number | null;
}

export interface SasBenchVersion {
  /** SASBENCH_DIR is a git checkout the NMS can update. False is its own
   *  state — "cannot be updated from here", NOT "up to date". */
  managed: boolean;
  dir: string;
  reason?: string;
  remoteUrl?: string;
  branch?: string;
  localCommit?: string;
  localDate?: string;
  localSubject?: string;
  upstreamCommit?: string;
  upstreamDate?: string;
  upstreamSubject?: string;
  /** Upstream commits this checkout does not have. 0 means current. */
  behind?: number;
  /** Local commits not upstream — a pull would not fast-forward. */
  ahead?: number;
  dirty?: boolean;
  /** Last SUCCESSFUL upstream refresh. */
  fetchedAt?: string | null;
  /** Set when the last refresh failed — `behind` may then be stale. */
  fetchError?: string;
  /** The version SASBench reports about itself, when reachable. */
  runningVersion?: string;
}

export const sasApi = {
  getStatus: async (): Promise<SasStatus> => {
    const { data } = await api.get('/status');
    return data;
  },
  getCbsds: async (): Promise<{ reachable: boolean; cbsds: SasCbsd[]; total: number; error?: string }> => {
    const { data } = await api.get('/cbsds');
    return data;
  },
  /** Live grants only (GRANTED + AUTHORIZED); ended ones are filtered server-side. */
  getGrants: async (): Promise<{ reachable: boolean; grants: SasGrant[]; total: number; error?: string }> => {
    const { data } = await api.get('/grants');
    return data;
  },

  /** Everything the band-occupancy chart draws. */
  getSpectrum: async (): Promise<SasSpectrum> => {
    const { data } = await api.get('/spectrum');
    return data;
  },

  /**
   * Installed vs upstream SASBench.
   *
   * `refresh` contacts the git remote, so it is only passed when the operator
   * asks — the page's own poll must never send it, or a status page becomes a
   * fetch to GitHub every few seconds.
   */
  getVersion: async (refresh = false): Promise<SasBenchVersion> => {
    const { data } = await api.get('/version', { params: refresh ? { refresh: '1' } : undefined });
    return data;
  },

  /**
   * Apply an upstream update: pull, rebuild the image, recreate the container.
   * Streams plain-text progress; `onLine` is called as output arrives.
   *
   * Read with fetch(), not axios: axios buffers the whole body, so a build
   * that takes minutes would show nothing until it finished.
   */
  update: async (onLine: (text: string) => void): Promise<void> => {
    const res = await fetch('/api/sas/update', { method: 'POST', credentials: 'include' });
    if (!res.body) {
      onLine(await res.text());
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onLine(decoder.decode(value, { stream: true }));
    }
  },
};

/**
 * URL of SASBench's own admin UI.
 *
 * Built from the browser's current hostname, not from anything the backend
 * reports: SASBench binds the host directly, and the backend's own view of
 * its address (127.0.0.1) is not reachable from the operator's machine.
 */
export function sasbenchUiUrl(uiPort: number): string {
  return `${window.location.protocol}//${window.location.hostname}:${uiPort}/`;
}
