/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Background colors
        'bg-canvas': 'var(--bg-canvas)',
        'bg-surface': 'var(--bg-surface)',
        'bg-elevated': 'var(--bg-elevated)',
        'bg-hover': 'var(--bg-hover)',
        'bg-active': 'var(--bg-active)',

        // Brand colors
        'sync': 'var(--sync)',
        'sync-muted': 'var(--sync-muted)',
        'sync-subtle': 'var(--sync-subtle)',

        // Text colors
        'text-primary': 'var(--text-primary)',
        'text-secondary': 'var(--text-secondary)',
        'text-tertiary': 'var(--text-tertiary)',
        'text-inverse': 'var(--text-inverse)',
      },
      maxWidth: {
        content: 'var(--content-max-width)',
      },
      fontFamily: {
        display: ['var(--font-display)', 'sans-serif'],
      },
      spacing: {
        'sidebar': 'var(--sidebar-width)',
        'sync-pulse': 'var(--sync-pulse-height)',
      },
    },
  },
  plugins: [],
}
