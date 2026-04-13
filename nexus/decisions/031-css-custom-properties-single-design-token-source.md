# ADR-031: CSS Custom Properties as the Single Design Token Source
## Context

The dashboard has ~22,000 lines of CSS across the design system and per-page stylesheets. Every page uses colors, spacing, typography, shadows, border radii, and z-index layers. Chart.js charts use the same palette. The connector app (separate project, same visual language) uses the same tokens.

Without discipline, shared visual language fragments fast -- one page uses `#2563EB` as the accent color, another uses `rgb(37, 99, 235)`, a third uses a slightly different blue because someone copy-pasted wrong. Chart colors drift from CSS colors. Dark mode is impossible because there's no single point of definition to override.

## Decision

**Every visual property is a CSS custom property in `:root`, defined in `tokens.css`, and read from there everywhere else.**

Categories:
- Neutral grays (`--gray-50` through `--gray-950`, 11 stops)
- Semantic surfaces (`--bg-page`, `--bg-card`, `--bg-elevated`, `--bg-hover`, `--bg-input`)
- Text hierarchy (`--text-primary`, `--text-secondary`, `--text-tertiary`, `--text-muted`, `--text-disabled`)
- Domain-specific (`--color-in-stock`, `--color-out-of-stock`, `--color-backordered`)
- Accent colors (`--color-accent`, `--color-accent-hover`, `--color-accent-muted`)
- Feedback (`--color-success`, `--color-warning`, `--color-error`, `--color-info`)
- Status badges (`--status-draft-*`, `--status-in-progress-*`, `--status-verifying-*`)
- Chart palette (`--chart-1` through `--chart-6`)
- Typography (`--font-sans` = Inter, `--font-mono` = JetBrains Mono; sizes `--text-xs` through `--text-display`)
- Spacing (`--space-0` through `--space-24`, 4px base unit)
- Borders (`--radius-sm` through `--radius-full`)
- Shadows (`--shadow-xs` through `--shadow-xl`)
- Animation durations + easing curves
- Z-index layers (`--z-base` through `--z-toast`)

**Chart.js reads the tokens too.** `chart-theme.js` calls `getComputedStyle(document.documentElement).getPropertyValue('--color-accent')` at initialization time and sets Chart.js global defaults from the token values. When a token changes, every chart on every page updates to match without touching any chart configuration.

The `prefers-reduced-motion` media query zeros out every animation duration token in one place:

```css
@media (prefers-reduced-motion) {
  :root {
    --duration-fast: 0ms;
    --duration-normal: 0ms;
    --duration-slow: 0ms;
  }
}
```

One change, every animation respects the user's motion preference.

## Alternatives Considered

- **Sass variables.** Compile-time values. Rejected because the dashboard has no build step (see ADR-028). Sass variables would force the adoption of a compiler.
- **CSS-in-JS.** Values in JavaScript, applied at runtime. Rejected because the runtime cost isn't worth paying for an internal dashboard, and it couples styling to JavaScript state in a way that makes CSS harder to debug.
- **Hardcoded values.** What the dashboard started with. Drift showed up within weeks. Replaced with tokens.
- **Tailwind-style utility classes.** Considered. Rejected because the design is bespoke enough that Tailwind's defaults would need extensive customization, and class-heavy HTML isn't the style suited to a codebase where readability matters.

## Consequences

**Good:**
- One change propagates everywhere. Adjusting the accent color is a one-line edit.
- Charts stay visually consistent with the rest of the UI automatically. No manual color coordination.
- The styleguide page (`design-system/styleguide.html`) renders the tokens as live swatches, typography samples, and component examples. Token names are inspectable directly.
- Reduced motion, high contrast, and theme switching become trivial -- override the tokens at `:root` level and everything follows.
- No build step required. Tokens are parsed by the browser natively.

**Bad / costs:**
- No dark mode is actually implemented. The architecture supports it (override `:root` in a `[data-theme="dark"]` selector) but the token values are all light-mode. Adding dark mode would require an additional ~150 token definitions.
- Backward compatibility aliases (`--gray-1` through `--gray-12` alongside the new numeric scale) exist because the gray scale was renamed mid-way through the design system and the old names were kept working for a transition period. Never cleaned up -- technical debt.
- Every CSS file reads tokens via `var(--token-name)`, which adds a layer of indirection when debugging "why is this color wrong." Mitigated by DevTools showing computed values.

## Related decisions

- [ADR-028: Vanilla JavaScript with ES modules over a framework](028-vanilla-js-es-modules-over-framework.md) -- same design principle: use the native platform feature when it's sufficient.
- [ADR-029: Custom Element `<cn-shell>`](029-custom-element-shell-for-consistent-chrome.md) -- the shell uses tokens directly; every page gets the right colors automatically.