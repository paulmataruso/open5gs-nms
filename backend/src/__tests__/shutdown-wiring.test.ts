import * as fs from 'fs';
import * as path from 'path';

/**
 * A source-text test, the same shape as sip-trace-wiring.test.ts and
 * sasbench-context-wiring.test.ts, because index.ts's `main()` is a
 * thousand-line bootstrap that cannot be imported in a test: it connects to
 * Mongo, opens SQLite, binds a port and starts a dozen pollers.
 *
 * What it pins is a defect with no runtime symptom you would notice. `shutdown`
 * awaits four disconnects; a rejection from any one of them skipped
 * `process.exit(0)` entirely and surfaced as an unhandled rejection, so the
 * container ignored SIGTERM and sat there until Docker's stop timeout escalated
 * to SIGKILL. That is a ~10s pause on `docker compose up -d` of a running
 * stack, not a crash, so it reads as Docker being slow rather than as a bug —
 * which is exactly why it survived, and why it needs a test rather than care.
 */

const RAW = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');

/**
 * Comments are stripped before anything is matched. Caught the first time
 * this ran: the comment explaining the try/finally itself contains the text
 * `process.exit(0)`, so a test counting that call found two and failed on
 * correct code. A source-text test that reads prose is measuring the prose.
 */
const INDEX = RAW.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

function shutdownBody(): string {
  const start = INDEX.indexOf('const shutdown = async ()');
  expect(start).toBeGreaterThan(-1);
  const end = INDEX.indexOf("process.on('SIGTERM'", start);
  expect(end).toBeGreaterThan(start);
  return INDEX.slice(start, end);
}

describe('graceful shutdown', () => {
  it('exits from a finally, so a rejected disconnect cannot skip it', () => {
    const body = shutdownBody();
    expect(body).toMatch(/\} finally \{\s*process\.exit\(0\);\s*\}/);
    // And exactly once: an exit outside the finally would make the finally
    // decorative on the happy path and hide a regression.
    expect(body.match(/process\.exit\(/g)).toHaveLength(1);
  });

  it('awaits the disconnects inside the guarded block, not after it', () => {
    const body = shutdownBody();
    const tryAt = body.indexOf('try {');
    const catchAt = body.indexOf('} catch');
    expect(tryAt).toBeGreaterThan(-1);
    for (const awaited of [
      'await imsTestNumberManager.stopAll()',
      'await subscriberRepo.disconnect()',
      'await rfPlanningProjectRepo.disconnect()',
      'await apnProfileRepo.disconnect()',
    ]) {
      const at = body.indexOf(awaited);
      expect(at).toBeGreaterThan(tryAt);
      expect(at).toBeLessThan(catchAt);
    }
  });

  it('registers both signals through a void-returning listener', () => {
    // process.on wants a void-returning listener. Passing the async function
    // directly is what no-misused-promises flags, and it is the same floating
    // -rejection shape as the body above.
    for (const sig of ['SIGTERM', 'SIGINT']) {
      expect(INDEX).toContain(`process.on('${sig}', () => void shutdown());`);
    }
  });

  it('main() still has a rejection handler of its own', () => {
    // The outer net. If main() itself rejects before any of the above is
    // wired, this is the only thing that logs why.
    expect(INDEX).toMatch(/main\(\)\.catch\(/);
  });
});
