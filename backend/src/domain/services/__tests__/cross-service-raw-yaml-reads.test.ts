import { CrossServiceValidator } from '../cross-service-validator';
import { AllConfigs } from '../../interfaces/config-repository';
import { ValidationError } from '../../value-objects/validation-result';

/**
 * CrossServiceValidator reads three things straight out of `rawYaml`, which is
 * `Record<string, unknown>` because it is whatever the operator's file actually
 * holds: each NF's `sbi.client.nrf`/`.scp`, the SCP URI, and `mme.gummei`.
 *
 * Those reads used to go through `raw: any` parameters, which switched off type
 * checking for everything beneath them. Typing them (Phase 6 of CI-LINT-PLAN)
 * surfaced two real defects, and these tests pin both plus the behaviour that
 * must NOT have changed around them.
 *
 * Defect 1 — a garbage PLMN key could invent a 4G/5G mismatch. The gummei loop
 * tested only `if (entry?.plmn_id)`, so an entry whose plmn_id was missing an
 * mcc or an mnc added the literal string "undefined-undefined" to the MME PLMN
 * set. The comparison below it is
 * `[...mmePlmns].every(pk => !amfPlmns.has(pk))`, so an extra key that cannot
 * possibly be in amfPlmns pushes the result only one way: towards reporting
 * that the 4G and 5G sides are on different PLMNs when they are not. The AMF
 * path twenty lines above already skipped incomplete entries; now both do.
 * (The older plmn-consistency-missing-plmn-id.test.ts says the gummei loop
 * "had always guarded" — accurate for an ABSENT plmn_id, not an incomplete
 * one.)
 *
 * Defect 2 — `scpUris` is a `Map<string, string>` filled from a bare
 * truthiness check, so a hand-edited `uri: 8080` was stored as a number and
 * then joined into the operator-facing "different SCP URIs" message. Narrowed
 * with `typeof`, the same narrow-don't-coerce rule as the Kea round-trip fix.
 */

type Raw = Record<string, unknown>;

function configs(over: { mme?: Raw; amf?: Raw; amfRaw?: Raw; smfRaw?: Raw } = {}): AllConfigs {
  return {
    nrf: { sbi: { addr: '127.0.0.10', port: 7777 }, rawYaml: {} },
    amf: {
      sbi: { addr: '127.0.0.5', port: 7777 },
      ngap: { addr: '127.0.0.5' },
      guami: [],
      tai: [],
      plmn_support: [],
      rawYaml: over.amfRaw ?? {},
      ...over.amf,
    },
    smf: {
      sbi: { addr: '127.0.0.4', port: 7777 },
      pfcp: { addr: '127.0.0.4' },
      rawYaml: over.smfRaw ?? {},
    },
    upf: { pfcp: { addr: '127.0.0.7' }, gtpu: { addr: '127.0.0.7' }, rawYaml: {} },
    ausf: { sbi: { addr: '127.0.0.11', port: 7777 }, rawYaml: {} },
    mme: { rawYaml: over.mme ?? {} },
  };
}

/** One complete AMF PLMN, so a real mismatch has something to disagree with. */
const AMF_001_01 = {
  plmn_support: [{ plmn_id: { mcc: '001', mnc: '01' }, s_nssai: [{ sst: 1 }] }],
  tai: [{ plmn_id: { mcc: '001', mnc: '01' }, tac: 1 }],
};

const validator = new CrossServiceValidator();

// `.allIssues`, NOT `.errors`: ValidationResult splits its input by severity,
// so `.errors` holds only severity 'error' and every finding checked in this
// file is a 'warning'. Reading `.errors` makes each of these tests pass
// vacuously against a validator that reports nothing at all.
function mismatches(c: AllConfigs): ValidationError[] {
  return validator.validate(c).allIssues.filter(e => e.field === 'mme.gummei');
}

describe('mme.gummei read out of rawYaml', () => {
  it('does not invent a mismatch from an entry with an incomplete plmn_id', () => {
    // mcc present, mnc missing. Previously keyed as "001-undefined", which
    // amfPlmns can never contain, so `every(...)` was satisfied and the
    // mismatch warning fired against a correctly-configured pair.
    const result = mismatches(configs({
      amf: AMF_001_01,
      mme: { mme: { gummei: [{ plmn_id: { mcc: '001' } }] } },
    }));
    expect(result).toHaveLength(0);
  });

  it('does not invent a mismatch from a non-scalar mcc/mnc', () => {
    // `String({})` is "[object Object]". Same consequence as above, and the
    // reason plmnPart narrows instead of coercing.
    const result = mismatches(configs({
      amf: AMF_001_01,
      mme: { mme: { gummei: [{ plmn_id: { mcc: {}, mnc: [] } }] } },
    }));
    expect(result).toHaveLength(0);
  });

  it('still reports a genuine 4G/5G PLMN mismatch', () => {
    // The guard above must not be able to mask a real disagreement, which is
    // the whole value of this check.
    const result = mismatches(configs({
      amf: AMF_001_01,
      mme: { mme: { gummei: [{ plmn_id: { mcc: '310', mnc: '410' } }] } },
    }));
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('warning');
    expect(result[0].message).toContain('310-410');
  });

  it('raises nothing when the MME agrees with the AMF', () => {
    const result = mismatches(configs({
      amf: AMF_001_01,
      mme: { mme: { gummei: [{ plmn_id: { mcc: '001', mnc: '01' } }] } },
    }));
    expect(result).toHaveLength(0);
  });

  it('accepts a numerically-parsed mcc/mnc, which is a normal YAML reading', () => {
    // js-yaml reads an unquoted `mnc: 070` as the number 70 (decimal, not
    // octal). A number is therefore a well-formed file, not a malformed one,
    // so plmnPart accepts it and stringifies it exactly as the old template
    // literal did.
    const result = mismatches(configs({
      amf: {
        plmn_support: [{ plmn_id: { mcc: '001', mnc: '70' }, s_nssai: [{ sst: 1 }] }],
        tai: [{ plmn_id: { mcc: '001', mnc: '70' }, tac: 1 }],
      },
      mme: { mme: { gummei: [{ plmn_id: { mcc: 1, mnc: 70 } }] } },
    }));
    // mcc 1 stringifies to "1", not "001", so this pair legitimately does NOT
    // match — and the warning naming both keys is the correct, useful output.
    // Asserted explicitly so nobody "fixes" it by zero-padding one side, which
    // would change what matches what rather than improve it.
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain('1-70');
  });

  it('tolerates gummei being absent, a scalar, or not an array', () => {
    for (const mme of [{}, { mme: {} }, { mme: { gummei: null } }, { mme: { gummei: 'x' } },
      { mme: 5 }] as Raw[]) {
      expect(() => validator.validate(configs({ amf: AMF_001_01, mme }))).not.toThrow();
      expect(mismatches(configs({ amf: AMF_001_01, mme }))).toHaveLength(0);
    }
  });
});

describe('sbi.client read out of rawYaml', () => {
  function clientIssues(c: AllConfigs): ValidationError[] {
    return validator.validate(c).allIssues.filter(e => e.field.endsWith('.sbi.client'));
  }

  it('reports a service with neither an nrf nor an scp client', () => {
    const found = clientIssues(configs({ amfRaw: { amf: { sbi: { client: {} } } } }));
    expect(found.some(e => e.field === 'amf.sbi.client')).toBe(true);
  });

  it('accepts a service reached via nrf only, or via scp only', () => {
    const viaNrf = clientIssues(configs({
      amfRaw: { amf: { sbi: { client: { nrf: [{ uri: 'http://127.0.0.10:7777' }] } } } },
    }));
    expect(viaNrf.some(e => e.field === 'amf.sbi.client')).toBe(false);

    const viaScp = clientIssues(configs({
      amfRaw: { amf: { sbi: { client: { scp: [{ uri: 'http://127.0.0.200:7777' }] } } } },
    }));
    expect(viaScp.some(e => e.field === 'amf.sbi.client')).toBe(false);
  });

  it('treats an empty nrf array as no client, not as configured', () => {
    const found = clientIssues(configs({ amfRaw: { amf: { sbi: { client: { nrf: [] } } } } }));
    expect(found.some(e => e.field === 'amf.sbi.client')).toBe(true);
  });

  it('does not throw when the path holds a scalar where an object belongs', () => {
    for (const amfRaw of [{ amf: 'nope' }, { amf: { sbi: 3 } },
      { amf: { sbi: { client: 'x' } } }] as Raw[]) {
      expect(() => validator.validate(configs({ amfRaw }))).not.toThrow();
    }
  });
});

describe('SCP URI consistency', () => {
  function scpIssues(c: AllConfigs): ValidationError[] {
    return validator.validate(c).allIssues.filter(e => e.field === 'sbi.client.scp');
  }

  const scp = (uri: unknown): Raw => ({ sbi: { client: { scp: [{ uri }] } } });

  it('reports two services pointing at different SCP URIs', () => {
    const found = scpIssues(configs({
      amfRaw: { amf: scp('http://127.0.0.200:7777') },
      smfRaw: { smf: scp('http://127.0.0.201:7777') },
    }));
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('127.0.0.201');
  });

  it('raises nothing when they agree', () => {
    const found = scpIssues(configs({
      amfRaw: { amf: scp('http://127.0.0.200:7777') },
      smfRaw: { smf: scp('http://127.0.0.200:7777') },
    }));
    expect(found).toHaveLength(0);
  });

  it('ignores a non-string uri rather than storing it in a Map<string,string>', () => {
    // A hand-edited `uri: 8080` used to be collected as a number and then
    // joined into the operator-facing message alongside a real URI. One
    // genuine URI plus one ignored value is agreement, so nothing is raised.
    const found = scpIssues(configs({
      amfRaw: { amf: scp(8080) },
      smfRaw: { smf: scp('http://127.0.0.200:7777') },
    }));
    expect(found).toHaveLength(0);
  });

  it('ignores an object uri, which would otherwise stringify to [object Object]', () => {
    const found = scpIssues(configs({
      amfRaw: { amf: scp({ host: 'x' }) },
      smfRaw: { smf: scp('http://127.0.0.200:7777') },
    }));
    expect(found).toHaveLength(0);
  });
});
