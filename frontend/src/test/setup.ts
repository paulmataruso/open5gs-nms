// Runs before every test file (vitest.config.ts -> test.setupFiles).

// Registers jest-dom's matchers (toBeInTheDocument, toHaveAttribute, ...) on
// Vitest's own expect. The `/vitest` entry point is the one that does this for
// Vitest specifically — importing '@testing-library/jest-dom' instead
// registers against Jest's global expect, which does not exist here, and the
// matchers then silently do not appear.
import '@testing-library/jest-dom/vitest';

import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// `globals: false` means RTL's automatic cleanup does not install itself (it
// hooks the global afterEach, which is not defined under explicit-import
// mode). Without this, every rendered tree stays mounted in the same jsdom
// document for the rest of the file — so a document-level listener from one
// test still fires during the next, which is exactly what the useEscapeKey
// tests are measuring. Unmounting between tests is what keeps them honest.
afterEach(() => {
  cleanup();
});
