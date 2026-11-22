import { asRecord } from '../json-shape';

describe('asRecord', () => {
  it('passes a plain object through, with values still unknown', () => {
    const input = { a: 1, b: 'two' };
    expect(asRecord(input)).toBe(input);
  });

  it('returns an empty object for null and undefined', () => {
    // typeof null === 'object', which is the trap this guards.
    expect(asRecord(null)).toEqual({});
    expect(asRecord(undefined)).toEqual({});
  });

  it('returns an empty object for an array', () => {
    // An array indexed by a field name yields undefined anyway; returning {}
    // makes that explicit rather than leaving a half-usable value.
    expect(asRecord([1, 2, 3])).toEqual({});
  });

  it('returns an empty object for primitives', () => {
    for (const value of ['string', 42, true, Symbol('s'), 10n]) {
      expect(asRecord(value)).toEqual({});
    }
  });

  it('does not clone, so callers see later mutations', () => {
    // Relied on by callers that narrow req.body and then read it; a copy would
    // silently diverge from the request object.
    const input: Record<string, unknown> = { a: 1 };
    const out = asRecord(input);
    input.b = 2;
    expect(out.b).toBe(2);
  });

  it('accepts an object with a null prototype', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.a = 1;
    expect(asRecord(bare)).toBe(bare);
  });
});
