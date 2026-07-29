// kamcmd's own text output (from e.g. `kamcmd ulscscf.status`, `dlg2.list`)
// looks JSON-ish but isn't valid JSON — unquoted keys, no commas, braces
// used purely for nesting. This is a small, generic parser for that one
// consistent shape (`Key: Value` leaves, `Key: { ... }` nested objects),
// used instead of hand-writing a bespoke regex per kamcmd command. Verified
// live 2026-07-29 against `ulscscf.status` and `dlg2.list` output on this
// project's own S-CSCF.
export function parseKamcmdOutput(text: string): Record<string, unknown> {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  let i = 0;

  function parseObject(): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    while (i < lines.length) {
      const line = lines[i];
      if (line === '}' || line === '{}') { i++; break; }
      if (line === '{') { i++; continue; }
      const m = line.match(/^([^:]+):\s*(.*)$/);
      if (!m) { i++; continue; }
      const key = m[1].trim();
      const rest = m[2].trim();
      if (rest === '{' || rest === '') {
        i++;
        obj[key] = parseObject();
      } else if (rest === '{}') {
        i++;
        obj[key] = {};
      } else {
        obj[key] = rest;
        i++;
      }
    }
    return obj;
  }

  return parseObject();
}
