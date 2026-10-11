import * as fs from 'fs';
import * as path from 'path';

// Reported 2026-10-11: during a Fix All the terminal box stayed empty for the
// whole run and only filled in once it finished, which reads as "stuck" — the
// Kamailio rebuild alone is ~9 minutes of silence.
//
// Cause: runFixAll did `const result = await this.fixModule(...)` and only THEN
// `results.push(result)`. Each module's log array lived inside fixModule until
// it returned, so GET /fix-all/status had nothing to report for whatever was
// currently running. The fix publishes the result object first, so write()
// appends to the same array the status endpoint serialises.
//
// Asserted structurally: exercising it for real would mean running an actual
// multi-minute install.

const SRC = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');
const FIXALL = 'application/use-cases/module-fixall-usecase.ts';

describe('Fix All streams its log while running', () => {
  // Comments are stripped before asserting on code shape: these functions carry
  // long explanatory comments that quote the very patterns being asserted
  // against (e.g. "this used to be `const result = await this.fixModule(...)`"),
  // which a naive match happily finds in the prose.
  const stripComments = (t: string) =>
    t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const src = stripComments(read(FIXALL));
  const loop = src.slice(src.indexOf('private async runFixAll'), src.indexOf('private async fixModule'));

  it('publishes each module result BEFORE running the module', () => {
    const pushAt = loop.indexOf('this.runState.results.push(result);');
    const runAt = loop.indexOf('await this.fixModule(');
    expect(pushAt).toBeGreaterThan(-1);
    expect(runAt).toBeGreaterThan(-1);
    expect(pushAt).toBeLessThan(runAt);
  });

  it('no longer assigns the result from fixModule, which is what delayed it', () => {
    expect(loop).not.toMatch(/const result = await this\.fixModule\(/);
  });

  it('fixModule writes into the caller-owned, already-published log array', () => {
    const fn = src.slice(src.indexOf('private async fixModule'), src.indexOf("case 'ims': {"));
    // Must take the result in, not create its own.
    expect(fn).toMatch(/result: FixAllModuleResult,/);
    expect(fn).toMatch(/const write = \(s: string\) => \{ result\.log\.push\(s\); \};/);
    // A fresh local log array here would detach it again.
    expect(fn).not.toMatch(/const log: string\[\] = \[\];/);
  });

  it('an error still lands on the published result rather than a detached copy', () => {
    // The old .catch() built a brand-new object that was never the one being
    // streamed, so a thrown error lost whatever log had accumulated.
    expect(loop).toMatch(/\.catch\(\(err\) => \{\s*result\.error = String\(err\);/);
  });

  it('the status endpoint exposes results (and therefore the live logs)', () => {
    const ctl = read('interfaces/rest/modules-controller.ts');
    expect(ctl).toMatch(/router\.get\('\/fix-all\/status'/);
  });

  it('the modal marks the in-progress module and names what is running', () => {
    const modal = fs.readFileSync(
      path.resolve(SRC, '../../frontend/src/components/common/StaleModulesModal.tsx'), 'utf-8');
    expect(modal).toMatch(/\(running…\)/);
    expect(modal).toMatch(/runningLabel/);
    // And it must still poll, or nothing updates regardless.
    expect(modal).toMatch(/setInterval\(/);
  });
});
