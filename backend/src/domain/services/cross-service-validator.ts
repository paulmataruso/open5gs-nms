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
    const getClient = (raw: any, service: string): any => raw?.[service]?.sbi?.client;

    const checkConnectivity = (service: string, raw: any): void => {
      const client = getClient(raw, service);
      const hasNrf = Array.isArray(client?.nrf) && client.nrf.length > 0;
      const hasScp = Array.isArray(client?.scp) && client.scp.length > 0;

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
    const collectScp = (service: string, raw: any): void => {
      const uri = getClient(raw, service)?.scp?.[0]?.uri;
      if (uri) scpUris.set(service, uri);
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
    const amfPlmns = new Set<string>();
    for (const entry of configs.amf.plmn_support || []) {
      amfPlmns.add(plmnKey(entry.plmn_id.mcc, entry.plmn_id.mnc));
    }

    const amfTaiPlmns = new Set<string>();
    for (const entry of configs.amf.tai || []) {
      amfTaiPlmns.add(plmnKey(entry.plmn_id.mcc, entry.plmn_id.mnc));
    }

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

    const amfNgapAddr = resolveAddr(
      configs.amf.ngap?.addr as string | string[] | undefined,
    );
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
