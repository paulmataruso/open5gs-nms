/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        'nms-bg': '#0a0e1a',
        'nms-surface': '#111827',
        'nms-surface-2': '#1a2236',
        'nms-border': '#1e293b',
        'nms-accent': '#06b6d4',
        'nms-accent-dim': '#0891b2',
        'nms-green': '#10b981',
        'nms-red': '#ef4444',
        'nms-amber': '#f59e0b',
        'nms-text': '#e2e8f0',
        'nms-text-dim': '#94a3b8',
      },
      fontFamily: {
        sans: ['JetBrains Mono', 'SF Mono', 'Fira Code', 'monospace'],
        display: ['Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        'pulse-slow': 'pulse 3s ease-in-out infinite',
        'fade-in': 'fadeIn 0.3s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
