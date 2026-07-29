import * as fs from 'fs';
import * as path from 'path';

// Reads this backend process's own package.json ("/app/package.json" in the
// built image — two levels up from dist/infrastructure/system/). Used by
// modules that persist "configured with version X" into their own state file
// at Configure time (see ims-controller.ts, pstn-controller.ts), so the UI
// can tell an operator their live deployment predates a template fix and
// prompt them to re-run Configure, instead of either silently leaving a
// stale config in place or auto-restarting live Kamailio/Asterisk services
// on every backend upgrade without the operator's awareness.
let cachedVersion: string | null = null;

export function getAppVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  let version: string;
  try {
    const pkgPath = path.join(__dirname, '..', '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    version = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    version = 'unknown';
  }
  cachedVersion = version;
  return version;
}
