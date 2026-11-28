import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

/**
 * Both sources of truth are read from DISK, not imported with `?raw`.
 *
 * vitest.config.ts sets `css: false`, which stubs every CSS import -- so
 * `import css from '../../../index.css?raw'` resolves to the EMPTY STRING
 * rather than failing. An empty definitions set makes every "is this token
 * defined" assertion below pass vacuously, which is precisely the shape of
 * bug this file exists to catch, so it would have been a quiet one. The
 * `reads both sources of truth at all` test is what caught it; keep it.
 *
 * Reading through `process.cwd()` rather than `import.meta.url`: under the
 * jsdom environment `new URL()` produces jsdom's URL, which Node's
 * `fileURLToPath` rejects with "must be ... an instance of URL. Received an
 * instance of URL". Both files are asserted to exist, so a cwd change fails
 * loudly instead of silently reading nothing.
 */
function readFromRoot(rel: string): string {
  // vitest runs with cwd at the frontend root. Asserted below, so a change
  // fails loudly rather than silently reading nothing -- which is the whole
  // hazard this function exists to avoid.
  const abs = `${process.cwd()}/${rel}`;
  if (!existsSync(abs)) throw new Error(`expected to find ${rel} at ${abs}`);
  return readFileSync(abs, 'utf-8');
}

const tailwindConfigSource = readFromRoot('tailwind.config.js');
const indexCssSource = readFromRoot('src/index.css');

/**
 * Every `nms-*` Tailwind class or colour token a component uses is defined.
 *
 * WHY. Tailwind does not error on a class it has never heard of -- it
 * generates nothing, and the element renders completely unstyled. This
 * project has hit that four separate times: `nms-btn-secondary` on five
 * buttons but never defined (no colour, no box); `nms-accent-hover`,
 * `nms-surface-1` and `nms-text-secondary` used as colour tokens in 20+
 * places but absent from tailwind.config.js; and `nms-checkbox` on 11+
 * checkboxes with no CSS rule at all. None of them threw, logged or failed a
 * build, and each looked like a deliberate (if plain) design until somebody
 * compared it with a neighbour.
 *
 * There are two sources of truth and two kinds of token:
 *   - a COLOUR token (`bg-nms-accent`, `hover:text-nms-text-dim/60`) must be a
 *     key of `theme.extend.colors` in tailwind.config.js;
 *   - a COMPONENT class (`nms-card`, `nms-btn-primary`) must be a `.nms-*`
 *     rule in src/index.css.
 *
 * SCAN SCOPE -- the part that matters. Only CLASS POSITIONS are read:
 * `className="..."`, `className={...}` (template literals and conditionals
 * included), `class="..."`, an object property `className: '...'`, and the
 * arguments of `clsx(...)` (the only class helper this project uses). Every
 * string literal in a file is NOT scanned, because `nms-` appears in plenty
 * of strings that are not Tailwind classes, and a scanner that reads them
 * would either need an ever-growing allow-list or would be switched off. The
 * real ones, each pinned by a fixture test below:
 *   - `--nms-bottom-chrome`: a CSS custom property set from JS in
 *     components/common/MobileChrome.tsx and read through a `style` prop.
 *   - `'nms-theme'`: the localStorage key (STORAGE_KEY) in
 *     contexts/theme-context.ts. An assignment, not a class.
 *   - `20-nms-dummy-*.netdev`: display TEXT inside a span in pages/FRRPage.tsx
 *     (and TunInterfacePage.tsx). The span's own className is `font-mono`;
 *     the token sits in its children.
 *   - `open5gs-nms-backend`: a Docker container name in pages/LogsPage.tsx.
 *     Token matching is anchored on the WHOLE whitespace-delimited token for
 *     exactly this reason; a substring match would slice `nms-backend` out of
 *     it.
 *
 * KNOWN GAP, by design: a class string held in a variable and passed in later
 * (`const cls = 'nms-card'; ... className={cls}`) is not seen, because the
 * literal is not in a class position where it is written. That is the price
 * of excluding the false positives above; the object-property form
 * `className: '...'` is covered because this codebase uses it.
 *
 * There used to be a live instance of that gap: DashboardPage's StatCard took
 * `color="nms-green"` as a plain prop and composed `bg-${color}/10` from it,
 * so three tokens sat outside any class position. It was also a worse bug
 * than being unchecked -- Tailwind scans for COMPLETE class names, so a
 * composed one is never seen and need not exist in the output at all. That
 * prop now carries whole class names, which is why the last describe below
 * can require the tree to contain NO composed colour utility rather than
 * carve out an exception.
 *
 * The frontend has no @types/node, so there is no `fs`: sources arrive through
 * Vite's `?raw` and `import.meta.glob`, as in navFidelity.test.ts.
 */

// ---- scanner (exported so the fixture tests can drive it directly) ----

type Closer = ')' | ']' | '}';

/**
 * Lex JS/TSX code from `start`, collecting the CONTENT of every string and
 * template-literal text segment, skipping comments. Stops at the first
 * unmatched closing bracket (returning its index) or, in `single` mode, right
 * after the first string. A comment is skipped rather than lexed because an
 * apostrophe inside one (MobileNavSheet.tsx has `.nms-input alone` in a `//`
 * comment) would otherwise open a string that runs to the next quote.
 */
function lexCode(
  src: string,
  start: number,
  out: string[],
  single = false,
): number {
  const len = src.length;
  let i = start;
  let depth = 0;
  while (i < len) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < len && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? len : e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      // A newline ends a quoted string: JS forbids it inside one, and it keeps
      // a stray apostrophe in prose from swallowing the rest of the file.
      while (j < len && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        s += src[j];
        j++;
      }
      out.push(s);
      i = j + 1;
      if (single) return i;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let s = '';
      while (j < len && src[j] !== '`') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') {
          // Text before an interpolation is its own segment, so a token never
          // spans a `${...}` (which would glue two classes into one).
          out.push(s);
          s = '';
          j = lexCode(src, j + 2, out) + 1;
          continue;
        }
        s += src[j];
        j++;
      }
      out.push(s);
      i = j + 1;
      if (single) return i;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c as Closer) === ')' || (c as Closer) === ']' || (c as Closer) === '}') {
      if (depth === 0) return i;
      depth--;
    }
    i++;
  }
  return len;
}

/** `className=` / `class=` (JSX or HTML), and `className:` (object property). */
const POSITION_RE = /\b(?:className|class)\s*(=|:)\s*/g;
/** Class-merging helpers. `clsx` is the only one this project uses. */
const HELPER_RE = /\b(?:clsx|cn|twMerge|classNames)\s*\(/g;

/**
 * Every string a source file writes in a class position.
 *
 * `className: string` (a TYPE annotation) is skipped because what follows the
 * colon is an identifier, not a literal; `className={className}` is skipped
 * for the same reason -- there is no literal there to read.
 */
export function classPositionStrings(src: string): string[] {
  const out: string[] = [];

  for (const m of src.matchAll(POSITION_RE)) {
    const p = (m.index ?? 0) + m[0].length;
    const c = src[p];
    if (c === '"' || c === "'" || c === '`') {
      lexCode(src, p, out, true);
    } else if (c === '{' && m[1] === '=') {
      lexCode(src, p + 1, out);
    }
  }

  for (const m of src.matchAll(HELPER_RE)) {
    lexCode(src, (m.index ?? 0) + m[0].length, out);
  }

  return out;
}

/** Whitespace-delimited tokens of every class-position string. */
export function classTokens(src: string): string[] {
  return classPositionStrings(src).flatMap((s) => s.split(/\s+/).filter(Boolean));
}

/**
 * Tailwind utilities that take a colour. Longest-first alternation is not
 * needed because the whole token is anchored (`^...$`). `border` also takes a
 * side (`border-l-nms-accent`, used in BackupPage/MetricsPage); `ring-offset`
 * and `divide` are included because Tailwind defines them even though this
 * codebase uses only `divide`.
 */
const COLOR_UTILITY_RE =
  /^(?:bg|text|border(?:-[xytblrse])?|ring(?:-offset)?|from|to|via|divide|outline|shadow|accent|fill|stroke|placeholder|caret|decoration)-(nms-[a-z0-9-]+)$/;
const COMPONENT_CLASS_RE = /^nms-[a-z0-9-]+$/;

/**
 * A colour utility whose TOKEN comes from an interpolation, e.g.
 * `bg-${color}/10`. Distinct from every other check here, and worse: the
 * others are about a class that is defined or not, while this one is about a
 * class Tailwind never sees at all. Tailwind generates CSS by scanning source
 * text for complete class names, so a composed utility need not exist in the
 * output -- and when it does, it is only because some unrelated file happens
 * to spell the same class out, which makes an edit over there able to
 * unstyle an element over here.
 *
 * An interpolation supplying a whole class (`${t.bg}`) is deliberately NOT
 * matched: that is the ordinary conditional-class idiom, and its branches are
 * real literals the scanner reads.
 */
const COMPOSED_UTILITY_RE =
  /\b(?:bg|text|border(?:-[xytblrse])?|ring(?:-offset)?|from|to|via|divide|outline|shadow|accent|fill|stroke|placeholder|caret|decoration)-\$\{/;

/**
 * Split on ':' but not inside [...], so an arbitrary variant such as
 * `[&::-webkit-scrollbar]:hidden` or `data-[state=open]:` keeps its own
 * colons. This codebase has no `data-[...]` variant with a colon inside, but
 * arbitrary variants with `::` do occur, so brackets are respected.
 */
function lastVariantSegment(token: string): string {
  let depth = 0;
  let last = 0;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    else if (c === ':' && depth === 0) last = i + 1;
  }
  return token.slice(last);
}

export type Classified =
  | { kind: 'color'; name: string }
  | { kind: 'class'; name: string }
  /** Mentions `nms-` but fits neither form -- reported rather than ignored. */
  | { kind: 'unrecognised'; token: string }
  | { kind: 'none' };

/**
 * Reduce a raw class token to the thing that must be defined:
 *   `!hover:bg-nms-accent/20`  ->  colour `nms-accent`
 *   `md:nms-card`              ->  class  `nms-card`
 */
export function classify(raw: string): Classified {
  let t = lastVariantSegment(raw);
  t = t.replace(/^!/, '');
  // Opacity modifier: `/20`, `/[0.06]`.
  t = t.replace(/\/(?:\d+|\[[^\]]+\])$/, '');

  const color = COLOR_UTILITY_RE.exec(t);
  if (color) return { kind: 'color', name: color[1] };
  if (COMPONENT_CLASS_RE.test(t)) return { kind: 'class', name: t };
  if (t.includes('nms-')) return { kind: 'unrecognised', token: raw };
  return { kind: 'none' };
}

export interface Usage {
  colors: Set<string>;
  classes: Set<string>;
  unrecognised: Set<string>;
}

export function usageIn(src: string): Usage {
  const u: Usage = { colors: new Set(), classes: new Set(), unrecognised: new Set() };
  for (const tok of classTokens(src)) {
    const c = classify(tok);
    if (c.kind === 'color') u.colors.add(c.name);
    else if (c.kind === 'class') u.classes.add(c.name);
    else if (c.kind === 'unrecognised') u.unrecognised.add(c.token);
  }
  return u;
}

// ---- sources of truth ----

/**
 * Keys of the `colors: { ... }` block in tailwind.config.js. The shape, read
 * from the file: flat quoted keys, `'nms-accent': 'rgb(var(--nms-accent-rgb) /
 * <alpha-value>)'`, one per line, with `//` comment lines between them. The
 * block ends at the closing brace at six-space indent.
 */
export function definedColors(configSrc: string): Set<string> {
  const block = /\bcolors:\s*\{([\s\S]*?)\n\s{6}\}/.exec(configSrc);
  const body = (block?.[1] ?? '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
  return new Set(Array.from(body.matchAll(/'(nms-[a-z0-9-]+)'\s*:/g), (m) => m[1]));
}

/** `.nms-*` rule selectors in index.css, comments stripped first. */
export function definedClasses(css: string): Set<string> {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return new Set(Array.from(code.matchAll(/^\s*\.(nms-[a-z0-9-]+)\s*\{/gm), (m) => m[1]));
}

const DEFINED_COLORS = definedColors(tailwindConfigSource);
const DEFINED_CLASSES = definedClasses(indexCssSource);

// ---- the whole source tree ----

/**
 * Every .ts/.tsx under src as a { path: source } map, walked from DISK.
 *
 * An eager `import.meta.glob(..., { query: '?raw' })` is the obvious way to
 * do this and was the first attempt. It also WRECKS THE COVERAGE REPORT,
 * in two directions at once, because a `?raw` import still registers a
 * module id for every file it touches.
 *
 * Every file in the tree started counting as covered with ONE statement --
 * the exported string -- so the headline read
 *
 *   210 covered file(s), 630/640 statements (98.43%)
 *
 * against a true 12 files and 466 of 51,462 statements (0.9%). That is the
 * dangerous half: 98.43% looks like a finished job. And where a file was
 * genuinely covered by another test, the merged report took the raw variant
 * INSTEAD of the real execution:
 *
 *   api/modules.ts        7 -> 1 covered statements
 *   api/suci.ts           8 -> 1
 *   mobile/mobileNav.ts  22 -> 1
 *
 * The per-file floor caught the three regressions, which is precisely why
 * it is per-file: a percentage floor would have seen 0.9% climb to 98.43%
 * and waved it through. This test wants source TEXT, not modules, so
 * reading bytes keeps it out of the module graph entirely -- and is also
 * about twice as fast, since nothing goes through Vite's transform.
 *
 * Test files are excluded: their fixtures deliberately contain bad tokens.
 */
function walkSources(dir: string, out: Record<string, string> = {}): Record<string, string> {
  for (const entry of readdirSync(`${process.cwd()}/${dir}`, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') walkSources(rel, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out[`/${rel}`] = readFromRoot(rel);
    }
  }
  return out;
}

const SOURCES = walkSources('src');

const USED_COLORS = new Map<string, string[]>();
const USED_CLASSES = new Map<string, string[]>();
const UNRECOGNISED: string[] = [];

for (const [path, src] of Object.entries(SOURCES)) {
  const u = usageIn(src);
  for (const c of u.colors) USED_COLORS.set(c, [...(USED_COLORS.get(c) ?? []), path]);
  for (const c of u.classes) USED_CLASSES.set(c, [...(USED_CLASSES.get(c) ?? []), path]);
  for (const t of u.unrecognised) UNRECOGNISED.push(`${path}: ${t}`);
}

// ---- tests ----

describe('nms-* tokens the scanner is checking against', () => {
  it('reads both sources of truth at all -- an empty set would pass everything', () => {
    // Guards the extractors. If tailwind.config.js changes its colors block
    // shape or index.css stops using `.nms-*` rules, this fails loudly rather
    // than reporting every use as defined-by-default or every use as missing.
    expect(DEFINED_COLORS.size).toBeGreaterThanOrEqual(10);
    expect(DEFINED_CLASSES.size).toBeGreaterThanOrEqual(8);
    expect(DEFINED_COLORS).toContain('nms-accent');
    expect(DEFINED_COLORS).toContain('nms-text-dim');
    expect(DEFINED_CLASSES).toContain('nms-card');
    expect(DEFINED_CLASSES).toContain('nms-btn-primary');
  });

  it('does not count a colour token as a component class or the reverse', () => {
    // `nms-accent` is a colour (config) and has no `.nms-accent` rule;
    // `nms-card` is a rule and is not a colour. Mixing the sets would let a
    // class typo hide behind a same-named colour.
    expect(DEFINED_CLASSES.has('nms-accent')).toBe(false);
    expect(DEFINED_COLORS.has('nms-card')).toBe(false);
  });
});

describe('the scanner is not vacuous', () => {
  it('scans a substantial part of the source tree', () => {
    // The glob must really match: a wrong pattern yields zero files and a
    // clean sweep of nothing. The app has well over 100 source files.
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
    expect(USED_COLORS.size).toBeGreaterThanOrEqual(10);
    expect(USED_CLASSES.size).toBeGreaterThanOrEqual(6);
  });

  it('finds specific known-good tokens in real components', () => {
    // Heavily used across the app; losing any of these means the matcher (or
    // the glob) stopped seeing real class positions.
    expect(USED_COLORS.has('nms-accent')).toBe(true);
    expect(USED_COLORS.has('nms-text-dim')).toBe(true);
    expect(USED_COLORS.has('nms-border-strong')).toBe(true);
    expect(USED_CLASSES.has('nms-card')).toBe(true);
    expect(USED_CLASSES.has('nms-btn-primary')).toBe(true);
    expect(USED_CLASSES.has('nms-table-scroll')).toBe(true);
    // Reached only through clsx(...) conditionals and a side-qualified border
    // utility (`border-l-nms-amber` in MetricsPage.tsx), so these prove the
    // helper-argument and `border-<side>-` paths work too.
    expect(USED_COLORS.has('nms-amber')).toBe(true);
    expect(USED_COLORS.has('nms-red-strong')).toBe(true);
  });
});

describe('every nms-* token in a class position is defined', () => {
  it('every colour token is declared in tailwind.config.js', () => {
    // The `nms-accent-hover` / `nms-surface-1` / `nms-text-secondary` failure:
    // a colour utility whose token is not a config key generates no CSS.
    const missing = [...USED_COLORS.entries()]
      .filter(([name]) => !DEFINED_COLORS.has(name))
      .map(([name, files]) => `${name} (${files.join(', ')})`);
    expect(missing).toEqual([]);
  });

  it('every bare component class is defined in index.css', () => {
    // The `nms-btn-secondary` / `nms-checkbox` failure: a class with no rule.
    const missing = [...USED_CLASSES.entries()]
      .filter(([name]) => !DEFINED_CLASSES.has(name))
      .map(([name, files]) => `${name} (${files.join(', ')})`);
    expect(missing).toEqual([]);
  });

  it('no class-position token mentions nms- in a form the matcher cannot place', () => {
    // A token such as `bg-nms-accent` is understood; something like
    // `wibble-nms-accent` is neither a known colour utility nor a bare class.
    // Reporting it is safer than silently skipping it, since an unknown
    // utility prefix is exactly how a new phantom would slip past.
    expect(UNRECOGNISED).toEqual([]);
  });

});

describe('the matcher rules, on inline fixtures', () => {
  it('does not report --nms-bottom-chrome, a CSS custom property in a style prop', () => {
    // components/common/MobileChrome.tsx sets it from JS and reads it via style.
    const src = `
      el.style.setProperty('--nms-bottom-chrome', px);
      return <div style={{ paddingBottom: 'var(--nms-bottom-chrome)' }} className="p-2" />;
    `;
    const u = usageIn(src);
    expect([...u.colors, ...u.classes, ...u.unrecognised]).toEqual([]);
  });

  it("does not report 'nms-theme', a localStorage key", () => {
    // contexts/theme-context.ts STORAGE_KEY: an assignment, not a class.
    const src = `export const STORAGE_KEY = 'nms-theme'; localStorage.getItem('nms-theme');`;
    const u = usageIn(src);
    expect([...u.colors, ...u.classes, ...u.unrecognised]).toEqual([]);
  });

  it('does not report 20-nms-dummy-*.netdev, display text in a span child', () => {
    // pages/FRRPage.tsx: the span's own className is font-mono; the token is
    // in its children, so it is not in a class position.
    const src = `<span className="font-mono">/etc/systemd/network/20-nms-dummy-*.netdev</span>`;
    const u = usageIn(src);
    expect([...u.colors, ...u.classes, ...u.unrecognised]).toEqual([]);
    expect(classTokens(src)).toEqual(['font-mono']);
  });

  it('anchors the whole token: open5gs-nms-backend never yields nms-backend', () => {
    // pages/LogsPage.tsx names a Docker container this way. Even if such a
    // token did reach a class position, it must not be sliced.
    expect(classify('open5gs-nms-backend')).toEqual({
      kind: 'unrecognised',
      token: 'open5gs-nms-backend',
    });
    const c = classify('open5gs-nms-backend');
    expect(c.kind).not.toBe('color');
    expect(c.kind).not.toBe('class');
    // ...and as plain text or a string assignment it is not scanned at all.
    const src = `const name = 'open5gs-nms-backend'; <span>open5gs-nms-backend</span>`;
    expect(usageIn(src).unrecognised.size).toBe(0);
  });

  it('does see a phantom in a class position (the scanner can fail)', () => {
    // Proof the guard is live: each of the four historical phantoms, written
    // in each class-position form, is picked up and is absent from the real
    // definitions.
    const src = `
      <button className="nms-btn-secondary px-2" />
      <div className={\`bg-nms-surface-1 \${x ? 'text-nms-text-secondary' : ''}\`} />
      <i className={clsx('a', ok && 'hover:bg-nms-accent-hover/20')} />
      <input className="nms-checkboxx" />
      const S = { className: 'nms-card-extra' };
    `;
    const u = usageIn(src);
    expect([...u.classes].sort()).toEqual(['nms-btn-secondary', 'nms-card-extra', 'nms-checkboxx']);
    expect([...u.colors].sort()).toEqual([
      'nms-accent-hover',
      'nms-surface-1',
      'nms-text-secondary',
    ]);
    for (const c of u.colors) expect(DEFINED_COLORS.has(c)).toBe(false);
    for (const c of u.classes) expect(DEFINED_CLASSES.has(c)).toBe(false);
  });

  it('normalises variants, important, opacity and side-qualified utilities', () => {
    // Every form below occurs in the real tree (hover:, group-hover:, focus:,
    // peer-checked:, disabled:hover:, active:, /20, border-l-).
    expect(classify('hover:bg-nms-surface-2/50')).toEqual({ kind: 'color', name: 'nms-surface-2' });
    expect(classify('group-hover:text-nms-accent')).toEqual({ kind: 'color', name: 'nms-accent' });
    expect(classify('disabled:hover:text-nms-text-dim')).toEqual({ kind: 'color', name: 'nms-text-dim' });
    expect(classify('!bg-nms-red/[0.06]')).toEqual({ kind: 'color', name: 'nms-red' });
    expect(classify('border-l-nms-accent')).toEqual({ kind: 'color', name: 'nms-accent' });
    expect(classify('from-nms-accent')).toEqual({ kind: 'color', name: 'nms-accent' });
    expect(classify('md:nms-card')).toEqual({ kind: 'class', name: 'nms-card' });
    // An arbitrary variant keeps its own colons and brackets.
    expect(classify('[&::-webkit-scrollbar]:hidden')).toEqual({ kind: 'none' });
    expect(classify('font-mono')).toEqual({ kind: 'none' });
  });

  it('rejects a colour utility built from an interpolation', () => {
    // The StatCard bug, as a fixture: the matcher must see this as unplaceable
    // rather than silently skipping it, because the token it would need is
    // only known at runtime.
    expect(classify('bg-${color}/10')).toEqual({ kind: 'none' });
    expect(COMPOSED_UTILITY_RE.test('bg-${color}/10')).toBe(true);
    expect(COMPOSED_UTILITY_RE.test('bg-nms-accent/10')).toBe(false);
    // An interpolation that supplies a WHOLE class is fine -- that is the
    // normal `${cond ? 'a' : 'b'}` idiom, and both branches are real literals
    // the scanner already reads.
    expect(COMPOSED_UTILITY_RE.test('p-2.5 rounded-lg ${t.bg}')).toBe(false);
  });

  it('does not read a comment or an apostrophe in prose as a string', () => {
    // MobileNavSheet.tsx has `// ... .nms-input alone is ~36px.` inside JSX.
    const src = `
      <input
        // rest of the mobile chrome; .nms-input alone is ~36px.
        className="nms-input"
      />
    `;
    const u = usageIn(src);
    expect([...u.classes]).toEqual(['nms-input']);
  });
});

/**
 * The RAW text of every class position, interpolations intact.
 *
 * classPositionStrings() deliberately drops `${...}` -- it yields the literal
 * pieces a token scan can check, so `bg-${c}/10` reaches it already split into
 * `bg-` and `/10` and the composed form is structurally invisible there. The
 * composed check therefore needs the unsplit span, which is why this exists
 * alongside it rather than reusing it.
 */
export function classPositionRaw(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(POSITION_RE)) {
    const start = (m.index ?? 0) + m[0].length;
    const c = src[start];
    if (c === '"' || c === "'" || c === '`') {
      // Quoted: to the matching unescaped quote (a template may nest braces).
      let i = start + 1;
      let depth = 0;
      for (; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (c === '`' && src[i] === '{' && src[i - 1] === '$') depth++;
        else if (c === '`' && src[i] === '}' && depth > 0) depth--;
        else if (src[i] === c && depth === 0) break;
      }
      out.push(src.slice(start, Math.min(i + 1, src.length)));
    } else if (c === '{' && m[1] === '=') {
      // JSX expression: to the brace that closes it, ignoring braces inside
      // strings so a class literal containing one cannot end the span early.
      let depth = 0;
      let quote: string | null = null;
      let i = start;
      for (; i < src.length; i++) {
        const ch = src[i];
        if (quote) {
          if (ch === '\\') { i++; continue; }
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) break; }
      }
      out.push(src.slice(start, Math.min(i + 1, src.length)));
    }
  }
  return out;
}

/**
 * Every `<utility>-nms-<token>` reference anywhere in a file, not only in a
 * class position.
 *
 * A class-position scan cannot see a colour held in a lookup table and applied
 * through an interpolation -- `${STAT_TINTS[tint].bg}` is an identifier, so the
 * literal `'bg-nms-green/10'` sits in an object several lines away. That
 * indirection is the RIGHT fix for a composed class (it is what this change
 * does to StatCard), so the check has to follow it: otherwise replacing a
 * composition with a table trades a caught bug for an uncatchable one. A
 * mutation pointing a tint at a non-existent token survived the
 * class-position tests and is killed by this one.
 *
 * Deliberately not restricted to string literals or to class positions: a
 * colour utility naming an nms token is unambiguous wherever it appears, and
 * the looser sweep also covers a constant, a helper's return value or a map.
 */
export function colorUtilityTokens(src: string): string[] {
  return Array.from(src.matchAll(COLOR_UTILITY_SCAN_RE), (m) => m[1]);
}

/**
 * Unanchored and global, unlike COLOR_UTILITY_RE above, which is anchored
 * (`^...$`) because it classifies ONE whitespace-delimited token. This one
 * sweeps free text, so it must match mid-string -- the two are not
 * interchangeable and sharing one would break the token classifier.
 */
const COLOR_UTILITY_SCAN_RE =
  /\b(?:bg|text|border(?:-[xytblrse])?|ring(?:-offset)?|from|to|via|divide|outline|shadow|accent|fill|stroke|placeholder|caret|decoration)-(nms-[a-z0-9-]+)/g;

describe('every colour token referenced through indirection is defined too', () => {
  it('nowhere in the source tree names a token tailwind.config.js lacks', () => {
    const offenders: string[] = [];
    for (const [file, src] of Object.entries(SOURCES)) {
      for (const token of colorUtilityTokens(src)) {
        if (!DEFINED_COLORS.has(token)) offenders.push(`${file}: ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('finds a token held in a lookup table rather than a class position', () => {
    // Vacuity guard, in the exact shape StatCard now uses.
    const fixture = `const TINTS = { ok: { bg: 'bg-nms-nope/10', fg: 'text-nms-nope' } } as const;`;
    expect(colorUtilityTokens(fixture)).toEqual(['nms-nope', 'nms-nope']);
    expect(classTokens(fixture)).toEqual([]);
  });

  it('reads a real reference, so the sweep is not matching nothing', () => {
    const all = Object.values(SOURCES).flatMap(colorUtilityTokens);
    expect(all.length).toBeGreaterThan(200);
    expect(new Set(all).size).toBeGreaterThanOrEqual(8);
  });
});

describe('no colour utility is composed from an interpolation', () => {
  it('nowhere in the source tree', () => {
    const offenders: string[] = [];
    for (const [file, src] of Object.entries(SOURCES)) {
      for (const s of classPositionRaw(src)) {
        if (COMPOSED_UTILITY_RE.test(s)) offenders.push(`${file}: ${s.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('and the scan really looks at the text that would carry one', () => {
    // Vacuity guard: the same sweep over fixtures must find every one, in
    // each of the forms a class position can take.
    const fixtures: Record<string, string> = {
      '/src/Jsx.tsx': '<div className={`p-2 bg-${color}/10`} />',
      '/src/Quoted.tsx': '<div className={clsx(`text-${tone}`)} />',
      '/src/Ternary.tsx': '<div className={ok ? `border-${c}` : "border-nms-border"} />',
    };
    const found: string[] = [];
    for (const [file, src] of Object.entries(fixtures)) {
      for (const s of classPositionRaw(src)) {
        if (COMPOSED_UTILITY_RE.test(s)) found.push(file);
      }
    }
    expect(found.sort()).toEqual(['/src/Jsx.tsx', '/src/Quoted.tsx', '/src/Ternary.tsx']);
  });

  it('does not flag a composed value that is not a colour utility', () => {
    // `p-${n}` and `grid-cols-${n}` are legitimate and common; only the
    // colour-bearing prefixes matter, because only those name a token.
    const ok = ['<div className={`p-${n} gap-${n}`} />', '<div className={`grid-cols-${n}`} />'];
    for (const src of ok) {
      for (const s of classPositionRaw(src)) expect(COMPOSED_UTILITY_RE.test(s)).toBe(false);
    }
  });
});
