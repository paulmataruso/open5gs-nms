// Shapes of the real Open5GS NF YAML documents, as they exist after
// YamlConfigRepository.loadRaw() has parsed them.
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
// `AmfConfigDto` in application/dto declares that INNER list at its top level
// while config-mapper.ts assigns it the whole document (`rawYaml`) behind an
// `as any`, so it is off by one level and additionally carries document-level
// `logger`/`global` as if they were AMF fields. The frontend works around the
// same mismatch with `configs.amf as any` in ConfigPage.tsx. Those types are
// therefore NOT reusable here; correcting them is an API-contract change that
// touches the frontend, and is deliberately out of scope for a typing pass.
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

/** A UE session pool, as it appears under smf.session / upf.session. */
export interface YamlSession {
  subnet?: string;
  gateway?: string;
  dnn?: string;
  dev?: string;
}

export interface YamlAmf {
  sbi?: YamlEndpoint;
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
  sbi?: YamlEndpoint;
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
  sbi?: YamlEndpoint;
  serving?: Array<{ plmn_id?: YamlPlmnId }>;
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
}

export interface AmfYamlDocument extends YamlDocumentCommon { amf?: YamlAmf }
export interface MmeYamlDocument extends YamlDocumentCommon { mme?: YamlMme }
export interface SmfYamlDocument extends YamlDocumentCommon { smf?: YamlSmf }
export interface UpfYamlDocument extends YamlDocumentCommon { upf?: YamlUpf }
export interface SgwcYamlDocument extends YamlDocumentCommon { sgwc?: YamlSgwc }
export interface SgwuYamlDocument extends YamlDocumentCommon { sgwu?: YamlSgwu }
export interface NrfYamlDocument extends YamlDocumentCommon { nrf?: YamlNrf }
