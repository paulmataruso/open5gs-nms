import { describe, it, expect } from 'vitest';
import {
  groupRadioRows, RADIO_GROUP_KINDS, STATUS_ORDER, UNGROUPED_LABEL,
  type RadioGroupAccessors, type RadioGroupKind,
} from '../radio-grouping';

/**
 * RAN page grouping, shared by six lists.
 *
 * Load-bearing facts:
 *  - Named groups sort first; the catch-all bucket is ALWAYS last, even when
 *    its name would sort earlier, so an operator's groups are never buried.
 *  - Status is ranked (faults first), and an unknown status ranks after every
 *    known one rather than being dropped or sorted to the top.
 *  - Blank/whitespace/null group values land in the ungrouped bucket.
 *  - Keys are namespaced by kind so collapse state cannot leak across kinds.
 */

interface Row { id: string; group?: string | null; band?: string | null; status?: string }

const acc: RadioGroupAccessors<Row> = {
  group: r => r.group,
  band: r => r.band,
  status: r => r.status ?? 'Connected',
};

const names = (rows: Row[], kind: RadioGroupKind) =>
  groupRadioRows(rows, kind, acc).map(g => g.name);

describe('custom groups', () => {
  it('sorts named groups alphabetically with the catch-all last', () => {
    expect(names([
      { id: 'a', group: 'West Site' }, { id: 'b' },
      { id: 'c', group: 'Baicells Shelf' }, { id: 'd', group: 'North Site' },
    ], 'custom')).toEqual(['Baicells Shelf', 'North Site', 'West Site', 'Ungrouped']);
  });

  it('a name sorting before "Ungrouped" still precedes it, and one after does too', () => {
    expect(names([{ id: 'a' }, { id: 'b', group: 'Zulu' }, { id: 'c', group: 'Alpha' }], 'custom'))
      .toEqual(['Alpha', 'Zulu', 'Ungrouped']);
  });

  it('blank, whitespace, null and missing values all go to the catch-all', () => {
    const out = groupRadioRows(
      [{ id: 'a', group: '' }, { id: 'b', group: '   ' }, { id: 'c', group: null }, { id: 'd' }],
      'custom', acc);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Ungrouped', isUngrouped: true });
    expect(out[0].rows.map(r => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('merges case and whitespace variants, first spelling wins', () => {
    const out = groupRadioRows(
      [{ id: 'a', group: 'North Site' }, { id: 'b', group: ' north site ' }], 'custom', acc);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('North Site');
    expect(out[0].rows).toHaveLength(2);
  });
});

describe('band', () => {
  it('orders numerically: B5 before B48 before B66', () => {
    expect(names([
      { id: 'a', band: 'B66' }, { id: 'b', band: 'B5' }, { id: 'c', band: 'B48' },
    ], 'band')).toEqual(['B5', 'B48', 'B66']);
  });

  it('untagged radios go last under the band-specific label', () => {
    expect(names([{ id: 'a' }, { id: 'b', band: 'B48' }], 'band')).toEqual(['B48', 'No band set']);
    expect(UNGROUPED_LABEL.band).toBe('No band set');
  });
});

describe('status', () => {
  it('ranks by STATUS_ORDER, faults first', () => {
    expect(names([
      { id: 'a', status: 'Idle' }, { id: 'b', status: 'Connected' },
      { id: 'c', status: 'Blocked' }, { id: 'd', status: 'Setup failed' },
    ], 'status')).toEqual(['Setup failed', 'Blocked', 'Connected', 'Idle']);
  });

  it('an unknown status ranks after every known one, alphabetically among unknowns', () => {
    expect(names([
      { id: 'a', status: 'Zebra' }, { id: 'b', status: 'Idle' },
      { id: 'c', status: 'Aardvark' }, { id: 'd', status: 'Setup failed' },
    ], 'status')).toEqual(['Setup failed', 'Idle', 'Aardvark', 'Zebra']);
  });

  it('STATUS_ORDER puts the two fault states first', () => {
    expect(STATUS_ORDER.slice(0, 2)).toEqual(['Setup failed', 'Blocked']);
  });

  it('a blank status lands in the catch-all, after known statuses', () => {
    const out = groupRadioRows(
      [{ id: 'a', status: '' }, { id: 'b', status: 'Idle' }], 'status', acc);
    expect(out.map(g => g.name)).toEqual(['Idle', 'Unknown']);
    expect(out[1].isUngrouped).toBe(true);
  });
});

describe('invariants', () => {
  it('preserves input row order inside a group', () => {
    const out = groupRadioRows(
      [{ id: '3', group: 'G' }, { id: '1', group: 'G' }, { id: '2', group: 'G' }], 'custom', acc);
    expect(out[0].rows.map(r => r.id)).toEqual(['3', '1', '2']);
  });

  it('namespaces keys by kind', () => {
    const [custom] = groupRadioRows([{ id: 'a', group: 'Connected' }], 'custom', acc);
    const [status] = groupRadioRows([{ id: 'a', status: 'Connected' }], 'status', acc);
    expect(custom.name).toBe(status.name);
    expect(custom.key).not.toBe(status.key);
    expect(custom.key.startsWith('custom:')).toBe(true);
    expect(status.key.startsWith('status:')).toBe(true);
  });

  it('a real group named "ungrouped" does not collide with the catch-all', () => {
    const out = groupRadioRows([{ id: 'a', group: 'ungrouped' }, { id: 'b' }], 'custom', acc);
    expect(out).toHaveLength(2);
    expect(out[0].isUngrouped).toBe(false);
    expect(out[1].isUngrouped).toBe(true);
    expect(out[0].key).not.toBe(out[1].key);
  });

  it('every row lands in exactly one non-empty group', () => {
    const rows: Row[] = [
      { id: 'a', group: 'X' }, { id: 'b', group: 'Y' }, { id: 'c' }, { id: 'd', group: 'X' },
    ];
    const out = groupRadioRows(rows, 'custom', acc);
    expect(out.every(g => g.rows.length > 0)).toBe(true);
    expect(out.flatMap(g => g.rows.map(r => r.id)).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('empty and nullish input yield no groups', () => {
    expect(groupRadioRows([], 'custom', acc)).toEqual([]);
    expect(groupRadioRows(null as unknown as Row[], 'custom', acc)).toEqual([]);
  });

  it('offers exactly the three kinds', () => {
    expect(RADIO_GROUP_KINDS.map(k => k.key)).toEqual(['custom', 'band', 'status']);
  });
});
