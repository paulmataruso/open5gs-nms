// Shapes of the real Open5GS NF YAML documents, as they exist after
// YamlConfigRepository.loadRaw() has parsed them.
//
// This file is MIRRORED VERBATIM to frontend/src/types/open5gs-yaml.ts,
// because the frontend consumes the same payload and the two workspaces share
// no package. open5gs-yaml-frontend-mirror.test.ts fails if they drift -- which
// is not a hypothetical: a hand-written second copy of these shapes in
// frontend/src/types/index.ts is exactly what let the old DTO mismatch below
// persist on both sides at once. Edit this file; copy it over.
//
// ── Why these are DOCUMENT types, and why the existing DTOs are not ──
//
// `rawYaml` is the whole parsed file, so an NF's own settings sit one level
// down under its own name:
//
//   { logger: {...}, global: {...}, amf: { sbi, ngap, guami, ... } }
//
// Verified against the live deployment's own API (GET /api/config, 2026-11-26):
// `data.amf` has keys ['amf','global','logger'] and `data.amf.amf` has
// ['amf_name','guami','metrics','network_name','ngap','plmn_support','sbi',
// 'security','tai','time'].
//
// The `*ConfigDto` types in application/dto used to declare that INNER list at
// their own top level while config-mapper.ts assigned them the whole document
// (`rawYaml`) behind an `as any` -- off by one level, and additionally carrying
// document-level `logger`/`global` as if they were the NF's own fields. They
// are now ALIASES of the `*YamlDocument` types at the end of this file, so the
// declared shape and the shape the API really sends cannot drift again. The
// frontend's own mirror of them (frontend/src/types/index.ts) was corrected in
// the same change.
//
// ── Rules these types follow ──
//
// Everything is optional. A file may predate a field, an operator may have
// removed one by hand, and loadRaw() returns `{}` on a parse error — so a
// present field is the exception to prove, not the rule to assume.
//
// `mcc`/`mnc`/`sd` are STRINGS, and that is load-bearing rather than cosmetic:
// js-yaml reads a bare `070` as octal 56, so loadRaw() re-reads those three
// keys out of the raw text and substitutes the string form back in
// (fixMccMncSdFromRawYaml). Confirmed live: mcc '001', mnc '01', sd '19cde1'.
// Typing them as numbers would invite arithmetic on a value that is really a
// zero-padded identifier.
//
// Unknown keys are NOT modelled and must stay intact. saveRaw() re-reads the
// file and deepMerge()s, so fields the NMS does not know about survive a save.
// A caller that deep-clones a document (JSON.parse(JSON.stringify(doc))) keeps
// them; a caller that builds a fresh object from these types would drop them.
// Clone and mutate — never rebuild.

/** A PLMN identifier. Both halves are zero-padded strings, never numbers. */
export interface YamlPlmnId {
  mcc?: string;
  mnc?: string;
}

/** An S-NSSAI. `sst` is a real number; `sd` is a hex string. */
export interface YamlSnssai {
  sst?: number;
  sd?: string;
}

/**
 * One entry of a `server:` list. `address` is a list in some files and a
 * scalar in others, which is why it is a union rather than a string.
 */
export interface YamlServerEntry {
  address?: string | string[];
  port?: number;
  advertise?: string | string[];
  dev?: string;
  /**
   * Only meaningful on an sgwc->sgwu peer entry, where it selects which TACs
   * that SGW-U serves. Scalar or list, like every other repeatable value here.
   */
  tac?: number | number[];
}

/** The `server:`/`client:` pair shared by sbi, ngap, s1ap, pfcp, gtpu, gtpc. */
export interface YamlEndpoint {
  server?: YamlServerEntry[];
  client?: Record<string, unknown>;
}

/** One `{ uri: ... }` entry of an sbi client list. */
export interface YamlUriEntry {
  uri?: string;
  resolve?: string;
}

/**
 * `sbi.client`, which is how a 5G NF is told where to reach NRF or SCP.
 * Modelled rather than left as `unknown` because real code depends on these
 * three keys: cross-service-validator.ts treats "neither nrf nor scp present"
 * as a misconfiguration, and dns-migration-usecase.ts rewrites all three
 * lists' URIs. The index signature keeps any other client list assignable.
 */
export interface YamlSbiClient {
  [key: string]: unknown;
  nrf?: YamlUriEntry[];
  scp?: YamlUriEntry[];
  /** NSSF only: each NSI carries the slice it serves alongside its uri. */
  nsi?: Array<YamlUriEntry & { s_nssai?: YamlSnssai }>;
}

/** An `sbi:` block. Distinct from YamlEndpoint only in that its client is typed. */
export interface YamlSbiEndpoint {
  server?: YamlServerEntry[];
  client?: YamlSbiClient;
}

/** A UE session pool, as it appears under smf.session / upf.session. */
export interface YamlSession {
  subnet?: string;
  gateway?: string;
  dnn?: string;
  dev?: string;
}

export interface YamlAmf {
  sbi?: YamlSbiEndpoint;
  ngap?: YamlEndpoint;
  metrics?: YamlEndpoint;
  guami?: Array<{ plmn_id?: YamlPlmnId; amf_id?: { region?: number; set?: number; pointer?: number } }>;
  tai?: Array<{ plmn_id?: YamlPlmnId; tac?: number | number[] }>;
  plmn_support?: Array<{ plmn_id?: YamlPlmnId; s_nssai?: YamlSnssai[] }>;
  security?: { integrity_order?: string[]; ciphering_order?: string[] };
  network_name?: { full?: string; short?: string };
  amf_name?: string;
  time?: Record<string, { value?: number }>;
}

export interface YamlMme {
  s1ap?: YamlEndpoint;
  gtpc?: YamlEndpoint;
  metrics?: YamlEndpoint;
  gummei?: Array<{ plmn_id?: YamlPlmnId; mme_gid?: number; mme_code?: number }>;
  tai?: Array<{ plmn_id?: YamlPlmnId; tac?: number | number[] }>;
  security?: { integrity_order?: string[]; ciphering_order?: string[] };
  network_name?: { full?: string; short?: string };
  mme_name?: string;
  /** Presence is what callers test; the contents are freeDiameter's own. */
  freeDiameter?: unknown;
  sgsap?: unknown;
  /**
   * `maps` not `map`: mme.yaml uses duplicate `map:` keys, which standard YAML
   * cannot express, so loadRaw() rewrites them into an array on the way in and
   * saveRaw() rewrites them back on the way out.
   */
  maps?: unknown[];
}

export interface YamlSmf {
  sbi?: YamlSbiEndpoint;
  pfcp?: YamlEndpoint & { client?: { upf?: YamlServerEntry[] } };
  gtpc?: YamlEndpoint;
  gtpu?: YamlEndpoint;
  metrics?: YamlEndpoint;
  session?: YamlSession[];
  dns?: string[];
  mtu?: number;
  info?: Array<{ tai?: Array<{ plmn_id?: YamlPlmnId; tac?: number | number[] }> } & Record<string, unknown>>;
  freeDiameter?: unknown;
  'p-cscf'?: unknown;
}

export interface YamlUpf {
  pfcp?: YamlEndpoint;
  gtpu?: YamlEndpoint;
  metrics?: YamlEndpoint;
  session?: YamlSession[];
}

export interface YamlSgwc {
  gtpc?: YamlEndpoint;
  pfcp?: YamlEndpoint & { client?: { sgwu?: YamlServerEntry[] } };
}

export interface YamlSgwu {
  gtpu?: YamlEndpoint;
  pfcp?: YamlEndpoint;
}

export interface YamlNrf {
  sbi?: YamlSbiEndpoint;
  serving?: Array<{ plmn_id?: YamlPlmnId }>;
}

// ── The remaining ten NFs ──
//
// Shapes read off this deployment's own live files (2026-11-26), which is also
// where the three shape errors noted inline below were found. Five of them
// (scp, ausf, udr, nssf, bsf) are nothing but an `sbi:` block today; they are
// still given their own named type rather than one shared alias, because an NF
// that later grows a field should not silently widen the other four.

export interface YamlScp {
  sbi?: YamlSbiEndpoint;
}

export interface YamlAusf {
  sbi?: YamlSbiEndpoint;
}

export interface YamlUdm {
  sbi?: YamlSbiEndpoint;
  /**
   * SUCI home-network keys. upsertUdmHnetBlock() in suci-management.ts edits
   * this block as TEXT to keep its comments, so a save through this type is
   * not the only writer -- see CLAUDE.md pattern #2.
   */
  hnet?: Array<{ id?: number; scheme?: number; key?: string }>;
}

export interface YamlUdr {
  sbi?: YamlSbiEndpoint;
}

export interface YamlPcf {
  sbi?: YamlSbiEndpoint;
  metrics?: YamlEndpoint;
  /** Named QoS profiles. `qosVoNR` is the 5QI=1 entry VoNR's N5 path needs. */
  qos_profiles?: Array<Record<string, unknown>>;
  /** Upstream supports a policy block here; absent on this deployment. */
  policy?: Array<Record<string, unknown>>;
}

export interface YamlNssf {
  /** The NSI list lives under `sbi.client.nsi`, NOT at the NF's top level. */
  sbi?: YamlSbiEndpoint;
}

export interface YamlBsf {
  sbi?: YamlSbiEndpoint;
}

export interface YamlSepp {
  sbi?: YamlSbiEndpoint;
  n32?: {
    /** A LIST. SeppConfigDto declared a single object here, which it is not. */
    server?: Array<{
      sender?: string;
      scheme?: string;
      address?: string | string[];
      port?: number;
      n32f?: { scheme?: string; address?: string | string[]; port?: number };
    }>;
    client?: {
      sepp?: Array<{
        receiver?: string;
        uri?: string;
        resolve?: string;
        n32f?: { uri?: string; resolve?: string };
      }>;
    };
  };
  /** TLS sits under `sepp.default.tls` -- a level deeper than SeppConfigDto had it. */
  default?: {
    tls?: {
      server?: { private_key?: string; cert?: string; verify_client?: boolean; verify_client_cacert?: string };
      client?: { cacert?: string; client_private_key?: string; client_cert?: string };
    };
  };
}

export interface YamlHss {
  /** A PATH to the freeDiameter .conf file, not the configuration itself. */
  freeDiameter?: string;
  metrics?: YamlEndpoint;
  /** `"auto"` here is what makes HSS hand SMS to IMS rather than to SGs. */
  sms_over_ims?: string;
  use_mongodb_change_stream?: boolean;
}

export interface YamlPcrf {
  freeDiameter?: string;
  metrics?: YamlEndpoint;
}

/** Document-level keys, present in every NF file regardless of which NF it is. */
export interface YamlDocumentCommon {
  /**
   * Unknown top-level keys are reachable rather than erased. saveRaw()
   * deep-merges on top of the file on disk, so hand-added sections survive a
   * save — and this index signature is what keeps them assignable back to
   * `rawYaml: Record<string, unknown>` without a cast. Declared keys below
   * keep their real types; only the undeclared ones read as `unknown`.
   */
  [key: string]: unknown;
  logger?: { level?: string; file?: { path?: string } | string };
  global?: Record<string, unknown>;
  /** smf.yaml carries this at document level, outside the `smf:` block. */
  parameter?: Record<string, unknown>;
  /**
   * Document level on hss/pcf/pcrf/udr, outside the NF's own block -- verified
   * live. UdrConfigDto was the only DTO that declared it, which is why it was
   * the only one that happened to be right about where it lives.
   */
  db_uri?: string;
}

export interface AmfYamlDocument extends YamlDocumentCommon { amf?: YamlAmf }
export interface MmeYamlDocument extends YamlDocumentCommon { mme?: YamlMme }
export interface SmfYamlDocument extends YamlDocumentCommon { smf?: YamlSmf }
export interface UpfYamlDocument extends YamlDocumentCommon { upf?: YamlUpf }
export interface SgwcYamlDocument extends YamlDocumentCommon { sgwc?: YamlSgwc }
export interface SgwuYamlDocument extends YamlDocumentCommon { sgwu?: YamlSgwu }
export interface NrfYamlDocument extends YamlDocumentCommon { nrf?: YamlNrf }
export interface ScpYamlDocument extends YamlDocumentCommon { scp?: YamlScp }
export interface AusfYamlDocument extends YamlDocumentCommon { ausf?: YamlAusf }
export interface UdmYamlDocument extends YamlDocumentCommon { udm?: YamlUdm }
export interface UdrYamlDocument extends YamlDocumentCommon { udr?: YamlUdr }
export interface PcfYamlDocument extends YamlDocumentCommon { pcf?: YamlPcf }
export interface NssfYamlDocument extends YamlDocumentCommon { nssf?: YamlNssf }
export interface BsfYamlDocument extends YamlDocumentCommon { bsf?: YamlBsf }
export interface HssYamlDocument extends YamlDocumentCommon { hss?: YamlHss }
export interface PcrfYamlDocument extends YamlDocumentCommon { pcrf?: YamlPcrf }
/**
 * sepp1.yaml and sepp2.yaml BOTH nest under `sepp`, not under their own file
 * name -- so the document key does not always match the config key. Any
 * mechanical "wrap each NF in a block named after itself" is wrong here, and
 * SeppEditor.tsx already reads `configs.sepp1` then `.sepp` for this reason.
 */
export interface SeppYamlDocument extends YamlDocumentCommon { sepp?: YamlSepp }
