import {
  groupRadioRows,
  RADIO_GROUP_KINDS,
  STATUS_ORDER,
  UNGROUPED_LABEL,
  type RadioGroupAccessors,
} from '../../../frontend/src/components/ran/radio-grouping';

// The RAN page's radio grouping is frontend presentation logic, but it is pure
// and shared by six separate lists (three 4G/5G layouts + three 2G ones), so the
// ordering rules are worth executing rather than eyeballing. Imported directly
// because the module deliberately has no React or localStorage dependency —
// this project has no frontend test runner, and the alternative (a text-matching
// wiring test, as in rf-antenna-wiring.test.ts) cannot check ordering at all.

interface Row { id: string; group?: string | null; band?: string | null; status?: string }

const acc: RadioGroupAccessors<Row> = {
  group:  r => r.group,
  band:   r => r.band,
  status: r => r.status ?? 'Connected',
};

const names = (rows: Row[], kind: Parameters<typeof groupRadioRows>[1]) =>
  groupRadioRows(rows, kind, acc).map(g => g.name);

describe('groupRadioRows — custom groups', () => {
  test('named groups sort alphabetically with the catch-all ALWAYS last', () => {
    expect(names([
      { id: 'a', group: 'West Site' },
      { id: 'b' },
      { id: 'c', group: 'Baicells Shelf' },
      { id: 'd', group: 'North Site' },
    ], 'custom')).toEqual(['Baicells Shelf', 'North Site', 'West Site', 'Ungrouped']);
  });

  test('a name that would sort after "Ungrouped" still comes before it', () => {
    // The whole point of the isUngrouped flag — a plain alphabetical sort puts
    // "Ungrouped" in the middle and buries the operator's own group.
    expect(names([{ id: 'a' }, { id: 'b', group: 'Zulu Site' }], 'custom'))
      .toEqual(['Zulu Site', 'Ungrouped']);
  });

  test('blank, whitespace and null group values all land in the catch-all', () => {
    const out = groupRadioRows(
      [{ id: 'a', group: '' }, { id: 'b', group: '   ' }, { id: 'c', group: null }, { id: 'd' }],
      'custom', acc,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Ungrouped', isUngrouped: true });
    expect(out[0].rows.map(r => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('group names are matched case-insensitively so casing cannot fork a group', () => {
    const out = groupRadioRows(
      [{ id: 'a', group: 'North Site' }, { id: 'b', group: 'north site' }],
      'custom', acc,
    );
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('North Site'); // first-seen spelling wins
    expect(out[0].rows).toHaveLength(2);
  });

  test('surrounding whitespace does not fork a group either', () => {
    expect(groupRadioRows(
      [{ id: 'a', group: 'Lab' }, { id: 'b', group: '  Lab  ' }], 'custom', acc,
    )).toHaveLength(1);
  });
});

describe('groupRadioRows — band', () => {
  test('orders numerically, not lexically (B48 must not precede B5)', () => {
    expect(names([
      { id: 'a', band: 'B66' }, { id: 'b', band: 'B5' }, { id: 'c', band: 'B48' },
    ], 'band')).toEqual(['B5', 'B48', 'B66']);
  });

  test('untagged radios collect under the band-specific catch-all label', () => {
    expect(names([{ id: 'a', band: 'B48' }, { id: 'b' }], 'band'))
      .toEqual(['B48', UNGROUPED_LABEL.band]);
    expect(UNGROUPED_LABEL.band).toBe('No band set');
  });
});

describe('groupRadioRows — status', () => {
  test('ranks by STATUS_ORDER so faults sort above healthy radios', () => {
    expect(names([
      { id: 'a', status: 'Idle' },
      { id: 'b', status: 'Connected' },
      { id: 'c', status: 'Blocked' },
      { id: 'd', status: 'Setup failed' },
    ], 'status')).toEqual(['Setup failed', 'Blocked', 'Connected', 'Idle']);
  });

  test('an unrecognised status sorts after every known one, alphabetically', () => {
    expect(names([
      { id: 'a', status: 'Zebra' }, { id: 'b', status: 'Connected' }, { id: 'c', status: 'Aardvark' },
    ], 'status')).toEqual(['Connected', 'Aardvark', 'Zebra']);
  });

  test('STATUS_ORDER puts the two fault states first', () => {
    expect(STATUS_ORDER.slice(0, 2)).toEqual(['Setup failed', 'Blocked']);
  });
});

describe('groupRadioRows — invariants that keep the UI honest', () => {
  test('row order inside a group is preserved from the input', () => {
    // Callers sort/filter before grouping; re-ordering here would silently
    // discard that.
    const out = groupRadioRows(
      [{ id: '3', group: 'G' }, { id: '1', group: 'G' }, { id: '2', group: 'G' }],
      'custom', acc,
    );
    expect(out[0].rows.map(r => r.id)).toEqual(['3', '1', '2']);
  });

  test('keys are namespaced by kind, so collapse state cannot leak across kinds', () => {
    const [custom] = groupRadioRows([{ id: 'a', group: 'Connected' }], 'custom', acc);
    const [status] = groupRadioRows([{ id: 'a', status: 'Connected' }], 'status', acc);
    expect(custom.name).toBe(status.name);      // same display name...
    expect(custom.key).not.toBe(status.key);    // ...different identity
  });

  test('every catch-all bucket shares one key per kind regardless of label', () => {
    const [g] = groupRadioRows([{ id: 'a' }], 'custom', acc);
    const [b] = groupRadioRows([{ id: 'a' }], 'band', acc);
    expect(g.isUngrouped && b.isUngrouped).toBe(true);
    expect(g.key).not.toBe(b.key);
  });

  test('no group is ever emitted empty', () => {
    const out = groupRadioRows([{ id: 'a', group: 'G' }, { id: 'b' }], 'custom', acc);
    expect(out.every(x => x.rows.length > 0)).toBe(true);
  });

  test('every row ends up in exactly one group', () => {
    const rows: Row[] = [
      { id: 'a', group: 'X' }, { id: 'b', group: 'Y' }, { id: 'c' }, { id: 'd', group: 'X' },
    ];
    const out = groupRadioRows(rows, 'custom', acc);
    const seen = out.flatMap(g => g.rows.map(r => r.id));
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(seen).toHaveLength(rows.length);
  });

  test('empty and nullish input produce no groups rather than an empty bucket', () => {
    expect(groupRadioRows([], 'custom', acc)).toEqual([]);
    expect(groupRadioRows(null as any, 'custom', acc)).toEqual([]);
  });

  test('the selector offers exactly the three supported kinds', () => {
    expect(RADIO_GROUP_KINDS.map(k => k.key)).toEqual(['custom', 'band', 'status']);
  });
});
