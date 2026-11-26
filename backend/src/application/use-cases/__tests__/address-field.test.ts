import {
  addressToText,
  textToAddress,
  isAddressList,
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

  describe('isAddressList', () => {
    it('distinguishes the two real shapes', () => {
      expect(isAddressList(['a'])).toBe(true);
      expect(isAddressList('a')).toBe(false);
      expect(isAddressList(undefined)).toBe(false);
    });
  });
});
