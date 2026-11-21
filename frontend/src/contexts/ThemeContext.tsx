import { useState, useCallback, type ReactNode } from 'react';
import { ThemeContext, getInitialTheme, isValidTheme, STORAGE_KEY } from './theme-context';

// ─────────────────────────────────────────────────────────────
// Theme Provider
// ─────────────────────────────────────────────────────────────
// Only the provider belongs in this file — see ./theme-context for why, and
// for the theme vocabulary itself.

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [theme, setThemeState] = useState<string>(getInitialTheme);

  const setTheme = useCallback((id: string) => {
    if (!isValidTheme(id)) return;
    setThemeState(id);
    localStorage.setItem(STORAGE_KEY, id);
    document.documentElement.setAttribute('data-theme', id);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
