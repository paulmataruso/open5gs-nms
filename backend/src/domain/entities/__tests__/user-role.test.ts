import { parseUserRole } from '../user';

/**
 * `rowToUser` used to do `row.role as 'admin'`.
 *
 * That is a narrowing LIE rather than a widening one: every user loaded from
 * this repository was typed as an admin, so `user.role === 'viewer'` reads to
 * the compiler as an impossible comparison anywhere a User comes from here.
 * Authorization was never broken — requireAdmin compares the real string at
 * runtime, so a viewer row stayed a viewer — but the type said otherwise,
 * which is the sort of thing that gets a correct check deleted as dead code.
 */

describe('parseUserRole', () => {
  it('accepts the two real roles', () => {
    expect(parseUserRole('admin')).toBe('admin');
    expect(parseUserRole('viewer')).toBe('viewer');
  });

  it('rejects anything else, so the caller must choose a default', () => {
    // Callers map null to 'viewer', never 'admin' — the direction a privilege
    // field has to fail in, and the same answer the runtime already gave
    // (requireAdmin's `!== 'admin'` denies anything unrecognised).
    for (const role of ['Admin', 'ADMIN', 'administrator', 'admin ', '', 'root', 'superuser']) {
      expect(parseUserRole(role)).toBeNull();
    }
  });

  it('is case-sensitive — "Admin" must not become admin', () => {
    expect(parseUserRole('Admin')).toBeNull();
  });
});
