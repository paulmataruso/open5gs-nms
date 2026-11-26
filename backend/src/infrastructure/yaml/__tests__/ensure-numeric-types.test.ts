import pino from 'pino';
import * as yaml from 'js-yaml';
import { YamlConfigRepository } from '../yaml-config-repository';
import { IHostExecutor } from '../../../domain/interfaces/host-executor';

// ensureNumericTypes() runs on EVERY save of all 17 NF configs, coercing any
// all-digit string to a number. Three keys were exempt (mcc/mnc/sd); a fourth,
// PCF's `qos_index`, was not -- so every Apply Config silently rewrote the
// deliberately-quoted `qos_index: "1"` from config/defaults/pcf.yaml as a bare
// `1`. Found live on 2026-11-26 by diffing the written file against a pre-apply
// backup, and the shipped default's own comment records that a wrong value
// there produces `403: Unknown qosReference` and blocks cross-RAT calling.
//
// The method is private, so it is reached through the instance deliberately:
// testing a re-implemented copy is what let this live in the first place
// (yaml-config-repository.test.ts inlines its own mirror of deepMerge).
describe('ensureNumericTypes string-valued key exemptions', () => {
  const exec = {} as IHostExecutor;
  const repo = new YamlConfigRepository(exec, '/etc/open5gs', pino({ level: 'silent' }));
  const coerce = (doc: unknown): unknown =>
    (repo as unknown as { ensureNumericTypes(o: unknown): unknown }).ensureNumericTypes(doc);

  it('keeps PCF qos_index a string, so the quoting survives a save', () => {
    const doc = { pcf: { qos_profiles: [{ reference: 'qosVoNR', qos_index: '1' }] } };
    const out = coerce(doc) as typeof doc;
    expect(out.pcf.qos_profiles[0].qos_index).toBe('1');
    // The round trip through js-yaml is what the operator actually sees.
    expect(yaml.dump(out)).toContain("qos_index: '1'");
  });

  it('still keeps mcc/mnc/sd strings, leading zeros intact', () => {
    const doc = { plmn_id: { mcc: '001', mnc: '01' }, s_nssai: [{ sst: 1, sd: '000019' }] };
    const out = coerce(doc) as typeof doc;
    expect(out.plmn_id.mcc).toBe('001');
    expect(out.plmn_id.mnc).toBe('01');
    expect(out.s_nssai[0].sd).toBe('000019');
  });

  it('still coerces an ordinary numeric string, which is the whole point', () => {
    const out = coerce({ sbi: { server: [{ port: '7777' }] } }) as {
      sbi: { server: Array<{ port: unknown }> };
    };
    expect(out.sbi.server[0].port).toBe(7777);
  });

  it('exempts the key wherever it appears, including inside an array', () => {
    const out = coerce({ a: [{ b: [{ qos_index: '9', other: '9' }] }] }) as {
      a: Array<{ b: Array<{ qos_index: unknown; other: unknown }> }>;
    };
    expect(out.a[0].b[0].qos_index).toBe('9');
    expect(out.a[0].b[0].other).toBe(9);
  });

  it('leaves a non-numeric string alone', () => {
    const out = coerce({ reference: 'qosVoNR', level: 'debug' }) as Record<string, unknown>;
    expect(out.reference).toBe('qosVoNR');
    expect(out.level).toBe('debug');
  });
});
