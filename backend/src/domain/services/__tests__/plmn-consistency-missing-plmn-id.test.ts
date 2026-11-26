import { CrossServiceValidator } from '../cross-service-validator';
import { AllConfigs } from '../../interfaces/config-repository';

/**
 * `amf.plmn_support[].plmn_id` and `amf.tai[].plmn_id` are OPTIONAL in a real
 * amf.yaml, but AmfConfig declared them required, so validatePlmnConsistency()
 * read `entry.plmn_id.mcc` unguarded. A file with an incomplete entry therefore
 * crashed the validation run with a TypeError instead of reporting the problem
 * -- in the one function whose job is to report exactly that. Found 2026-11-26
 * when AmfConfig was aligned with the document types and the compiler flagged
 * both reads; the mme.gummei loop in the same method had always guarded.
 */
function configsWith(amf: Record<string, unknown>): AllConfigs {
  // Only the AMF section matters here; the other validators tolerate empties
  // and are covered elsewhere.
  const empty = { rawYaml: {} };
  return {
    nrf: { sbi: { addr: '127.0.0.10', port: 7777 }, rawYaml: {} },
    amf: {
      sbi: { addr: '127.0.0.5', port: 7777 },
      ngap: { addr: '127.0.0.5' },
      guami: [],
      tai: [],
      plmn_support: [],
      rawYaml: {},
      ...amf,
    },
    smf: { sbi: { addr: '127.0.0.4', port: 7777 }, pfcp: { addr: '127.0.0.4' }, rawYaml: {} },
    upf: { pfcp: { addr: '127.0.0.7' }, gtpu: { addr: '127.0.0.7' }, rawYaml: {} },
    ausf: { sbi: { addr: '127.0.0.11', port: 7777 }, rawYaml: {} },
    mme: empty,
  } as AllConfigs;
}

describe('validatePlmnConsistency with an incomplete plmn_id', () => {
  const validator = new CrossServiceValidator();

  it('reports a plmn_support entry with no plmn_id instead of throwing', () => {
    const result = validator.validate(configsWith({
      plmn_support: [{ s_nssai: [{ sst: 1 }] }],
    }));
    const found = result.errors.filter(e => e.field.startsWith('amf.plmn_support'));
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('error');
    expect(found[0].message).toContain('no complete plmn_id');
  });

  it('reports a tai entry with no plmn_id instead of throwing', () => {
    const result = validator.validate(configsWith({ tai: [{ tac: 1 }] }));
    const found = result.errors.filter(e => e.field.startsWith('amf.tai['));
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('no complete plmn_id');
  });

  it('reports a half-filled plmn_id (mcc but no mnc)', () => {
    const result = validator.validate(configsWith({
      plmn_support: [{ plmn_id: { mcc: '001' }, s_nssai: [{ sst: 1 }] }],
    }));
    expect(result.errors.filter(e => e.field.startsWith('amf.plmn_support'))).toHaveLength(1);
  });

  it('names the offending index, so a long list is actionable', () => {
    const result = validator.validate(configsWith({
      plmn_support: [
        { plmn_id: { mcc: '001', mnc: '01' }, s_nssai: [{ sst: 1 }] },
        { s_nssai: [{ sst: 1 }] },
      ],
      tai: [{ plmn_id: { mcc: '001', mnc: '01' }, tac: 1 }],
    }));
    const found = result.errors.filter(e => e.field.startsWith('amf.plmn_support'));
    expect(found).toHaveLength(1);
    expect(found[0].field).toBe('amf.plmn_support[1].plmn_id');
  });

  it('raises no plmn_id error when every entry is complete', () => {
    const result = validator.validate(configsWith({
      plmn_support: [{ plmn_id: { mcc: '001', mnc: '01' }, s_nssai: [{ sst: 1 }] }],
      tai: [{ plmn_id: { mcc: '001', mnc: '01' }, tac: 1 }],
    }));
    expect(result.errors.filter(e => e.message.includes('no complete plmn_id'))).toHaveLength(0);
  });
});
