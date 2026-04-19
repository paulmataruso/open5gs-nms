import type { User, SafeUser } from '../entities/user';

// ─────────────────────────────────────────────────────────────
// Domain Interface: IAuthRepository
// ─────────────────────────────────────────────────────────────

export interface IAuthRepository {
  findUserByUsername(username: string): Promise<User | null>;
  findUserById(id: string): Promise<User | null>;
  createUser(id: string, username: string, passwordHash: string): Promise<User>;
  updateLastLogin(userId: string): Promise<void>;
  userCount(): Promise<number>;
}
