// ─────────────────────────────────────────────────────────────
// Domain Entity: APN/DNN Profile
// ─────────────────────────────────────────────────────────────
// #30: a single, persisted object for "this is APN `ptt.example.com`, pool
// `198.51.100.0/24` on device `ptt`" — today that only exists as two
// disconnected fragments (an smf.yaml session[].dnn+subnet block and a
// matching upf.yaml session[].subnet+dev block), edited independently
// through SmfEditor.tsx/UpfEditor.tsx with nothing keeping them in sync.
//
// This is NMS-only metadata layered on top of the real Open5GS config, not a
// replacement for smf.yaml/upf.yaml — saving a profile also writes both
// files (see apn-profile-usecase.ts), and this record's subnet/gateway/dev/
// dnn fields are expected to always mirror what's actually configured there.
// No per-user ownership field, same single-tenant convention as every other
// collection in this system (subscribers, SAS grants, RF planning projects).
export interface ApnProfile {
  id: string;
  dnn: string;
  dev: string;
  // IPv4, required — the static/dynamic split and AutoAssignIPsUseCase
  // integration are IPv4-only, matching this codebase's existing CIDR math
  // (no IPv6 overlap helper exists anywhere — confirmed during #28).
  subnet: string;
  gateway: string;
  // Optional, display/documentation only — no v6 range-splitting logic.
  subnetV6?: string;
  gatewayV6?: string;
  qos: {
    index: number;
    arp: {
      priority_level: number;
      pre_emption_capability: number;
      pre_emption_vulnerability: number;
    };
  };
  // Static (hand-assigned, e.g. fixed-IP CPE/M2M) vs. dynamic (auto-assign
  // draws exclusively from here — see AutoAssignIPsUseCase) sub-ranges
  // within `subnet`. Both null until an operator defines them; a freshly
  // "Saved as Profile" derived entry defaults the whole pool to dynamic
  // (static null) since intent can't be inferred from existing config alone.
  staticRangeStart: string | null;
  staticRangeEnd: string | null;
  dynamicRangeStart: string | null;
  dynamicRangeEnd: string | null;
  createdAt: string;
  updatedAt: string;
}

// A DNN discovered live from smf.yaml/upf.yaml (via resolveDnnDevPairs())
// with no matching ApnProfile record yet — immediately usable (e.g. in the
// Subscriber form dropdown) without forcing a migration step, but not yet a
// real, editable Profile until "Save as Profile" promotes it to one.
export interface DerivedApnProfile {
  persisted: false;
  dnn: string;
  dev: string;
  subnet: string;
  gateway: string | null;
}

export type ApnProfileListEntry = (ApnProfile & { persisted: true }) | DerivedApnProfile;
