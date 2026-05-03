import { generateIdFromEntropySize } from 'lucia';
import { Bcrypt } from 'oslo/password';
import type { Logger } from 'pino';
import type { IAuthRepository } from '../../domain/interfaces/auth-repository';
import type { AppLucia } from '../../infrastructure/auth/sqlite-auth-repository';
import { toSafeUser, type SafeUser } from '../../domain/entities/user';

// ─────────────────────────────────────────────────────────────
// Custom errors
// ─────────────────────────────────────────────────────────────

export class UserNotFoundError extends Error {
  constructor() { super('User not found'); this.name = 'UserNotFoundError'; }
}

export class DuplicateUsernameError extends Error {
  constructor() { super('Username already exists'); this.name = 'DuplicateUsernameError'; }
}

export class CannotDeleteSelfError extends Error {
  constructor() { super('You cannot delete your own account'); this.name = 'CannotDeleteSelfError'; }
}

export class CannotDeleteLastUserError extends Error {
  constructor() { super('Cannot delete the last user account'); this.name = 'CannotDeleteLastUserError'; }
}

export class WeakPasswordError extends Error {
  constructor() { super('Password must be at least 8 characters'); this.name = 'WeakPasswordError'; }
}

export class InvalidRoleError extends Error {
  constructor() { super('Role must be admin or viewer'); this.name = 'InvalidRoleError'; }
}

// ─────────────────────────────────────────────────────────────
// Use Case: User Management
// ─────────────────────────────────────────────────────────────

export class UserManagementUseCase {
  private bcrypt = new Bcrypt();

  constructor(
    private authRepo: IAuthRepository,
    private lucia: AppLucia,
    private logger: Logger,
  ) {}

  async listUsers(): Promise<SafeUser[]> {
    const users = await this.authRepo.listUsers();
    return users.map(toSafeUser);
  }

  async createUser(username: string, password: string, role: 'admin' | 'viewer' = 'admin'): Promise<SafeUser> {
    const normalised = username.trim().toLowerCase();

    if (!normalised || normalised.length < 2) {
      throw new Error('Username must be at least 2 characters');
    }
    if (!/^[a-z0-9_.-]+$/.test(normalised)) {
      throw new Error('Username may only contain letters, numbers, _ . -');
    }
    if (password.length < 8) {
      throw new WeakPasswordError();
    }
    if (role !== 'admin' && role !== 'viewer') {
      throw new InvalidRoleError();
    }

    const existing = await this.authRepo.findUserByUsername(normalised);
    if (existing) throw new DuplicateUsernameError();

    const passwordHash = await this.bcrypt.hash(password);
    const id = generateIdFromEntropySize(10);
    const user = await this.authRepo.createUser(id, normalised, passwordHash, role);

    this.logger.info({ userId: id, username: normalised, role }, 'UserMgmt: user created');
    return toSafeUser(user);
  }

  async updateRole(targetUserId: string, requestingUserId: string, role: 'admin' | 'viewer'): Promise<void> {
    if (role !== 'admin' && role !== 'viewer') throw new InvalidRoleError();

    const user = await this.authRepo.findUserById(targetUserId);
    if (!user) throw new UserNotFoundError();

    // Prevent demoting yourself — could lock you out
    if (targetUserId === requestingUserId && role === 'viewer') {
      throw new Error('You cannot demote your own account to viewer');
    }

    await this.authRepo.updateRole(targetUserId, role);
    this.logger.info({ targetUserId, role, requestingUserId }, 'UserMgmt: role updated');
  }

  async changePassword(
    targetUserId: string,
    newPassword: string,
  ): Promise<void> {
    if (newPassword.length < 8) throw new WeakPasswordError();

    const user = await this.authRepo.findUserById(targetUserId);
    if (!user) throw new UserNotFoundError();

    const passwordHash = await this.bcrypt.hash(newPassword);
    await this.authRepo.updatePassword(targetUserId, passwordHash);

    // Invalidate all existing sessions so any other logged-in devices are forced to re-login
    await this.lucia.invalidateUserSessions(targetUserId);

    this.logger.info({ userId: targetUserId }, 'UserMgmt: password changed, sessions invalidated');
  }

  async deleteUser(targetUserId: string, requestingUserId: string): Promise<void> {
    if (targetUserId === requestingUserId) throw new CannotDeleteSelfError();

    const count = await this.authRepo.userCount();
    if (count <= 1) throw new CannotDeleteLastUserError();

    const user = await this.authRepo.findUserById(targetUserId);
    if (!user) throw new UserNotFoundError();

    // Invalidate sessions first, then delete (cascade also handles it but belt-and-suspenders)
    await this.lucia.invalidateUserSessions(targetUserId);
    await this.authRepo.deleteUser(targetUserId);

    this.logger.info(
      { targetUserId, deletedUsername: user.username, requestingUserId },
      'UserMgmt: user deleted',
    );
  }
}
