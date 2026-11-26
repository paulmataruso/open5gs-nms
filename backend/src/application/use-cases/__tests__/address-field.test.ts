import {
  addressToText,
  textToAddress,
  isAddressList,
  firstAddress,
  firstOf,
} from '../../../../../frontend/src/components/config/editors/address-field';

// These helpers live in the frontend, which has no test runner of its own
// (package.json has no jest/vitest). They are pure and dependency-free
// specifically so this suite can reach them across the workspace boundary --
// the alternative was shipping a real data-loss path with no coverage.
//
// The path they guard: every Open5GS `address`/`advertise`/`local_address` is
// `string | string[]`, and the config editors used to render a list straight
// into an <input>, which displays "a, b" and writes that joined string back as
// ONE bogus address. On this deployment every such field is currently a scalar,
// so the bug was latent -- and invisible while the editors cast to `any`.
describe('address field round trip', () => {
  describe('addressToText', () => {
    it('renders a scalar unchanged', () => {
      expect(addressToText('127.0.0.2')).toBe('127.0.0.2');
    });
    it('renders a list as a readable, re-parseable string', () => {
      expect(addressToText(['10.0.1.175', '10.0.2.5'])).toBe('10.0.1.175, 10.0.2.5');
    });
    it('renders an absent field as empty, never the string "undefined"', () => {
      expect(addressToText(undefined)).toBe('');
    });
    it('renders an empty list as empty', () => {
      expect(addressToText([])).toBe('');
    });
  });

  describe('textToAddress', () => {
    it('keeps a scalar field scalar', () => {
      expect(textToAddress('127.0.0.2', false)).toBe('127.0.0.2');
    });
    it('keeps a list field a list', () => {
      expect(textToAddress('10.0.1.175, 10.0.2.5', true)).toEqual(['10.0.1.175', '10.0.2.5']);
    });
    it('does NOT split a scalar field on a comma', () => {
      // Deriving list-ness from the text would convert a scalar field to a
      // list the moment someone typed a comma, changing the field's shape.
      expect(textToAddress('a,b', false)).toBe('a,b');
    });
    it('tolerates spacing and trailing separators in a list', () => {
      expect(textToAddress(' a ,  b , ', true)).toEqual(['a', 'b']);
    });
    it('yields an empty list rather than [""] when a list is cleared', () => {
      expect(textToAddress('', true)).toEqual([]);
    });
  });

  it('round-trips a list without collapsing it -- the actual bug', () => {
    const original = ['10.0.1.175', '10.0.2.5'];
    const text = addressToText(original);
    const written = textToAddress(text, isAddressList(original));
    expect(written).toEqual(original);
  });

  it('round-trips a scalar without promoting it to a list', () => {
    const original = '127.0.0.2';
    const written = textToAddress(addressToText(original), isAddressList(original));
    expect(written).toBe(original);
  });

  describe('firstAddress', () => {
    // For predicates, not display. Joining a list and asking isLoopback() about
    // "127.0.0.1, 10.0.0.1" answers neither question correctly.
    it('returns a scalar as-is', () => {
      expect(firstAddress('127.0.0.1')).toBe('127.0.0.1');
    });
    it('returns the FIRST entry of a list, not the join', () => {
      expect(firstAddress(['127.0.0.1', '10.0.0.1'])).toBe('127.0.0.1');
    });
    it('returns empty for absent or empty, never undefined', () => {
      expect(firstAddress(undefined)).toBe('');
      expect(firstAddress([])).toBe('');
    });
    it('keeps a loopback predicate answerable, which addressToText would not', () => {
      const isLoopback = (a: string): boolean => a.startsWith('127.');
      expect(isLoopback(firstAddress(['127.0.0.1', '10.0.0.1']))).toBe(true);
      expect(isLoopback(addressToText(['127.0.0.1', '10.0.0.1']))).toBe(true);
      // ...and the reverse ordering is where the join actually breaks:
      expect(isLoopback(firstAddress(['10.0.0.1', '127.0.0.1']))).toBe(false);
      expect(isLoopback(addressToText(['10.0.0.1', '127.0.0.1']))).toBe(false);
    });
  });

  describe('firstOf', () => {
    // Open5GS's scalar-or-list convention is not limited to addresses: tac,
    // dnn, apn, e_cell_id and nr_cell_id all follow it. A list-valued `tac`
    // reaching a `number` field is a bug this project has already had on the
    // backend side, which is why this mirrors auto-config.ts's own firstOf().
    it('returns a scalar unchanged', () => {
      expect(firstOf(7)).toBe(7);
      expect(firstOf('internet')).toBe('internet');
    });
    it('returns the first of a list', () => {
      expect(firstOf([26000, 27000])).toBe(26000);
      expect(firstOf(['internet', 'ims'])).toBe('internet');
    });
    it('returns undefined for absent or empty, so a caller can default', () => {
      expect(firstOf(undefined)).toBeUndefined();
      expect(firstOf([])).toBeUndefined();
    });
    it('preserves 0, which a `||` fallback would discard', () => {
      expect(firstOf(0)).toBe(0);
      expect(firstOf([0])).toBe(0);
    });
  });

  describe('isAddressList', () => {
    it('distinguishes the two real shapes', () => {
      expect(isAddressList(['a'])).toBe(true);
      expect(isAddressList('a')).toBe(false);
      expect(isAddressList(undefined)).toBe(false);
    });
  });
});
