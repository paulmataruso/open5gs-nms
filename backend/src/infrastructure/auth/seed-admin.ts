import { generateIdFromEntropySize } from 'lucia';
import { Bcrypt } from 'oslo/password';
import type { Logger } from 'pino';
import type { IAuthRepository } from '../../domain/interfaces/auth-repository';

// ─────────────────────────────────────────────────────────────
// First-run seed: creates admin user if no users exist
// ─────────────────────────────────────────────────────────────

function generateRandomPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
  let password = '';
  const array = new Uint8Array(16);
  // Use Node crypto for random bytes
  const { randomFillSync } = require('crypto');
  randomFillSync(array);
  for (const byte of array) {
    password += chars[byte % chars.length];
  }
  return password;
}

export async function seedAdminUser(
  authRepo: IAuthRepository,
  firstRunPassword: string | null,
  logger: Logger,
): Promise<void> {
  const count = await authRepo.userCount();
  if (count > 0) {
    logger.debug('Auth: users exist, skipping seed');
    return;
  }

  const password = firstRunPassword || generateRandomPassword();
  const bcrypt = new Bcrypt();
  const passwordHash = await bcrypt.hash(password);
  const id = generateIdFromEntropySize(10);

  await authRepo.createUser(id, 'admin', passwordHash);

  if (firstRunPassword) {
    logger.info('Auth: admin user created from FIRST_RUN_PASSWORD env var');
  } else {
    // Print clearly to logs — user must grab this on first deploy
    logger.warn('════════════════════════════════════════════════════');
    logger.warn('  FIRST RUN — Admin account created');
    logger.warn(`  Username : admin`);
    logger.warn(`  Password : ${password}`);
    logger.warn('  Change this password after first login!');
    logger.warn('════════════════════════════════════════════════════');
  }
}
