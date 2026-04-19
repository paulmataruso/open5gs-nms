import { Bcrypt } from 'oslo/password';
import type { Logger } from 'pino';
import type { IAuthRepository } from '../../domain/interfaces/auth-repository';
import type { AppLucia } from '../../infrastructure/auth/sqlite-auth-repository';
import type { SafeUser } from '../../domain/entities/user';
import { toSafeUser } from '../../domain/entities/user';

// ─────────────────────────────────────────────────────────────
// Use Case: Login
// ─────────────────────────────────────────────────────────────

export class InvalidCredentialsError extends Error {
  constructor() {
    // Deliberately vague — never reveal which field was wrong
    super('Invalid username or password');
    this.name = 'InvalidCredentialsError';
  }
}

export interface LoginResult {
  sessionCookie: string;
  user: SafeUser;
}

export class AuthLoginUseCase {
  private bcrypt = new Bcrypt();

  constructor(
    private authRepo: IAuthRepository,
    private lucia: AppLucia,
    private logger: Logger,
  ) {}

  async execute(username: string, password: string): Promise<LoginResult> {
    // Normalise username
    const normalised = username.trim().toLowerCase();

    const user = await this.authRepo.findUserByUsername(normalised);

    // Always run bcrypt verify even on missing user to prevent timing attacks
    const dummyHash =
      '$2y$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012';
    const hash = user?.passwordHash ?? dummyHash;

    const valid = await this.bcrypt.verify(hash, password).catch(() => false);

    if (!user || !valid) {
      this.logger.warn({ username: normalised }, 'Auth: failed login attempt');
      throw new InvalidCredentialsError();
    }

    // Create session via Lucia
    const session = await this.lucia.createSession(user.id, {});
    const sessionCookie = this.lucia.createSessionCookie(session.id).serialize();

    // Update last login timestamp (fire and forget)
    this.authRepo.updateLastLogin(user.id).catch((err) => {
      this.logger.warn({ err }, 'Auth: failed to update last login');
    });

    this.logger.info({ userId: user.id, username: normalised }, 'Auth: login successful');

    return {
      sessionCookie,
      user: toSafeUser(user),
    };
  }
}
