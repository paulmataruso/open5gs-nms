import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(path.resolve(__dirname, '../mms-controller.ts'), 'utf-8');

/**
 * Real failure, 2026-11-08, on a fresh deployment: the MM1 MSISDN proxy's Go
 * build inherited this module's default 20s nsenter timeout. A cold Go build
 * cache does not fit in 20s, execFile killed it, and a killed process writes
 * no stderr — so the error read as "Command failed: ... go build ..." with
 * nothing after it, which looks exactly like a compile error. It then passed
 * on retry because the cache was warm, which is the worst kind of bug: it
 * only fails on a first install.
 */
describe('MM1 proxy build timeout', () => {
  it('passes an explicit timeout to the build, not the helper default', () => {
    expect(src).toMatch(/go build -o \$\{MM1_PROXY_BIN\} \$\{MM1_PROXY_SRC\}`,\s*\n\s*\],\s*MM1_PROXY_BUILD_TIMEOUT_MS\)/);
  });

  it('budgets minutes, because this is a real compiler invocation', () => {
    const m = /const MM1_PROXY_BUILD_TIMEOUT_MS = ([^;]+);/.exec(src);
    expect(m).not.toBeNull();
    // eslint-disable-next-line no-eval
    const ms = eval(m![1]) as number;
    expect(ms).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });

  it('the helper default is NOT a compile budget', () => {
    // Pinning this so the relationship stays visible: if the default ever
    // grows to cover a build, that is a sign the default is being misused.
    const d = /const nsenter = async \([^)]*timeoutMs = (\d+)/.exec(src);
    expect(d).not.toBeNull();
    expect(Number(d![1])).toBeLessThan(60_000);
  });

  it('distinguishes a killed build from a compile error in the message', () => {
    // An empty reason presented as-is reads as "the compiler rejected this",
    // which sent me looking for a missing source file that was present.
    expect(src).toContain("'(no output)'");
    expect(src).toMatch(/almost certainly killed rather than a code error/);
  });
});
