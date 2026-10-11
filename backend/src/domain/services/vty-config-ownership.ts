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
export function upsertVtyPathDirectives(text: string, owned: PathDirective[]): string {
  const lines = text.split('\n');

  // Resolve each line's node path once.
  const pathOf: string[][] = [];
  const stack: Array<{ header: string; indent: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const ind = indentWidth(lines[i]);
    if (ind === null) { pathOf.push(stack.map(s => s.header)); continue; }
    while (stack.length > 0 && ind <= stack[stack.length - 1].indent) stack.pop();
    pathOf.push(stack.map(s => s.header));
    // Is this a node header? Look ahead to the next non-blank line.
    let j = i + 1;
    while (j < lines.length && indentWidth(lines[j]) === null) j++;
    const nextInd = j < lines.length ? indentWidth(lines[j]) : null;
    if (nextInd !== null && nextInd > ind) stack.push({ header: lines[i].trim(), indent: ind });
  }

  const samePath = (a: string[], b: string[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]);

  const applied = new Set<PathDirective>();
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ind = indentWidth(lines[i]);
    if (ind === null) { out.push(lines[i]); continue; }
    const trimmed = lines[i].trim();
    const d = owned.find(o => !applied.has(o) && samePath(o.path, pathOf[i]) && o.prefix.test(trimmed));
    if (!d) { out.push(lines[i]); continue; }
    applied.add(d);
    if (d.line !== null) out.push(' '.repeat(ind) + d.line);
    // d.line === null -> drop the line entirely.
  }

  // Anything not found gets appended at the end of its node's block, so a
  // directive the generator models but the file lacks is still applied.
  for (const d of owned) {
    if (applied.has(d) || d.line === null) continue;
    const idxs: number[] = [];
    for (let i = 0; i < lines.length; i++) if (samePath(d.path, pathOf[i]) && indentWidth(lines[i]) !== null) idxs.push(i);
    if (idxs.length === 0) continue; // node absent — caller's fallback template covers a fresh file
    const lastOriginal = idxs[idxs.length - 1];
    const ind = indentWidth(lines[lastOriginal]) ?? 0;
    // Map the original index onto `out`, which may have shifted by removals.
    const marker = lines[lastOriginal];
    let at = out.lastIndexOf(marker);
    if (at === -1) at = out.length - 1;
    out.splice(at + 1, 0, ' '.repeat(ind) + d.line);
  }

  return out.join('\n');
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
