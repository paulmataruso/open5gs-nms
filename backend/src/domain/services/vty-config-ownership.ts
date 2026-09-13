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
