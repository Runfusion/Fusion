---
"@runfusion/fusion": minor
---

summary: Add an Interface style choice (Current or Clean) that is independent of your colour theme.
category: feature
dev: |
  Adds the global `uiStyle` setting (`"classic" | "clean"`, default `"classic"`), published as
  `html[data-ui-style]` by the pre-hydration bootstrap in `app/index.html`, `getThemeInitScript()` and the
  Electron renderer shell, and cached under `kb-dashboard-ui-style`. Non-chromatic design tokens now live in
  the new `app/ui-style-tokens.css` catalogue (`--ui-*`), and the same shared `UiStyleSelector` is rendered by
  Settings → Appearance and the Command Center theme card.

  REMOVALS. The Alpha presentation perimeter is deleted: `app/context/AlphaContext.tsx` (`AlphaProvider`,
  `AlphaBoundary`, `useAlphaSurface`), the `app/components/alpha-ui` module and its `Alpha*` exports, and
  `app/alpha-ui.css`. Primitives moved to `app/components/ui` as `Ui*` and behave unconditionally the way the
  in-boundary variant did; the `data-alpha-*` markers are replaced by descriptive `data-ui` / `data-ui-portal`
  hooks. `AlphaDesktopActionBar`, `AlphaMobileDrawer` and `useAlphaDesktopViewWindows` are renamed to
  `DesktopActionBar`, `MobileDrawer` and `useDesktopViewWindows`; `data-alpha-mobile-drawers`,
  `project-content--with-alpha-nav`, `mobile-nav-bar--alpha` and `--mobile-nav-alpha-system-offset` are
  renamed to native equivalents.

  INTENTIONAL VISUAL DIFFERENCES. The removed boundary pinned Board, Chat, Task Detail and their portaled
  overlays to a fixed neutral palette, so colour themes now genuinely apply to those surfaces. Colour presets
  also stop shipping geometry: per-theme `--space-*`, `--radius-*`, `--btn-padding`, `--btn-border-width`,
  `--card-padding` and motion durations are removed along with preset descendant rules setting font size,
  weight, letter-spacing, text-transform, border-radius or border-width, and Cozy Cartoon's button typography
  override. Shadows and focus rings keep their preset colour while taking geometry from the style catalogue.
