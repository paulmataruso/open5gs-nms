// ─────────────────────────────────────────────────────────────
// Domain Entity: User & Session
// ─────────────────────────────────────────────────────────────

export type UserRole = 'admin';

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
  lastLoginAt: Date | null;
}

export function toSafeUser(user: User): SafeUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    lastLoginAt: user.lastLoginAt,
  };
}
