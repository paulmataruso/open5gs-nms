// Grouping for the RAN page's radio lists.
//
// Deliberately pure and generic over the row type. The 4G/5G lists (RadioRowData)
// and the 2G BTS lists (BtsRowData) have completely different shapes, but both
// need the identical partition/order/collapse behaviour — so the shape-specific
// part is pushed out into accessors and the rules live here once. Three 4G/5G
// layouts plus three 2G layouts share this; duplicating the ordering rules six
// ways is how they would drift.
//
// No React import and no localStorage access on purpose: this file stays
// executable in a plain node test. The per-viewer persistence that goes with it
// (chosen grouping kind, collapsed set) lives in RANPage.tsx beside the
// pre-existing loadDefaultRadioLayout(), which is where this page already keeps
// that concern.

export type RadioGroupKind = 'custom' | 'band' | 'status';

export const RADIO_GROUP_KINDS: { key: RadioGroupKind; label: string }[] = [
  { key: 'custom', label: 'Group' },
  { key: 'band',   label: 'Band' },
  { key: 'status', label: 'Status' },
];

/** Label for the catch-all bucket, per grouping kind. */
export const UNGROUPED_LABEL: Record<RadioGroupKind, string> = {
  custom: 'Ungrouped',
  band:   'No band set',
  // 'status' is derived from live state and is never absent, so it has no
  // catch-all. Present for exhaustiveness.
  status: 'Unknown',
};

// Status is ranked rather than sorted alphabetically: an operator scanning this
// list wants faults near the top, and "Blocked" before "Connected" is just
// noise. Any label not listed sorts alphabetically after these.
export const STATUS_ORDER: string[] = ['Setup failed', 'Blocked', 'Connected', 'Idle'];

export interface RadioGroup<T> {
  /** Stable, kind-namespaced identity — used for React keys and collapse state. */
  key: string;
  /** What the group header shows. */
  name: string;
  /** True for the catch-all bucket, which always sorts last. */
  isUngrouped: boolean;
  rows: T[];
}

export interface RadioGroupAccessors<T> {
  group: (row: T) => string | null | undefined;
  band: (row: T) => string | null | undefined;
  status: (row: T) => string;
}

function valueFor<T>(row: T, kind: RadioGroupKind, acc: RadioGroupAccessors<T>): string | null {
  const raw = kind === 'custom' ? acc.group(row)
            : kind === 'band'   ? acc.band(row)
            :                     acc.status(row);
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed ? trimmed : null;
}

// Numeric-aware so band names order the way an operator reads them: B5 before
// B48 before B66, which a plain string sort gets wrong (B48 < B5).
function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function statusRank(name: string): number {
  const i = STATUS_ORDER.indexOf(name);
  return i === -1 ? STATUS_ORDER.length : i;
}

/**
 * Partitions rows into ordered, named groups.
 *
 * Order: named groups first; for 'status' by STATUS_ORDER then alphabetically,
 * otherwise numeric-aware alphabetically. The catch-all bucket is ALWAYS last,
 * so an operator's own groups never get pushed below "Ungrouped".
 *
 * Row order within a group is preserved from the input, so whatever sort or
 * filter the caller already applied still holds.
 */
export function groupRadioRows<T>(
  rows: T[],
  kind: RadioGroupKind,
  acc: RadioGroupAccessors<T>,
): RadioGroup<T>[] {
  const buckets = new Map<string, RadioGroup<T>>();

  for (const row of rows ?? []) {
    const value = valueFor(row, kind, acc);
    const isUngrouped = value === null;
    const name = value ?? UNGROUPED_LABEL[kind];
    // Namespaced by kind so a group called "Connected" under 'custom' can never
    // share collapse state with the 'status' group of the same name.
    const key = `${kind}:${isUngrouped ? '\u0000ungrouped' : name.toLowerCase()}`;

    const existing = buckets.get(key);
    if (existing) existing.rows.push(row);
    else buckets.set(key, { key, name, isUngrouped, rows: [row] });
  }

  return [...buckets.values()].sort((a, b) => {
    if (a.isUngrouped !== b.isUngrouped) return a.isUngrouped ? 1 : -1;
    if (kind === 'status') {
      const r = statusRank(a.name) - statusRank(b.name);
      if (r !== 0) return r;
    }
    return compareNames(a.name, b.name);
  });
}
