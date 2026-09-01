/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Themeable tokens — sourced from CSS custom properties set per-theme in
        // index.css (see [data-theme="..."] blocks), swapped at runtime by
        // ThemeContext. The rgb(var(...) / <alpha-value>) form (not a plain var())
        // is required so existing `bg-nms-accent/20`-style opacity modifiers
        // throughout the app keep working — Tailwind only knows how to apply an
        // alpha channel to a color when it's expressed this way.
        'nms-bg': 'rgb(var(--nms-bg-rgb) / <alpha-value>)',
        'nms-surface': 'rgb(var(--nms-surface-rgb) / <alpha-value>)',
        'nms-surface-2': 'rgb(var(--nms-surface-2-rgb) / <alpha-value>)',
        'nms-border': 'rgb(var(--nms-border-rgb) / <alpha-value>)',
        'nms-accent': 'rgb(var(--nms-accent-rgb) / <alpha-value>)',
        'nms-accent-dim': 'rgb(var(--nms-accent-dim-rgb) / <alpha-value>)',
        'nms-green': 'rgb(var(--nms-green-rgb) / <alpha-value>)',
        'nms-red': 'rgb(var(--nms-red-rgb) / <alpha-value>)',
        'nms-amber': 'rgb(var(--nms-amber-rgb) / <alpha-value>)',
        'nms-text': 'rgb(var(--nms-text-rgb) / <alpha-value>)',
        'nms-text-dim': 'rgb(var(--nms-text-dim-rgb) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['JetBrains Mono', 'SF Mono', 'Fira Code', 'monospace'],
        display: ['Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        'pulse-slow': 'pulse 3s ease-in-out infinite',
        'fade-in': 'fadeIn 0.3s ease-out',
        'flash-red': 'flashRed 1.2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        // Uses the nms-red CSS var directly (not the Tailwind color token, which
        // only resolves the <alpha-value> placeholder inside class names) so this
        // still tracks the light/dark theme swap in index.css.
        flashRed: {
          '0%, 100%': { backgroundColor: 'rgb(var(--nms-red-rgb) / 0.06)' },
          '50%': { backgroundColor: 'rgb(var(--nms-red-rgb) / 0.28)' },
        },
      },
    },
  },
  plugins: [],
};
