// ─────────────────────────────────────────────────────────────
// Domain Entity: User & Session
// ─────────────────────────────────────────────────────────────

export type UserRole = 'admin' | 'viewer';

/**
 * A role string as the union, or null when it is neither.
 *
 * One definition, used at all three places that had their own. The SQLite
 * repository's was an assertion -- `row.role as 'admin'` -- which is a
 * narrowing LIE rather than a widening one: every user loaded from that
 * repository was typed as an admin, so `user.role === 'viewer'` reads to the
 * COMPILER as an impossible comparison anywhere a User comes from there.
 * Authorization itself was never broken, because requireAdmin compares the
 * real string at runtime and a viewer row stayed a viewer -- but a type that
 * says the opposite is how a correct check gets deleted as dead code.
 * UserManagementUseCase's two `role !== 'admin' && role !== 'viewer'` guards
 * were right, just written twice.
 *
 * Callers that need a fallback must choose 'viewer', never 'admin': that is
 * both the direction a privilege field has to fail in and what the runtime
 * already did.
 */
export function parseUserRole(role: string): UserRole | null {
  return role === 'admin' || role === 'viewer' ? role : null;
}

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: Date;
}

export interface SafeUser {
  id: string;
  username: string;
  role: UserRole;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export function toSafeUser(user: User): SafeUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}
