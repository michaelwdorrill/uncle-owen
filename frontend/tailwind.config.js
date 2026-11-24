/** @type {import('tailwindcss').Config} */

// Binary sunset — the v0.4 identity (docs/specs/0009-binary-sunset.md).
//
// Branch 1 put semantic tokens in front of every surface in the app so that
// this file would be the whole visual diff. This is that payoff: the values
// below moved, and nothing else had to.
//
// Dark and light semantic colors are defined in src/index.css.
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        ground: 'rgb(var(--uo-ground) / <alpha-value>)',
        surface: 'rgb(var(--uo-surface) / <alpha-value>)',
        raised: 'rgb(var(--uo-raised) / <alpha-value>)',
        'raised-hi': 'rgb(var(--uo-raised-hi) / <alpha-value>)',
        edge: 'rgb(var(--uo-edge) / <alpha-value>)',
        'edge-strong': 'rgb(var(--uo-edge-strong) / <alpha-value>)',
        ink: 'rgb(var(--uo-ink) / <alpha-value>)',
        'ink-soft': 'rgb(var(--uo-ink-soft) / <alpha-value>)',
        'ink-dim': 'rgb(var(--uo-ink-dim) / <alpha-value>)',
        muted: 'rgb(var(--uo-muted) / <alpha-value>)',
        faint: 'rgb(var(--uo-faint) / <alpha-value>)',
        fainter: 'rgb(var(--uo-fainter) / <alpha-value>)',
        accent: 'rgb(var(--uo-accent) / <alpha-value>)',
        'accent-hover': 'rgb(var(--uo-accent-hover) / <alpha-value>)',
        'accent-text': 'rgb(var(--uo-accent-text) / <alpha-value>)',
        'on-accent': 'rgb(var(--uo-on-accent) / <alpha-value>)',
        'accent-2': 'rgb(var(--uo-accent-2) / <alpha-value>)',
        dusk: 'rgb(var(--uo-dusk) / <alpha-value>)',
        moisture: 'rgb(var(--uo-moisture) / <alpha-value>)',
        danger: 'rgb(var(--uo-danger) / <alpha-value>)',
        'danger-hover': 'rgb(var(--uo-danger-hover) / <alpha-value>)',
        'danger-text': 'rgb(var(--uo-danger-text) / <alpha-value>)',
        'danger-surface': 'rgb(var(--uo-danger-surface) / <alpha-value>)',
        warning: 'rgb(var(--uo-warning) / <alpha-value>)',
        'warning-text': 'rgb(var(--uo-warning-text) / <alpha-value>)',
        'warning-surface': 'rgb(var(--uo-warning-surface) / <alpha-value>)',
        success: 'rgb(var(--uo-success) / <alpha-value>)',
        'success-text': 'rgb(var(--uo-success-text) / <alpha-value>)',
        'success-surface': 'rgb(var(--uo-success-surface) / <alpha-value>)',
      },

      fontFamily: {
        // Saira Condensed for display: condensed and slightly stencilled, it
        // reads as equipment labelling. Barlow for everything read at length --
        // humanist, industrial lineage, holds up small. No serif anywhere: a
        // serif would read artisanal, and this is used-future.
        display: ['"Saira Condensed"', '"Barlow Condensed"', 'ui-sans-serif', 'sans-serif'],
        sans: ['Barlow', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },

      boxShadow: {
        // The signature. Two suns means two shadows: a hard warm one from
        // Tatoo I and a soft violet one from Tatoo II, at different angles.
        // Two values, applied once, and nothing else looks like it.
        lift: '3px 4px 0 -2px rgba(232, 145, 58, .16), -2px 3px 12px -3px rgba(0, 0, 0, .55)',
        'lift-lg':
          '6px 8px 0 -3px rgba(232, 145, 58, .13), -4px 8px 30px -8px rgba(0, 0, 0, .70)',
      },
    },
  },
  plugins: [],
};
