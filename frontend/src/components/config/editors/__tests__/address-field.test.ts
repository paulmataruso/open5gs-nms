import { describe, it, expect } from 'vitest';
import {
  addressToText, textToAddress, isAddressList, firstAddress, firstOf, asList,
} from '../address-field';

/**
 * Open5GS's scalar-or-list convention.
 *
 * Load-bearing facts:
 *  - A list-shaped field must STAY a list across a render/edit round trip, and
 *    a scalar must stay a scalar: shape is taken from the value being replaced,
 *    never from the typed text, or an operator's hand edits are silently
 *    reshaped (a comma in a scalar must not split it).
 *  - Empty/undefined input must not become `['']`, which would write a bogus
 *    empty address into the config.
 *  - firstAddress is for logic (loopback checks), not the joined display text.
 */

describe('addressToText', () => {
  it('renders scalars, lists, absent and empty', () => {
    expect(addressToText('127.0.0.2')).toBe('127.0.0.2');
    expect(addressToText(['10.0.1.175', '10.0.2.5'])).toBe('10.0.1.175, 10.0.2.5');
    expect(addressToText(undefined)).toBe('');
    expect(addressToText([])).toBe('');
  });
});

describe('textToAddress', () => {
  it('keeps a scalar scalar and does not split it on a comma', () => {
    expect(textToAddress('127.0.0.2', false)).toBe('127.0.0.2');
    expect(textToAddress('a,b', false)).toBe('a,b');
  });

  it('keeps a list a list, trimming spacing and trailing separators', () => {
    expect(textToAddress('10.0.1.175, 10.0.2.5', true)).toEqual(['10.0.1.175', '10.0.2.5']);
    expect(textToAddress(' a ,  b , ', true)).toEqual(['a', 'b']);
  });

  it('a single entry in a list field stays a one-element list', () => {
    expect(textToAddress('10.0.0.1', true)).toEqual(['10.0.0.1']);
  });

  it('cleared list yields [], never [""]', () => {
    expect(textToAddress('', true)).toEqual([]);
    expect(textToAddress('  ,  , ', true)).toEqual([]);
  });

  it('cleared scalar yields the empty string, not a list', () => {
    expect(textToAddress('', false)).toBe('');
  });
});

describe('round trip', () => {
  it('a list is not collapsed into one joined address', () => {
    const original = ['10.0.1.175', '10.0.2.5'];
    const written = textToAddress(addressToText(original), isAddressList(original));
    expect(written).toEqual(original);
    expect(Array.isArray(written)).toBe(true);
  });

  it('a one-element list stays a list', () => {
    const original = ['10.0.1.175'];
    const written = textToAddress(addressToText(original), isAddressList(original));
    expect(written).toEqual(['10.0.1.175']);
  });

  it('a scalar is not promoted to a list', () => {
    const original = '127.0.0.2';
    const written = textToAddress(addressToText(original), isAddressList(original));
    expect(written).toBe(original);
  });

  it('an empty list round-trips to an empty list, not [""]', () => {
    const original: string[] = [];
    expect(textToAddress(addressToText(original), isAddressList(original))).toEqual([]);
  });

  it('an absent field round-trips to a scalar empty string, not a list', () => {
    const written = textToAddress(addressToText(undefined), isAddressList(undefined));
    expect(written).toBe('');
  });
});

describe('isAddressList', () => {
  it('distinguishes the shapes, including an empty list', () => {
    expect(isAddressList(['a'])).toBe(true);
    expect(isAddressList([])).toBe(true);
    expect(isAddressList('a')).toBe(false);
    expect(isAddressList(undefined)).toBe(false);
  });
});

describe('firstAddress', () => {
  it('returns scalar as-is, first of a list, and "" for absent or empty', () => {
    expect(firstAddress('127.0.0.1')).toBe('127.0.0.1');
    expect(firstAddress(['127.0.0.1', '10.0.0.1'])).toBe('127.0.0.1');
    expect(firstAddress(undefined)).toBe('');
    expect(firstAddress([])).toBe('');
  });

  it('keeps a loopback predicate right where the joined text would not', () => {
    const isLoopback = (a: string): boolean => a.startsWith('127.');
    expect(isLoopback(firstAddress(['10.0.0.1', '127.0.0.1']))).toBe(false);
    expect(firstAddress(['127.0.0.1', '10.0.0.1'])).not.toContain(',');
    expect(addressToText(['127.0.0.1', '10.0.0.1'])).toContain(',');
  });
});

describe('firstOf', () => {
  it('returns scalars unchanged and the first of a list', () => {
    expect(firstOf(7)).toBe(7);
    expect(firstOf([26000, 27000])).toBe(26000);
    expect(firstOf(['internet', 'ims'])).toBe('internet');
  });

  it('is undefined for absent or empty so callers can default', () => {
    expect(firstOf(undefined)).toBeUndefined();
    expect(firstOf([])).toBeUndefined();
  });

  it('preserves 0', () => {
    expect(firstOf(0)).toBe(0);
    expect(firstOf([0])).toBe(0);
  });
});

describe('asList', () => {
  it('wraps a scalar, passes a list through, and maps undefined to []', () => {
    expect(asList('internet')).toEqual(['internet']);
    expect(asList(['a', 'b'])).toEqual(['a', 'b']);
    expect(asList(undefined)).toEqual([]);
  });

  it('keeps 0 as a one-element list', () => {
    expect(asList(0)).toEqual([0]);
  });
});
