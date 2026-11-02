import * as fs from 'fs';
import * as path from 'path';

// Static wiring guard for the RAN page's radio grouping, in the same style as
// rf-antenna-wiring.test.ts. The ordering rules are executed in
// ran-radio-grouping.test.ts; what cannot be executed here (no frontend test
// runner in this project) is the JSX wiring, and each of these regressions is
// silent in a way a reviewer would not catch:
//
//   * A layout losing its group chip. Grouping by "Group" then has no way to
//     assign anything in that layout, so the selector appears broken rather
//     than unassigned — and there are six layouts to keep in step (three
//     4G/5G, three 2G).
//   * The group header reverting to a clickable <div>. It is the only control
//     in the feature, and a div loses keyboard activation, the focus ring and
//     the expanded/collapsed announcement all at once.
//   * The content indent going away, which is the entire visual point: without
//     it the group name and its radios read as one flat list again.

const FRONTEND = path.resolve(__dirname, '../../../frontend/src');
const read = (rel: string) => fs.readFileSync(path.join(FRONTEND, rel), 'utf-8');

const RAN = read('components/ran/RANPage.tsx');
const GROUPING = read('components/ran/radio-grouping.ts');

describe('RAN page grouping — wiring', () => {
  test('every one of the six radio layouts renders the group chip', () => {
    // 3 x 4G/5G (Table, Collapsible List, List + Detail Panel) + 3 x 2G.
    expect(RAN.match(/<RadioGroupTag/g) ?? []).toHaveLength(6);
  });

  test('all three 4G/5G layouts accept the grouping props', () => {
    expect(RAN.match(/radioGroups, knownGroups, onGroupSave \}: RadioListProps/g) ?? []).toHaveLength(3);
  });

  test('all three 2G layouts pull the grouping props out of the rest-spread', () => {
    // If they stayed inside `...block` they would be silently forwarded into
    // child components by the existing {...block} spreads.
    expect(RAN.match(/rows, unassigned, aIfaceUp, onNavigate, radioGroups, knownGroups, onGroupSave, \.\.\.block/g) ?? [])
      .toHaveLength(3);
  });

  test('the group header is a real button that announces its state', () => {
    const shell = RAN.slice(RAN.indexOf('function RadioGroupShell'));
    const body = shell.slice(0, shell.indexOf('\n}\n'));
    expect(body).toMatch(/<button type="button"/);
    expect(body).toMatch(/aria-expanded=\{!collapsed\}/);
    expect(body).not.toMatch(/<div[^>]*onClick/);
  });

  test('group contents stay indented from the group name', () => {
    const shell = RAN.slice(RAN.indexOf('function RadioGroupShell'));
    expect(shell.slice(0, shell.indexOf('\n}\n'))).toMatch(/pl-6/);
  });

  test('the new UI uses theme tokens, never a hardcoded hex colour', () => {
    for (const fn of ['function RadioGroupShell', 'function RadioGroupTag']) {
      const seg = RAN.slice(RAN.indexOf(fn));
      expect(seg.slice(0, seg.indexOf('\n}\n'))).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });

  test('the header exposes the grouping selector with an accessible name', () => {
    expect(RAN).toMatch(/aria-label="Group radios by"/);
    expect(RAN).toMatch(/RADIO_GROUP_KINDS\.map/);
  });

  test('collapse state is scoped per list AND per grouping kind', () => {
    // One shared key would make collapsing a 4G group collapse the 5G one of
    // the same name, and leak a collapsed set across Band -> Status.
    expect(RAN).toMatch(/function collapseKey\(scope: string, kind: RadioGroupKind\)/);
    expect(RAN).toMatch(/\$\{RADIO_GROUP_COLLAPSE_PREFIX\}\.\$\{scope\}\.\$\{kind\}/);
  });

  test('each interface card gets its own collapse scope', () => {
    expect(RAN).toMatch(/groupScope=\{title\.replace/);
  });

  test('2G group assignments are keyed by a prefix that cannot collide with an IP', () => {
    expect(RAN).toMatch(/function btsGroupKey\(id: string\): string \{ return `bts:\$\{id\}`; \}/);
  });

  test('the grouping module stays free of React and localStorage so it can be tested', () => {
    expect(GROUPING).not.toMatch(/from 'react'/);
    expect(GROUPING).not.toMatch(/^\s*(?!\/\/).*localStorage\./m);
  });

  // ── Group and band names stay on one line ─────────────────────────────────
  //
  // Reported from the UI: a group name wrapped to a second line inside its own
  // chip. A chip is a single label, so it must not break mid-name; the row is
  // what gives way instead.

  test('the group and band chips never wrap their own text', () => {
    const chips = RAN.match(/<span className="inline-flex items-center gap-1[^"]*"/g) ?? [];
    const tagChips = chips.filter(c => /shrink-0/.test(c));
    expect(tagChips.length).toBeGreaterThanOrEqual(2);
    for (const c of tagChips) expect(c).toMatch(/whitespace-nowrap/);
  });

  test('the radio tables give the name column the slack instead of a fixed third', () => {
    // grid-cols-3 fixed the name column at 33% of a half-width card, which is
    // what squeezed a long group name into two lines. The header and the rows
    // are separate grid containers, so each template must appear an even
    // number of times — once for the header, once for the rows.
    const templates = RAN.match(/grid-cols-\[minmax\(0,1fr\)_[^\]]+\]/g) ?? [];
    expect(templates.length).toBeGreaterThanOrEqual(4);
    for (const t of templates) {
      expect(templates.filter(x => x === t).length % 2).toBe(0);
    }
    // And no radio table is back on an even three-way split.
    expect(RAN).not.toMatch(/grid grid-cols-3 items-start/);
  });

  test('a group name too long for its container ellipsises on one line', () => {
    // `truncate` alone does nothing to a flex item: its automatic minimum size
    // is its content width, so the name overflows the header instead. min-w-0
    // is what makes it shrink, and `title` keeps the full text readable.
    const header = RAN.match(/'flex-1 min-w-0 text-sm font-semibold font-display truncate',[\s\S]{0,160}?title=\{name\}/);
    expect(header).not.toBeNull();
  });

  test('every tag save handler preserves the fields it is not setting', () => {
    // A partial optimistic update silently drops whichever field it omits —
    // the exact bug the backend upserts had before this feature.
    const saves = RAN.match(/setRadioTagsFull\(prev => \(\{[\s\S]{0,320}?\}\)\);/g) ?? [];
    expect(saves.length).toBeGreaterThanOrEqual(3);
    for (const s of saves) {
      expect(s).toMatch(/nickname/);
      expect(s).toMatch(/band/);
      expect(s).toMatch(/group/);
    }
  });
});
