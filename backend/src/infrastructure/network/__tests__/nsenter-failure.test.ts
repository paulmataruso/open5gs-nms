import { nsenterFailure } from '../dummy-interface';

/**
 * `nsenterFailure()` replaces the `catch (err: any)` + `err?.code` pattern at
 * the three call sites in secondary-address.ts. The distinction it carries is
 * load-bearing for Auto-Configuration's duplicate-address detection:
 *
 *   - a MISSING binary contributes no signal (the address stays judged by the
 *     other probe), and
 *   - a binary that RAN and exited non-zero has a real verdict in its stdout —
 *     `arping -D` inverts its exit code, so success looks like failure.
 *
 * Conflating the two would make every candidate address look occupied and halt
 * a whole run, which is why these are tested rather than assumed.
 */

/** What promisify(execFile) really rejects with: an Error carrying extras. */
function execFailure(over: Record<string, unknown>): Error {
  return Object.assign(new Error('Command failed: arping -D'), over);
}

describe('nsenterFailure', () => {
  it('reads a missing binary as ENOENT', () => {
    expect(nsenterFailure(execFailure({ code: 'ENOENT' })).code).toBe('ENOENT');
  });

  it('reads a numeric exit status', () => {
    // arping exits 1 when the address IS a duplicate — the normal, expected
    // case this must not treat as "could not look".
    expect(nsenterFailure(execFailure({ code: 1 })).code).toBe(1);
    expect(nsenterFailure(execFailure({ code: 0 })).code).toBe(0);
  });

  it('reports the captured stdout, which is where arping\'s verdict lives', () => {
    const f = nsenterFailure(execFailure({
      code: 1,
      stdout: 'Unicast reply from 172.16.0.100 [00:02:99:1c:30:f4]  0.700ms\n',
      stderr: '',
    }));
    expect(f.stdout).toContain('Unicast reply from 172.16.0.100');
    expect(f.stderr).toBe('');
  });

  it('reports stdout and stderr as empty strings when absent, never "undefined"', () => {
    // The old `String(err?.stdout ?? '')` got this right; the netplan path's
    // `String(err?.stderr || err?.stdout || err?.message || err)` would have
    // produced the literal text "undefined" for a non-Error throw.
    const f = nsenterFailure(execFailure({ code: 1 }));
    expect(f.stdout).toBe('');
    expect(f.stderr).toBe('');
  });

  it('decodes a Buffer stream, the one other thing execFile can give', () => {
    const f = nsenterFailure(execFailure({ stdout: Buffer.from('Received 0 reply\n', 'utf-8') }));
    expect(f.stdout).toBe('Received 0 reply\n');
  });

  it('reports a non-string, non-Buffer stream as absent rather than "[object Object]"', () => {
    // Narrow, don't coerce: this text is joined into an operator-facing
    // netplan warning.
    for (const stdout of [{}, [], 42, null, undefined, true]) {
      expect(nsenterFailure(execFailure({ stdout })).stdout).toBe('');
    }
  });

  it('reports a non-string, non-number code as absent', () => {
    for (const code of [{}, [], null, undefined, true]) {
      expect(nsenterFailure(execFailure({ code })).code).toBeUndefined();
    }
  });

  it('carries the Error\'s own message', () => {
    expect(nsenterFailure(execFailure({})).message).toBe('Command failed: arping -D');
  });

  it('survives a throw that is not an Error at all', () => {
    // A rejected string or null must not take down the probe that is reading
    // it — `err?.code` on a string is undefined, and this has to match.
    expect(nsenterFailure('boom')).toEqual({ code: undefined, stdout: '', stderr: '', message: 'boom' });
    expect(nsenterFailure(null)).toEqual({ code: undefined, stdout: '', stderr: '', message: 'null' });
    expect(nsenterFailure(undefined).message).toBe('undefined');
    expect(nsenterFailure(42).message).toBe('42');
  });

  it('reads a plain object carrying the same fields', () => {
    // Not every rejection in this codebase is a real Error instance.
    const f = nsenterFailure({ code: 'ENOENT', stdout: 'x', stderr: 'y' });
    expect(f.code).toBe('ENOENT');
    expect(f.stdout).toBe('x');
    expect(f.stderr).toBe('y');
  });
});
