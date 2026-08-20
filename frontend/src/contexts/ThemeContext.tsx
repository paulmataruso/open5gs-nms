import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

// ─────────────────────────────────────────────────────────────
// Theme Context
// ─────────────────────────────────────────────────────────────
// Themes are pure CSS — each entry here just needs to match a
// `[data-theme="..."]` block defined in index.css (the actual --nms-*-rgb
// custom property values live there, not here). This file only owns which
// theme is currently selected and persisting that choice.

export interface ThemeOption {
  id: string;
  label: string;
  swatch: string; // representative accent hex, for the switcher UI only
}

export const THEME_OPTIONS: ThemeOption[] = [
  { id: 'cyan',    label: 'Cyan Slate',      swatch: '#06b6d4' },
  { id: 'violet',  label: 'Violet Midnight', swatch: '#8b5cf6' },
  { id: 'emerald', label: 'Emerald Terminal', swatch: '#10b981' },
  { id: 'amber',   label: 'Amber Dusk',      swatch: '#f59e0b' },
  { id: 'rose',    label: 'Rose Noir',       swatch: '#f43f5e' },
];

const DEFAULT_THEME = 'cyan';
const STORAGE_KEY = 'nms-theme';

function isValidTheme(id: string | null): id is string {
  return !!id && THEME_OPTIONS.some(t => t.id === id);
}

// index.html applies the stored theme synchronously (before React hydrates)
// to avoid a flash of the default theme — this just needs to read back
// whatever it already set so React's state agrees with the DOM.
function getInitialTheme(): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  return isValidTheme(stored) ? stored : DEFAULT_THEME;
}

interface ThemeContextValue {
  theme: string;
  setTheme: (id: string) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

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

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
