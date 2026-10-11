import * as fs from 'fs';
import * as path from 'path';
import { insertIntoOptionsBlock } from '../../../interfaces/rest/bind-controller';

// The three named.conf.options writers used to insert a missing directive with
// `raw.replace(/\}\s*;?\s*$/, ...)` — the LAST brace in the file. Correct only
// while options{} is the final block. Add a logging{} block (the commonest
// operator addition, and this project ships a Syslog module) and the directive
// lands in the wrong scope; BIND then refuses to load the file, which
// crash-loops every FQDN-migrated NF (CLAUDE.md pattern #6).

const REAL = fs.readFileSync(
  path.resolve(__dirname, '../../../config/__fixtures__/named.conf.options'), 'utf-8',
);

// Which TOP-LEVEL block encloses the needle. Nesting depth alone is not a
// usable check here: a directive wrongly placed inside `logging { ... }` sits at
// exactly the same depth (1) as one correctly inside `options { ... }`, so a
// depth assertion passes for both and proves nothing. This walks the preceding
// text, stripping comments and quoted strings, and returns the keyword of the
// outermost block still open at that point — or null at file scope.
function enclosingBlockOf(text: string, needle: string): string | null {
  const at = text.indexOf(needle);
  if (at === -1) return null;
  const before = text.slice(0, at).replace(/\/\/[^\n]*/g, '').replace(/"[^"]*"/g, '""');
  let depth = 0;
  let outermost: string | null = null;
  for (let i = 0; i < before.length; i++) {
    if (before[i] === '{') {
      if (depth === 0) {
        // The keyword introducing this block is the last word before the brace.
        outermost = before.slice(0, i).trim().split(/\s+/).pop() ?? null;
      }
      depth++;
    } else if (before[i] === '}') {
      depth--;
      if (depth === 0) outermost = null;
    }
  }
  return depth > 0 ? outermost : null;
}

describe('insertIntoOptionsBlock', () => {
  it('inserts inside options{} on the real host file', () => {
    const out = insertIntoOptionsBlock(REAL, 'recursion yes;')!;
    expect(out).not.toBeNull();
    expect(enclosingBlockOf(out, 'recursion yes;')).toBe('options');
    // Nothing else disturbed.
    expect(out).toContain('directory "/var/cache/bind";');
    expect(out).toContain('dnssec-validation auto;');
  });

  it('still targets options{} when another block FOLLOWS it — the actual bug', () => {
    const withLogging = REAL.trimEnd() + `

logging {
	channel syslog_out {
		syslog daemon;
		severity info;
	};
	category default { syslog_out; };
};
`;
    const out = insertIntoOptionsBlock(withLogging, 'forwarders { 1.1.1.1; };')!;
    expect(enclosingBlockOf(out, 'forwarders { 1.1.1.1; };')).toBe('options');
    // It must land BEFORE the logging block, not inside it.
    expect(out.indexOf('forwarders { 1.1.1.1; };')).toBeLessThan(out.indexOf('logging {'));
    expect(out).toContain('category default { syslog_out; };');
    // And the old end-of-file anchor would have put it after logging{} — prove
    // the regression is actually gone. Anchor on the inserted LINE, not the bare
    // word: the stock file's own comments mention "forwarders" near the top.
    const INSERTED = '\tforwarders { 1.1.1.1; };';
    const oldBehaviour = withLogging.replace(/\}\s*;?\s*$/, `${INSERTED}\n};\n`);
    expect(oldBehaviour.indexOf(INSERTED)).toBeGreaterThan(oldBehaviour.indexOf('logging {'));
    // ...and, the actual defect: it ended up scoped to logging{}, not options{}.
    expect(enclosingBlockOf(oldBehaviour, INSERTED)).toBe('logging');
  });

  it('handles a block preceding options{} too', () => {
    const withAcl = `acl trusted {\n\t10.0.0.0/8;\n};\n\n` + REAL;
    const out = insertIntoOptionsBlock(withAcl, 'recursion yes;')!;
    expect(enclosingBlockOf(out, 'recursion yes;')).toBe('options');
    expect(out.indexOf('recursion yes;')).toBeGreaterThan(out.indexOf('acl trusted {'));
    expect(out).toContain('\t10.0.0.0/8;');
  });

  it('is not fooled by a brace inside a comment or a quoted string', () => {
    const tricky = `options {
	// a commented brace } should not close this block
	directory "/var/cache/{bind}";
	dnssec-validation auto;
};

logging {
	category default { null; };
};
`;
    const out = insertIntoOptionsBlock(tricky, 'recursion yes;')!;
    expect(enclosingBlockOf(out, 'recursion yes;')).toBe('options');
    expect(out.indexOf('recursion yes;')).toBeLessThan(out.indexOf('logging {'));
  });

  it('counts nested braces so it picks the real closing brace', () => {
    const nested = `options {
	listen-on { 127.0.0.1; 10.0.1.180; };
	allow-query { any; };
};
`;
    const out = insertIntoOptionsBlock(nested, 'recursion yes;')!;
    expect(enclosingBlockOf(out, 'recursion yes;')).toBe('options');
    // Must come after the existing nested directives, inside the same block.
    expect(out.indexOf('recursion yes;')).toBeGreaterThan(out.indexOf('allow-query'));
  });

  it('returns null rather than guessing when there is no options block', () => {
    expect(insertIntoOptionsBlock('logging {\n\tcategory default { null; };\n};\n', 'recursion yes;')).toBeNull();
    expect(insertIntoOptionsBlock('', 'recursion yes;')).toBeNull();
  });

  it('returns null on unbalanced braces instead of producing garbage', () => {
    expect(insertIntoOptionsBlock('options {\n\tdirectory "/x";\n', 'recursion yes;')).toBeNull();
  });

  it('produces output BIND would parse — balanced braces, directive terminated', () => {
    const out = insertIntoOptionsBlock(REAL, 'recursion yes;')!;
    const stripped = out.replace(/\/\/[^\n]*/g, '').replace(/"[^"]*"/g, '""');
    const opens = (stripped.match(/\{/g) ?? []).length;
    const closes = (stripped.match(/\}/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(out).toMatch(/\trecursion yes;\n/);
  });
});
