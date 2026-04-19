import type { User, SafeUser } from '../entities/user';

// ─────────────────────────────────────────────────────────────
// Domain Interface: IAuthRepository
// ─────────────────────────────────────────────────────────────

export interface IAuthRepository {
  findUserByUsername(username: string): Promise<User | null>;
  findUserById(id: string): Promise<User | null>;
  createUser(id: string, username: string, passwordHash: string): Promise<User>;
  updateLastLogin(userId: string): Promise<void>;
  updatePassword(userId: string, passwordHash: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  listUsers(): Promise<User[]>;
  userCount(): Promise<number>;
}
