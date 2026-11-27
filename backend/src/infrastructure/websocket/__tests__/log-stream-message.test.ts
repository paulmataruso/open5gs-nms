import {
  LOG_SOURCES, asLogSource, isLogSource, asStringArray, asEventTypes,
  asOptionalString, asBoolean, asLimit,
} from '../log-stream-message';
import { MAJOR_EVENT_TYPES } from '../../../application/use-cases/major-event-classifier';

/**
 * The log-stream WebSocket is the only place in this backend where a client
 * hands over a whole object and the handler acts on each field. `JSON.parse`
 * returns `any`, so none of it was checked.
 *
 * The defect these pin: `source` is DECLARED as a six-way union on all three
 * handler signatures, and carried whatever string the client sent. It
 * type-checked against the union without ever being one of its members, then
 * fell through every `source === …` branch to the open5gs default — so a
 * client asking for `frr` logs with a typo silently got open5gs logs, which
 * reads as a frontend bug.
 */

describe('asLogSource', () => {
  it('accepts every declared source', () => {
    for (const s of LOG_SOURCES) expect(asLogSource(s)).toBe(s);
  });

  it('falls back to open5gs for an unrecognised string', () => {
    // Previously this reached `source === 'frr'` etc. while TYPED as the
    // union, so the fallthrough was invisible.
    for (const s of ['FRR', 'open5gs ', 'journal', '', 'genie', '../../etc/passwd']) {
      expect(asLogSource(s)).toBe('open5gs');
    }
  });

  it('falls back to open5gs for a non-string, which is the prior behaviour for an absent field', () => {
    for (const v of [undefined, null, 0, 1, true, {}, [], ['frr']]) {
      expect(asLogSource(v)).toBe('open5gs');
    }
  });

  it('is case- and whitespace-sensitive on purpose — these are protocol tokens', () => {
    expect(isLogSource('frr')).toBe(true);
    expect(isLogSource('FRR')).toBe(false);
    expect(isLogSource(' frr')).toBe(false);
  });

  it('does not accept an inherited Object property as a source', () => {
    // `includes` on the array, not a key lookup on an object — so "toString"
    // and "constructor" are not sources.
    expect(isLogSource('toString')).toBe(false);
    expect(isLogSource('constructor')).toBe(false);
  });
});

describe('asStringArray', () => {
  it('keeps the real strings and drops everything else, in order', () => {
    expect(asStringArray(['mme', 5, null, 'amf', {}, undefined, 'smf'])).toEqual(['mme', 'amf', 'smf']);
  });

  it('is empty for a non-array, which is the prior `|| []` behaviour', () => {
    for (const v of [undefined, null, 'mme', 5, {}, true]) expect(asStringArray(v)).toEqual([]);
  });

  it('keeps an empty string, since a service name is not validated here', () => {
    // Deliberately NOT filtered: these reach journalctl through an argument
    // array (no shell), and silently dropping '' would hide a client bug
    // rather than surface it as an empty result.
    expect(asStringArray(['', 'mme'])).toEqual(['', 'mme']);
  });
});

describe('asEventTypes', () => {
  it('accepts every real major event type', () => {
    expect(asEventTypes([...MAJOR_EVENT_TYPES])).toEqual([...MAJOR_EVENT_TYPES]);
  });

  it('drops a type this build does not classify', () => {
    // The old code was `eventTypesArr as MajorEventType[]`, so an arbitrary
    // string went straight into a Set<MajorEventType> and then into
    // EVENT_TYPE_SERVICES[t], which is keyed by the union.
    expect(asEventTypes(['ue_attach', 'not_a_type', 'pdu_session_up'])).toEqual(['ue_attach', 'pdu_session_up']);
    expect(asEventTypes(['UE_ATTACH'])).toEqual([]);
  });

  it('is empty for a non-array or a non-string element', () => {
    expect(asEventTypes('ue_attach')).toEqual([]);
    expect(asEventTypes([1, null, {}])).toEqual([]);
    expect(asEventTypes(undefined)).toEqual([]);
  });
});

describe('asOptionalString', () => {
  it('keeps a real filter', () => {
    expect(asOptionalString('IMSI')).toBe('IMSI');
  });

  it('treats an empty string as no filter', () => {
    expect(asOptionalString('')).toBeUndefined();
  });

  it('is absent for a non-string', () => {
    for (const v of [undefined, null, 0, true, {}, []]) expect(asOptionalString(v)).toBeUndefined();
  });
});

describe('asBoolean', () => {
  it('is true only for a real boolean true', () => {
    expect(asBoolean(true)).toBe(true);
  });

  it('is false for truthy non-booleans', () => {
    // majorEventsOnly switches the handler onto a completely different read
    // path (grep the log files rather than tail them), so "truthy" is not a
    // good enough reason to take it.
    for (const v of ['true', 1, 'yes', {}, [], 'false']) expect(asBoolean(v)).toBe(false);
  });

  it('is false for absent and for false', () => {
    expect(asBoolean(undefined)).toBe(false);
    expect(asBoolean(false)).toBe(false);
  });
});

describe('asLimit', () => {
  it('keeps a sane request', () => {
    expect(asLimit(100, 100)).toBe(100);
    expect(asLimit(1, 100)).toBe(1);
  });

  it('falls back for a non-number, which is the prior `|| 100` behaviour', () => {
    for (const v of [undefined, null, '100', {}, [], true]) expect(asLimit(v, 100)).toBe(100);
  });

  it('falls back for NaN and Infinity rather than passing them to a multiplier', () => {
    // The limit reaches `limit * 10` and `limit * 4` and then a log read, so
    // NaN produced a NaN line count and Infinity an unbounded one.
    expect(asLimit(NaN, 100)).toBe(100);
    expect(asLimit(Infinity, 100)).toBe(100);
    expect(asLimit(-Infinity, 100)).toBe(100);
  });

  it('falls back for zero and negatives', () => {
    expect(asLimit(0, 100)).toBe(100);
    expect(asLimit(-5, 100)).toBe(100);
  });

  it('floors a float — a line count has to be an integer', () => {
    expect(asLimit(10.9, 100)).toBe(10);
  });

  it('clamps an absurd request instead of refusing it', () => {
    expect(asLimit(1e9, 100)).toBe(10000);
    expect(asLimit(10001, 100)).toBe(10000);
    expect(asLimit(10000, 100)).toBe(10000);
  });
});
