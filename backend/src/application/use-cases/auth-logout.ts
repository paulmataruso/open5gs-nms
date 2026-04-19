import type { Logger } from 'pino';
import type { AppLucia } from '../../infrastructure/auth/sqlite-auth-repository';

// ─────────────────────────────────────────────────────────────
// Use Case: Logout
// ─────────────────────────────────────────────────────────────

export class AuthLogoutUseCase {
  constructor(
    private lucia: AppLucia,
    private logger: Logger,
  ) {}

  async execute(sessionId: string): Promise<string> {
    await this.lucia.invalidateSession(sessionId);
    const blankCookie = this.lucia.createBlankSessionCookie().serialize();
    this.logger.info({ sessionId }, 'Auth: session invalidated');
    return blankCookie;
  }
}
