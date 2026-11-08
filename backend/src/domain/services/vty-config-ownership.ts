// Ownership-aware read/modify/write for Osmocom's Cisco-IOS-style VTY config
// files (osmo-msc.cfg, osmo-hlr.cfg, osmo-stp.cfg, etc — NOT YAML; Open5GS's
// own NFs use yaml-config-repository.ts's rawYaml+deepMerge for that format).
//
// Real incident, 2026-09-12: sms-controller.ts's configureSms() used to
// blindly `fs.writeFileSync(path, template())` on every call. This project's
// actual, hand/VTY-maintained osmo-msc.cfg had accumulated real production
// config its own simplified template never modeled — an entire `cs7 instance
// 0` node (SS7 point-code), extra directives inside `network`/`msc` (A5/UEA
// ciphering, authentication policy, mncc timeouts/socket path), and entire
// `mncc-int`/`smpp`/`smsc` nodes (the last carrying live SMPP ESME passwords
// for the VectorCore MMSC and 2G-SMS-bridge integrations). osmo-hlr.cfg had
// the same shape of problem — a `ctrl` node and `ussd route prefix` lines the
// template never generates. A real run of configureSms() (triggered by this
// project's own 2G GSM module Uninstall) silently destroyed all of it in one
// shot. Restored from backup within seconds; this module is the actual fix.
//
// Ownership model: for a given file, the caller declares an explicit list of
// OwnedDirective entries — the *only* lines it is allowed to add, update, or
// remove. Every node the caller doesn't mention, and every line within an
// owned node that doesn't match one of its own directives, passes through
// completely unmodified. This mirrors yaml-config-repository.ts's own
// deepMerge philosophy ("overlay wins on keys it contains; everything only
// present on disk survives") adapted to this file format's indentation-based
// nesting instead of YAML's native one.

// One top-level entry in the file: a column-0 header line (a node name like
// `msc`, a flat directive like `stats interval 5`, a `!` comment/separator,
// or a blank line) plus every line more indented than it, until the next
// column-0 line. Deliberately only one level deep — every node this project
// currently needs to manage (network/msc/hlr/sgs) has flat, single-indent
// children; nodes with real second-level nesting (smpp's `esme <name>`
// sub-blocks) are always treated as fully opaque (see "never touch" below),
// so nothing here ever needs to parse inside them.
export interface VtyChunk {
  header: string;
  body: string[];
}

export function parseVtyChunks(text: string): VtyChunk[] {
  const lines = text.split('\n');
  // A trailing '' from the final newline splitting would otherwise become a
  // spurious empty chunk; drop exactly one, matching how the file was likely
  // terminated (a real trailing newline), not silently eating real content.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const chunks: VtyChunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      chunks.push({ header: '', body: [] });
      i++;
      continue;
    }
    if (/^\S/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== '' && /^\s/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      chunks.push({ header: line, body });
    } else {
      // Malformed input (an indented line with no preceding column-0
      // header) — keep it as its own chunk rather than silently dropping
      // it; a round-trip must never lose real content even if it can't
      // fully make sense of it.
      chunks.push({ header: line, body: [] });
      i++;
    }
  }
  return chunks;
}

export function serializeVtyChunks(chunks: VtyChunk[]): string {
  const lines: string[] = [];
  for (const c of chunks) {
    if (c.header !== '' || c.body.length === 0) lines.push(c.header);
    lines.push(...c.body);
  }
  return lines.join('\n') + '\n';
}

// One directive this caller owns. `node` matches a chunk's header exactly
// (after trimming) — e.g. 'msc', 'network', 'hlr', 'sgs'. `prefix` matches
// against a body line's own content (leading whitespace and all) to find
// the *existing* line to replace, regardless of its current value — e.g.
// /^\s*remote-ip\s+/ matches ` remote-ip 127.0.0.1` and would also match
// ` remote-ip 10.0.0.5`. `line` is the complete replacement line (including
// its own indentation) to write; `null` means "remove this directive if
// present, otherwise do nothing" (used for the GSM module's optional mgw
// peer block).
export interface OwnedDirective {
  node: string;
  prefix: RegExp;
  line: string | null;
}

// Merges `owned` directives into `currentText` (the real on-disk file),
// preserving every other node and every other line within an owned node
// exactly as found. If `currentText` is empty/missing (fresh install, no
// file to preserve anything from), returns `fallbackFullTemplate` verbatim
// instead — there is nothing to merge over yet, so the caller's own
// complete template is the only sensible starting point. If an owned node is
// missing entirely from an otherwise non-empty file (an unusual, likely
// hand-edited state), its lines are appended as a new chunk at the end —
// Osmocom's VTY parser does not require nodes to appear in any particular
// order, only that each one's own content is syntactically valid.
export function upsertVtyDirectives(
  currentText: string,
  owned: OwnedDirective[],
  fallbackFullTemplate: string,
): string {
  if (!currentText || !currentText.trim()) return fallbackFullTemplate;

  const chunks = parseVtyChunks(currentText);
  const byNode = new Map<string, OwnedDirective[]>();
  for (const d of owned) {
    if (!byNode.has(d.node)) byNode.set(d.node, []);
    byNode.get(d.node)!.push(d);
  }

  for (const [node, directives] of byNode) {
    let chunk = chunks.find(c => c.header.trim() === node);
    if (!chunk) {
      chunk = { header: node, body: [] };
      chunks.push(chunk);
    }
    for (const d of directives) {
      const idx = chunk.body.findIndex(l => d.prefix.test(l));
      if (d.line === null) {
        if (idx !== -1) chunk.body.splice(idx, 1);
      } else if (idx !== -1) {
        chunk.body[idx] = d.line;
      } else {
        chunk.body.push(d.line);
      }
    }
  }

  return serializeVtyChunks(chunks);
}

// ─── Nesting-aware ownership merge ───────────────────────────────────────────
//
// upsertVtyDirectives() above is deliberately one level deep, which is enough
// for osmo-msc.cfg / osmo-sgsn.cfg / osmo-hlr.cfg. osmo-bsc.cfg is not: it nests
// `network` > `bts N` > `trx N` > `timeslot N`, and `bts N` additionally
// contains its own sub-nodes (`bs-power-control`, `ms-power-control`) with their
// own children. A flat merge cannot address a directive inside `bts 0`, so
// osmo-bsc.cfg was still being regenerated wholesale — measured on a real
// deployment, that discarded 67 substantive hand-maintained lines including
// `cs7 instance 0`'s `point-code` (losing which takes down the A-interface to
// MSC outright), the full `amr tch-f`/`tch-h` codec tuning, ~25 lines of GPRS
// cell/NS timers, both power-control blocks, and msc 0's codec-list.
//
// This merge works the other way round from a generator: the operator's real
// file is the BASE, and only the specific directives the generator models are
// overwritten in place. Everything else is preserved byte for byte because it
// is never touched — which is the property that matters, rather than trying to
// enumerate everything worth keeping.

export interface PathDirective {
  /** Node headers from the document root, e.g. ['network', 'bts 0']. */
  path: string[];
  /** Matches the directive, tested against the TRIMMED line. */
  prefix: RegExp;
  /** Replacement text (indentation is applied automatically), or null to remove. */
  line: string | null;
}

/** Indent width, or null for a blank line. */
function indentWidth(line: string): number | null {
  if (/^\s*$/.test(line)) return null;
  return line.length - line.replace(/^\s*/, '').length;
}

/**
 * Walk `text` maintaining the current node path by indentation, replacing or
 * removing each owned directive where it sits, and appending any that were
 * absent to the end of their own node's block.
 *
 * A line is treated as a NODE header when the next non-blank line is indented
 * deeper than it; otherwise it is a leaf directive. That is the only way to tell
 * the two apart in this format — `bs-power-control` and `mode static` look
 * identical in isolation — and it holds for every Osmocom config this project
 * writes.
 */
function mergeOncePathDirectives(
  text: string,
  owned: PathDirective[],
): { text: string; missing: string[][] } {
  const lines = text.split('\n');

  // Resolve each line's node path once, and record which lines are node
  // HEADERS — a header belongs to its parent's path but is not a directive,
  // so it must never be chosen as the anchor to insert a sibling after (that
  // would put the new line inside the sub-node).
  const pathOf: string[][] = [];
  const isHeader: boolean[] = [];
  const stack: Array<{ header: string; indent: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const ind = indentWidth(lines[i]);
    if (ind === null) { pathOf.push(stack.map(s => s.header)); isHeader.push(false); continue; }
    while (stack.length > 0 && ind <= stack[stack.length - 1].indent) stack.pop();
    pathOf.push(stack.map(s => s.header));
    // Is this a node header? Look ahead to the next non-blank line.
    let j = i + 1;
    while (j < lines.length && indentWidth(lines[j]) === null) j++;
    const nextInd = j < lines.length ? indentWidth(lines[j]) : null;
    const header = nextInd !== null && nextInd > ind;
    isHeader.push(header);
    if (header) stack.push({ header: lines[i].trim(), indent: ind });
  }

  const samePath = (a: string[], b: string[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]);

  // Self-healing: a file written by the buggy append (see outIdxOf's comment)
  // holds NMS-generated lines in a node they were never declared for, and
  // simply writing the correct copy leaves the stale one behind — still
  // unparseable. So a line is dropped when it is VERBATIM an owned
  // directive's generated text while sitting at a path that directive is not
  // owned at.
  //
  // Deliberately narrow. Matching the owned PREFIX alone would delete real
  // operator config (`mgw remote-ip` is owned under `msc 0`, but an operator
  // may legitimately have one elsewhere that the generator does not model);
  // requiring an exact match on the full generated line means only output
  // this code itself produced, in a place it would never produce it, is
  // removed.
  const ownedPathsByLine = new Map<string, string[][]>();
  for (const o of owned) {
    if (o.line === null) continue;
    const at = ownedPathsByLine.get(o.line) ?? [];
    at.push(o.path);
    ownedPathsByLine.set(o.line, at);
  }
  const isMisplacedOwnedLine = (trimmed: string, path: string[]): boolean => {
    const homes = ownedPathsByLine.get(trimmed);
    if (!homes) return false;
    return !homes.some(h => h.length === path.length && h.every((v, i) => v === path[i]));
  };

  const applied = new Set<PathDirective>();
  const out: string[] = [];
  // outIdxOf[i] = where original line i ended up in `out`, or -1 if dropped.
  // Needed because the previous implementation located its insertion point by
  // searching `out` for the anchor line's RAW TEXT — which fails outright when
  // that anchor was itself an owned directive and had already been rewritten.
  // It then fell back to `out.length - 1`, i.e. end of file.
  //
  // Real consequence, reproduced live on a clean host 2026-11-07: osmo-bsc's
  // `meas-feed` (path `network`) and `mgw endpoint-domain` (path `msc 0`) both
  // landed at EOF, under the trailing `bsc` node, and osmo-bsc refused to
  // parse the file at all — "There is no such command" — taking 2G down. The
  // anchor that vanished was `timer net T3212 5` -> `timer net T3212 2`.
  // Re-merging also DUPLICATED them, since the appended copies sat outside the
  // node the next pass looked in.
  const outIdxOf: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ind = indentWidth(lines[i]);
    if (ind === null) { outIdxOf.push(out.length); out.push(lines[i]); continue; }
    const trimmed = lines[i].trim();
    if (isMisplacedOwnedLine(trimmed, pathOf[i])) { outIdxOf.push(-1); continue; }
    const d = owned.find(o => !applied.has(o) && samePath(o.path, pathOf[i]) && o.prefix.test(trimmed));
    if (!d) { outIdxOf.push(out.length); out.push(lines[i]); continue; }
    applied.add(d);
    if (d.line !== null) {
      outIdxOf.push(out.length);
      out.push(' '.repeat(ind) + d.line);
    } else {
      outIdxOf.push(-1);   // d.line === null -> drop the line entirely.
    }
  }

  // Anything not found is inserted at the end of its own node's block, so a
  // directive the generator models but the file lacks is still applied —
  // addressed by index, never by matching text that may have been rewritten.
  const inserts: Array<{ at: number; text: string }> = [];
  const missing: string[][] = [];
  for (const d of owned) {
    if (applied.has(d) || d.line === null) continue;

    // Prefer the last DIRECT, non-header child of the target node.
    let anchor = -1;
    let anchorIndent: number | null = null;
    for (let i = 0; i < lines.length; i++) {
      if (indentWidth(lines[i]) === null) continue;
      if (!samePath(d.path, pathOf[i])) continue;
      if (isHeader[i]) continue;
      anchor = i;
      anchorIndent = indentWidth(lines[i]);
    }

    if (anchor === -1) {
      // The node exists but has no direct directive of its own (only
      // sub-nodes), so anchor on its header and insert immediately after it.
      if (d.path.length === 0) continue;
      const ownHeader = d.path[d.path.length - 1];
      const parentPath = d.path.slice(0, -1);
      for (let i = 0; i < lines.length; i++) {
        if (indentWidth(lines[i]) === null) continue;
        if (!isHeader[i]) continue;
        if (lines[i].trim() !== ownHeader) continue;
        if (!samePath(parentPath, pathOf[i])) continue;
        anchor = i;
        anchorIndent = (indentWidth(lines[i]) ?? 0) + 1;
        break;
      }
    }

    // Node genuinely absent. Appending at EOF would put it under whatever
    // node happens to come last (the original bug); silently skipping loses
    // the directive entirely (the bug that replaced it — a BTS added after
    // the subtree had been pruned could never be written back). Report it so
    // the caller can CREATE the node and retry.
    if (anchor === -1) { missing.push(d.path); continue; }

    const at = outIdxOf[anchor];
    if (at < 0) continue;
    inserts.push({ at, text: ' '.repeat(anchorIndent ?? 0) + d.line });
  }

  // Apply descending so earlier insertions cannot shift later positions.
  inserts.sort((a, b) => b.at - a.at);
  for (const ins of inserts) out.splice(ins.at + 1, 0, ins.text);

  return { text: out.join('\n'), missing };
}

/**
 * Creates a whole missing subtree — the node headers AND the owned directives
 * that belong inside them — in one splice.
 *
 * It has to be one splice, not an empty header followed by a re-merge: a node
 * header is only recognisable as a header because the NEXT line is more
 * indented, so a lone header reads back as an ordinary directive, gets
 * created again on the next pass, and the directives never land inside it.
 *
 * Indentation follows the Osmocom convention these files use: one space per
 * level. The subtree is placed at the END of its deepest existing ancestor's
 * block — after everything already inside that parent and before the parent's
 * next sibling — which is where `bts 0` belongs relative to `network`'s own
 * directives and the following `msc 0`.
 */
function createMissingSubtree(text: string, path: string[], owned: PathDirective[]): string {
  const lines = text.split('\n');

  const pathOf: string[][] = [];
  const isHeader: boolean[] = [];
  const stack: Array<{ header: string; indent: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const ind = indentWidth(lines[i]);
    if (ind === null) { pathOf.push(stack.map(s => s.header)); isHeader.push(false); continue; }
    while (stack.length > 0 && ind <= stack[stack.length - 1].indent) stack.pop();
    pathOf.push(stack.map(s => s.header));
    let j = i + 1;
    while (j < lines.length && indentWidth(lines[j]) === null) j++;
    const nextInd = j < lines.length ? indentWidth(lines[j]) : null;
    const header = nextInd !== null && nextInd > ind;
    isHeader.push(header);
    if (header) stack.push({ header: lines[i].trim(), indent: ind });
  }

  const same = (a: string[], b: string[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]);
  const isPrefix = (pre: string[], full: string[]) =>
    full.length >= pre.length && pre.every((v, i) => v === full[i]);
  const nodeExists = (p: string[]) => {
    if (p.length === 0) return true;
    const parent = p.slice(0, -1);
    const own = p[p.length - 1];
    for (let i = 0; i < lines.length; i++) {
      if (indentWidth(lines[i]) === null || !isHeader[i]) continue;
      if (lines[i].trim() === own && same(parent, pathOf[i])) return true;
    }
    return false;
  };

  // Shallowest missing level of `path`.
  let depth = path.length;
  for (let d = 1; d <= path.length; d++) {
    if (!nodeExists(path.slice(0, d))) { depth = d; break; }
  }
  const root = path.slice(0, depth);          // the node to create
  const parent = path.slice(0, depth - 1);    // its existing ancestor

  // Everything owned that lives at or under `root`, grouped by full path.
  const groups = new Map<string, { path: string[]; dirs: string[] }>();
  for (const o of owned) {
    if (o.line === null || !isPrefix(root, o.path)) continue;
    const k = o.path.join('\u0000');
    const g = groups.get(k) ?? { path: o.path, dirs: [] };
    g.dirs.push(o.line);
    groups.set(k, g);
  }
  if (groups.size === 0) return text;   // nothing to write; do not loop

  // Emit shallowest-first so each header precedes its children.
  const ordered = [...groups.values()].sort(
    (a, b) => a.path.length - b.path.length || a.path.join('/').localeCompare(b.path.join('/')),
  );
  const emitted = new Set<string>();
  const block: string[] = [];
  for (const g of ordered) {
    // Write any header on this group's path that is not on the page yet.
    for (let d = depth; d <= g.path.length; d++) {
      const key = g.path.slice(0, d).join('\u0000');
      if (emitted.has(key)) continue;
      emitted.add(key);
      block.push(' '.repeat(d - 1) + g.path[d - 1]);
    }
    for (const line of g.dirs) block.push(' '.repeat(g.path.length) + line);
  }

  // End of the parent's block.
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    if (indentWidth(lines[i]) === null) continue;
    if (parent.length === 0 || isPrefix(parent, pathOf[i])) at = i;
  }
  if (at === -1 && parent.length > 0) return text;

  lines.splice(at + 1, 0, ...block);
  return lines.join('\n');
}

/**
 * Applies `owned` over `text`, creating any node the directives need but the
 * file does not have.
 *
 * Iterative because creating one node can reveal the next level down (a new
 * `bts 0` has to exist before its `trx 0` can be created). Bounded so a
 * pathological input cannot loop: each pass either creates a node or stops.
 */
export function upsertVtyPathDirectives(text: string, owned: PathDirective[]): string {
  // Nothing to merge into. Node creation deliberately does NOT kick in here:
  // the caller (writeOsmoBscCfg) writes its full template for an empty or
  // missing file, and that template carries lines the generator does not model
  // at all — the `log stderr` block, the handover1 tuning, the package's own
  // comments. Building a file out of owned directives alone would silently
  // produce a thinner config than a fresh install is supposed to get.
  if (text.trim() === '') return text;

  let current = text;
  for (let pass = 0; pass < 16; pass++) {
    const { text: merged, missing } = mergeOncePathDirectives(current, owned);
    current = merged;
    if (missing.length === 0) return current;
    // Shallowest first, so parents are created before their children.
    missing.sort((a, b) => a.length - b.length);
    const before = current;
    current = createMissingSubtree(current, missing[0], owned);
    if (current === before) return current;   // could not progress
  }
  return current;
}

/**
 * Remove a node and everything nested under it — used when a BTS is deleted, so
 * its whole `bts N` subtree goes rather than being left as an orphan header.
 */
export function removeVtyPathNode(text: string, path: string[]): string {
  const lines = text.split('\n');
  const header = path[path.length - 1];
  const parentDepth = path.length - 1;

  const stack: Array<{ header: string; indent: number }> = [];
  let start = -1;
  let startIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const ind = indentWidth(lines[i]);
    if (ind === null) continue;
    while (stack.length > 0 && ind <= stack[stack.length - 1].indent) stack.pop();
    const here = stack.map(s => s.header);
    if (lines[i].trim() === header && here.length === parentDepth &&
        here.every((v, k) => v === path[k])) {
      start = i; startIndent = ind; break;
    }
    let j = i + 1;
    while (j < lines.length && indentWidth(lines[j]) === null) j++;
    const nextInd = j < lines.length ? indentWidth(lines[j]) : null;
    if (nextInd !== null && nextInd > ind) stack.push({ header: lines[i].trim(), indent: ind });
  }
  if (start === -1) return text;

  let end = start + 1;
  while (end < lines.length) {
    const ind = indentWidth(lines[end]);
    if (ind !== null && ind <= startIndent) break;
    end++;
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

/**
 * Derive the owned-directive set from a generator's own output.
 *
 * Hand-maintaining the list of directives a generator controls guarantees drift:
 * add a line to the template, forget the list, and that line silently stops
 * being applied. So the generated text IS the list — whatever it emits is what
 * it owns, and nothing else in the operator's file is touched.
 *
 * Each generated directive becomes a PathDirective keyed on its leading tokens.
 * `keyTokens` says how many leading words identify a directive as opposed to
 * its value, defaulting to "all but the last word" — right for `cell_identity 2`
 * (key `cell_identity`) and for `amr-config 12_2k forbidden` (key
 * `amr-config 12_2k`, so the eight amr-config lines stay distinct). Pass an
 * override wherever that rule would key on a value and therefore fail to match
 * a file holding a different one — `meas-feed destination 127.0.0.1 8888` must
 * key on `meas-feed destination`, not on the address.
 */
export function ownedDirectivesFromGenerated(
  generated: string,
  keyTokens: Array<{ match: RegExp; tokens: number }> = [],
): PathDirective[] {
  const lines = generated.split('\n');
  const out: PathDirective[] = [];
  const stack: Array<{ header: string; indent: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const ind = indentWidth(lines[i]);
    if (ind === null) continue;
    while (stack.length > 0 && ind <= stack[stack.length - 1].indent) stack.pop();
    const trimmed = lines[i].trim();

    let j = i + 1;
    while (j < lines.length && indentWidth(lines[j]) === null) j++;
    const nextInd = j < lines.length ? indentWidth(lines[j]) : null;
    if (nextInd !== null && nextInd > ind) {
      // A node header, not a directive — it defines a path, it is not owned
      // content itself.
      stack.push({ header: trimmed, indent: ind });
      continue;
    }

    const words = trimmed.split(/\s+/);
    const override = keyTokens.find(k => k.match.test(trimmed));
    const n = override ? override.tokens : Math.max(1, words.length - 1);
    const key = words.slice(0, n).join(' ');
    out.push({
      path: stack.map(s => s.header),
      prefix: new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)'),
      line: trimmed,
    });
  }
  return out;
}

/**
 * Removal directives for lines the generator USED to emit and no longer does.
 *
 * `upsertVtyPathDirectives()` only ever replaces or adds what the generator
 * currently emits; a line it has stopped emitting survives untouched. For most
 * settings that is exactly right — it is how hand-maintained config is
 * preserved. For a directive FAMILY the generator owns completely, it is a
 * bug, because the leftovers can be invalid on their own.
 *
 * Real total outage, reproduced on a clean host 2026-11-08: turning GPRS off
 * for a BTS makes the generator drop the whole `gprs nsvc`/`nsei`/`cell bvci`
 * block and emit `gprs mode none`. The merge replaced the mode line and left
 * the rest, and osmo-bsc then refused the file outright:
 *
 *   Error occurred during reading the below line:
 *     gprs nsvc 0 remote ip 127.0.0.1
 *   % GPRS is not enabled on BTS 0
 *   Failed to parse the config file: '/etc/osmocom/osmo-bsc.cfg'
 *
 * taking all of 2G down — from a setting the UI presents as a simple toggle.
 *
 * `families` names the prefixes the generator owns end to end. Any line in
 * `target` matching one of them, at a path where the generated output has no
 * counterpart, is returned as a removal (`line: null`). Scoped per PATH, not
 * globally, so one BTS keeping GPRS does not protect another's leftovers.
 */
export function prunedDirectivesFor(
  target: string,
  generated: string,
  families: RegExp[],
): PathDirective[] {
  const walk = (text: string): Array<{ path: string[]; line: string }> => {
    const lines = text.split('\n');
    const out: Array<{ path: string[]; line: string }> = [];
    const stack: Array<{ header: string; indent: number }> = [];
    for (let i = 0; i < lines.length; i++) {
      const ind = indentWidth(lines[i]);
      if (ind === null) continue;
      while (stack.length > 0 && ind <= stack[stack.length - 1].indent) stack.pop();
      const trimmed = lines[i].trim();
      let j = i + 1;
      while (j < lines.length && indentWidth(lines[j]) === null) j++;
      const nextInd = j < lines.length ? indentWidth(lines[j]) : null;
      if (nextInd !== null && nextInd > ind) { stack.push({ header: trimmed, indent: ind }); continue; }
      out.push({ path: stack.map(s => s.header), line: trimmed });
    }
    return out;
  };

  const genKeys = new Set(
    walk(generated)
      .filter(e => families.some(f => f.test(e.line)))
      .map(e => `${e.path.join('\u0000')}\u0001${e.line}`),
  );

  const removals: PathDirective[] = [];
  for (const e of walk(target)) {
    if (!families.some(f => f.test(e.line))) continue;
    if (genKeys.has(`${e.path.join('\u0000')}\u0001${e.line}`)) continue;
    removals.push({
      path: e.path,
      prefix: new RegExp('^' + e.line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)'),
      line: null,
    });
  }
  return removals;
}
