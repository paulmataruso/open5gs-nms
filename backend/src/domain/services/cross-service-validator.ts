import { AllConfigs } from '../interfaces/config-repository';
import { ValidationResult, ValidationError } from '../value-objects/validation-result';

function resolveAddr(addr: string | string[] | undefined): string | null {
  if (!addr) return null;
  if (Array.isArray(addr)) return addr[0] || null;
  return addr;
}

function plmnKey(mcc: string, mnc: string): string {
  return `${mcc}-${mnc}`;
}

/**
 * Walks a property chain on a parsed-YAML document whose shape is not known.
 *
 * `rawYaml` is `Record<string, unknown>` (see domain/entities/generic-config.ts)
 * because it is whatever the operator's file actually contains, including keys
 * the NMS does not model. This descends it without asserting any of that away:
 * a missing key, a null, or a scalar where an object was expected all yield
 * `undefined` instead of throwing. Replaces the `raw: any` parameters this file
 * used to carry, which disabled type checking for every read beneath them.
 */
function dig(root: unknown, ...path: string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** `dig`, then keep the value only if it really is a non-empty array. */
function digArray(root: unknown, ...path: string[]): unknown[] {
  const v = dig(root, ...path);
  return Array.isArray(v) ? v : [];
}

/**
 * One half of a PLMN id, as text, or null when the file holds something that
 * cannot sensibly be one.
 *
 * A number is accepted because js-yaml reads an unquoted `mnc: 070` as the
 * number 70, so that is a NORMAL reading of a valid file, not a malformed one.
 * Anything else — an object, an array, a boolean — is treated as absent rather
 * than coerced, which is the same narrow-don't-coerce rule the Kea config
 * round-trip fix established: `String({})` is `"[object Object]"`, and a
 * garbage key here cannot do anything except make the 4G/5G PLMN-mismatch
 * warning below fire when there is no mismatch.
 */
function plmnPart(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

export class CrossServiceValidator {
  validate(configs: AllConfigs): ValidationResult {
    const errors: ValidationError[] = [];

    this.validateNrfConsistency(configs, errors);
    this.validatePfcpConsistency(configs, errors);
    this.validatePlmnConsistency(configs, errors);
    this.validateSliceConsistency(configs, errors);
    this.validateTopologyConnectivity(configs, errors);

    return new ValidationResult(errors);
  }

  private validateNrfConsistency(configs: AllConfigs, errors: ValidationError[]): void {
    // Open5GS supports multiple communication modes between NFs:
    //   1. Direct:   sbi.client.nrf[].uri
    //   2. Via SCP:  sbi.client.scp[].uri  (Indirect delegation)
    //   3. Both:     nrf + scp with optional 'delegated' block
    // A service is correctly configured if it has at least one of nrf or scp under sbi.client.

    // rawYaml is the full top-level YAML document, keyed by NF name.
    // e.g. { amf: { sbi: { client: { scp: [{ uri: '...' }] } } } }
    // So we must descend into raw[service] first, not raw directly.
    const checkConnectivity = (service: string, raw: unknown): void => {
      const hasNrf = digArray(raw, service, 'sbi', 'client', 'nrf').length > 0;
      const hasScp = digArray(raw, service, 'sbi', 'client', 'scp').length > 0;

      if (!hasNrf && !hasScp) {
        errors.push({
          field: `${service}.sbi.client`,
          message: `${service.toUpperCase()} has no NRF or SCP client configured under sbi.client`,
          service,
          severity: 'warning',
        });
      }
    };

    checkConnectivity('amf', configs.amf?.rawYaml);
    checkConnectivity('smf', configs.smf?.rawYaml);
    checkConnectivity('ausf', configs.ausf?.rawYaml);

    // Check SCP URI consistency — all services pointing to SCP should use the same URI
    const scpUris = new Map<string, string>(); // service -> uri
    const collectScp = (service: string, raw: unknown): void => {
      const uri = dig(digArray(raw, service, 'sbi', 'client', 'scp')[0], 'uri');
      // `typeof uri === 'string'` rather than the previous bare truthiness
      // check: scpUris is a Map<string, string>, and a hand-edited `uri: 8080`
      // used to be stored as a number, then joined into the "different SCP
      // URIs" message. Same narrow-don't-coerce rule as the Kea config fix.
      if (typeof uri === 'string' && uri) scpUris.set(service, uri);
    };

    collectScp('amf', configs.amf?.rawYaml);
    collectScp('smf', configs.smf?.rawYaml);
    collectScp('ausf', configs.ausf?.rawYaml);
    collectScp('udm', configs.udm?.rawYaml);
    collectScp('udr', configs.udr?.rawYaml);
    collectScp('pcf', configs.pcf?.rawYaml);
    collectScp('nssf', configs.nssf?.rawYaml);
    collectScp('bsf', configs.bsf?.rawYaml);

    const uniqueScpUris = new Set(scpUris.values());
    if (uniqueScpUris.size > 1) {
      errors.push({
        field: 'sbi.client.scp',
        message: `Services are pointing to different SCP URIs: ${[...uniqueScpUris].join(', ')}`,
        service: 'scp',
        severity: 'warning',
      });
    }
  }

  private validatePfcpConsistency(configs: AllConfigs, errors: ValidationError[]): void {
    const upfPfcpAddr = configs.upf.pfcp.addr;
    const smfPfcpAddr = configs.smf.pfcp.addr;

    if (!upfPfcpAddr) {
      errors.push({
        field: 'upf.pfcp.addr',
        message: 'UPF PFCP address not configured',
        service: 'upf',
        severity: 'error',
      });
    }

    if (!smfPfcpAddr) {
      errors.push({
        field: 'smf.pfcp.addr',
        message: 'SMF PFCP address not configured',
        service: 'smf',
        severity: 'error',
      });
    }
  }

  private validatePlmnConsistency(configs: AllConfigs, errors: ValidationError[]): void {
    // `plmn_id` is optional on a real entry, so an entry missing it is REPORTED
    // rather than skipped: a plmn_support or tai entry with no PLMN is exactly
    // the kind of thing this validator exists to catch. These two loops used to
    // read `entry.plmn_id.mcc` unguarded and would throw a TypeError on such a
    // file -- crashing the validation run instead of reporting the problem --
    // because AmfConfig declared `plmn_id` required while the document does
    // not. The mme.gummei loop below has always guarded; these did not.
    const collectPlmns = (
      entries: Array<{ plmn_id?: { mcc?: string; mnc?: string } }>,
      field: string,
    ): Set<string> => {
      const keys = new Set<string>();
      entries.forEach((entry, index) => {
        const mcc = entry.plmn_id?.mcc;
        const mnc = entry.plmn_id?.mnc;
        if (mcc === undefined || mnc === undefined) {
          errors.push({
            field: `${field}[${index}].plmn_id`,
            message: `${field} entry ${index} has no complete plmn_id (mcc/mnc) — Open5GS cannot broadcast it`,
            service: 'amf',
            severity: 'error',
          });
          return;
        }
        keys.add(plmnKey(mcc, mnc));
      });
      return keys;
    };

    const amfPlmns = collectPlmns(configs.amf.plmn_support || [], 'amf.plmn_support');
    const amfTaiPlmns = collectPlmns(configs.amf.tai || [], 'amf.tai');

    for (const pk of amfPlmns) {
      if (!amfTaiPlmns.has(pk)) {
        errors.push({
          field: 'amf.tai',
          message: `PLMN ${pk} in plmn_support but not in TAI list`,
          service: 'amf',
          severity: 'warning',
        });
      }
    }

    // Cross-check the 4G EPC side (mme/hss/pcrf) against AMF's own PLMN set —
    // added for the PLMN Migration Wizard's Phase E verification, but also
    // useful for the general "Validate Config" page: a partial/out-of-order
    // PLMN change (e.g. Phase A/C ran but Phase B didn't, or vice versa) shows
    // up here as a real, actionable warning instead of silently drifting.
    const mmePlmns = new Set<string>();
    for (const entry of digArray(configs.mme?.rawYaml, 'mme', 'gummei')) {
      const mcc = plmnPart(dig(entry, 'plmn_id', 'mcc'));
      const mnc = plmnPart(dig(entry, 'plmn_id', 'mnc'));
      // Incomplete entries are SKIPPED, matching collectPlmns() twenty lines
      // above, which already skips an entry with no complete plmn_id. The old
      // test here was `if (entry?.plmn_id)`, so a gummei entry carrying a
      // plmn_id with a missing mcc or mnc added the literal key
      // "undefined-undefined" to this set — and since the check below is
      // `every(pk => !amfPlmns.has(pk))`, a garbage key can only ever push the
      // result TOWARDS reporting a 4G/5G PLMN mismatch that does not exist.
      // Deliberately silent rather than also pushing an error like the AMF
      // path does: that would be new operator-visible output, which is a
      // separate decision from removing the bad key.
      if (mcc === null || mnc === null) continue;
      // plmnPart stringifies a numeric mcc/mnc exactly as plmnKey's template
      // literal used to, so the key TEXT is unchanged for every well-formed
      // file. Do NOT "fix" this by zero-padding: MNC width is load-bearing in
      // this project, but these keys are only ever compared against AMF keys
      // built the same way, so padding one side would break the comparison it
      // looks like it is improving.
      mmePlmns.add(plmnKey(mcc, mnc));
    }
    if (mmePlmns.size > 0 && [...mmePlmns].every(pk => !amfPlmns.has(pk))) {
      errors.push({
        field: 'mme.gummei',
        message: `MME's PLMN(s) [${[...mmePlmns].join(', ')}] don't match AMF's plmn_support [${[...amfPlmns].join(', ')}] — 4G and 5G sides appear to be on different PLMNs`,
        service: 'mme',
        severity: 'warning',
      });
    }

    // hss.yaml/pcrf.yaml have no structured plmn_id field of their own — their
    // real PLMN identity lives in freeDiameter's Identity/Realm (hss.conf/
    // pcrf.conf), which this rawYaml-only method has no access to. That check
    // is done separately, directly against the .conf files, by whichever
    // caller needs it (see PlmnMigrationUseCase.applyPhaseE).
  }

  private validateSliceConsistency(configs: AllConfigs, errors: ValidationError[]): void {
    const amfSlices = new Set<string>();
    for (const entry of configs.amf.plmn_support || []) {
      for (const s of entry.s_nssai || []) {
        amfSlices.add(`${s.sst}${s.sd ? `-${s.sd}` : ''}`);
      }
    }

    if (configs.smf.info) {
      for (const info of configs.smf.info) {
        for (const s of info.s_nssai || []) {
          const key = `${s.sst}${s.sd ? `-${s.sd}` : ''}`;
          if (!amfSlices.has(key)) {
            errors.push({
              field: 'smf.info.s_nssai',
              message: `SMF slice ${key} not found in AMF plmn_support`,
              service: 'smf',
              severity: 'warning',
            });
          }
        }
      }
    }
  }

  private validateTopologyConnectivity(configs: AllConfigs, errors: ValidationError[]): void {
    const nrfAddr = resolveAddr(configs.nrf.sbi.addr);
    if (!nrfAddr) {
      errors.push({
        field: 'nrf.sbi.addr',
        message: 'NRF has no SBI bind address - all services will be disconnected',
        service: 'nrf',
        severity: 'error',
      });
    }

    // No cast: `ngap.addr` is already `string | string[] | undefined`, which is
    // exactly resolveAddr's parameter type.
    const amfNgapAddr = resolveAddr(configs.amf.ngap?.addr);
    if (!amfNgapAddr) {
      errors.push({
        field: 'amf.ngap.addr',
        message: 'AMF has no NGAP address configured',
        service: 'amf',
        severity: 'error',
      });
    }

    const upfGtpuAddr = configs.upf.gtpu?.addr;
    if (!upfGtpuAddr) {
      errors.push({
        field: 'upf.gtpu.addr',
        message: 'UPF has no GTPU address configured',
        service: 'upf',
        severity: 'error',
      });
    }
  }
}
