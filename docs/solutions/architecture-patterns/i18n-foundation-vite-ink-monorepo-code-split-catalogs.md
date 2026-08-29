---
title: "i18n foundation for a Vite + Ink monorepo with code-split catalogs"
date: 2026-06-03
category: architecture-patterns
module: "@fusion/i18n"
problem_type: architecture_pattern
component: tooling
severity: medium
related_components:
  - "@fusion/i18n"
  - "@fusion/core"
  - dashboard
  - cli
applies_when:
  - "Adding i18n to a pnpm monorepo that ships both a Vite/React surface and an Ink/CJK TUI"
  - "Code-split locale catalogs are needed and Vite dynamic-import-vars rejects cross-package or aliased specifiers"
  - "A single source of truth for locale + namespace lists must be shared across packages"
  - "Supporting Chinese locale pairs where zh-CN and zh-TW must never collapse into a generic zh"
  - "Upgrading i18next to v26 (initImmediate removed; synchronous init with inline resources)"
symptoms:
  - "Locale catalogs leak into the main bundle instead of code-splitting into per-locale chunks"
  - "vi.mock of @fusion/core breaks CI after adding a new SUPPORTED_LOCALES export"
  - "i18next v26 rejects initImmediate; convertDetectedLanguage silently ignored at top level"
tags:
  - i18n
  - vite
  - ink
  - react-i18next
  - code-splitting
  - monorepo
  - cjk
  - dynamic-import
---

# i18n foundation for a Vite + Ink monorepo with code-split catalogs

## Context

Fusion ships two UI surfaces from one pnpm monorepo: a React/Vite browser dashboard and an Ink-based terminal UI. The goal was full internationalization (en, zh-CN, zh-TW, fr, es) across both surfaces with `react-i18next` v17 / `i18next` v26, while keeping "add a new locale" a near-zero-code operation and ensuring per-locale catalogs never bloat the initial bundle. The two surfaces have different runtimes (browser with lazy code-splitting vs. Node with synchronous startup), so each builds its own `i18next` instance but they share locale list, namespace split, fallback chain, and base options from a single `@fusion/i18n` package. Shipped in PR #1352; this doc captures the load-bearing constraints and failure modes the plan and contributor guide do not cover.

## Guidance

**Single source of truth for namespaces.** `packages/i18n/namespaces.json` is the one file that defines which namespaces exist and which surface loads which subset. The runtime config and all three build scripts read it, so they can't drift:

```json
{ "all": ["common","app","errors","cli"],
  "dashboard": ["common","app","errors"],
  "cli": ["common","cli","errors"] }
```

**Relative dynamic-import + sync-script pattern (dashboard code-splitting).** `@rollup/plugin-dynamic-import-vars` only splits a variable dynamic import if the specifier is app-relative with one variable per path segment. A cross-package or aliased specifier silently defeats it and inlines every catalog into the main bundle. So a predev/prebuild script (`packages/dashboard/scripts/sync-locales.mjs`) copies catalogs from `packages/i18n/locales/` into the gitignored `packages/dashboard/app/locales/`, and the runtime imports them app-relatively:

```ts
// packages/dashboard/app/i18n/index.ts
i18next.use(resourcesToBackend((language: string, namespace: string) =>
  import(`../locales/${language}/${namespace}.json`)))
```

A build-time guard, `packages/dashboard/scripts/assert-locale-chunks.mjs`, derives the expected chunk count from the authored locale directory (no hardcoded count) and fails the build if any locale/namespace chunk is missing or catalog content leaks into `index-*.js`. The failure mode is silent otherwise — the guard is what makes the split durable.

**`normalizeToSupportedLocale` — shared Chinese script/region routing.** One helper, used by both dashboard navigator detection (`convertDetectedLanguage`) and CLI env detection, so zh resolution is identical on both surfaces:

```ts
// packages/i18n/src/config.ts
export function normalizeToSupportedLocale(tag: string): Locale | undefined {
  if (!tag) return undefined;
  const norm = tag.replaceAll("_", "-");          // POSIX zh_CN → zh-CN
  if (isLocale(norm)) return norm;
  const lower = norm.toLowerCase();
  if (lower.startsWith("zh")) {
    if (lower.includes("hans")) return "zh-CN"; // explicit script wins over region (zh-Hans-HK)
    if (lower.includes("hant") || lower.includes("-tw") ||
        lower.includes("-hk") || lower.includes("-mo")) return "zh-TW";
    return "zh-CN";
  }
  const base = lower.split("-")[0];               // fr-FR → fr
  return isLocale(base) ? base : undefined;
}
```

Paired with a script-aware fallback chain plus `load: "currentOnly"` in `baseInitOptions`, so `zh-CN`/`zh-TW` never collapse into a generic `zh`:

```ts
export const FALLBACK_LNG = { "zh-Hans": ["zh-CN"], "zh-Hant": ["zh-TW"],
  zh: ["zh-CN"], default: [DEFAULT_LOCALE] };
```

**Three-tier persistence (`useLanguage`, mirrored from `useTheme`).** localStorage cache (`kb-dashboard-language`) + server write-through to `GlobalSettings.language` + hydrate-on-mount, with a `userSetRef` guard so in-flight hydration can't clobber a concurrent user choice, plus a cross-tab `storage` listener:

```ts
// packages/dashboard/app/hooks/useLanguage.ts
const setLanguage = useCallback((locale: Locale) => {
  userSetRef.current = true;                     // user choice now wins over hydration
  void i18n.changeLanguage(locale);
  localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
  void updateGlobalSettings({ language: locale }).catch(/* warn, don't throw */);
}, [i18n]);

// hydrate effect — the guard the ref protects:
void fetchGlobalSettings().then((settings) => {
  if (cancelled || userSetRef.current) return;   // never clobber a user choice
  ...
});
```

The write boundary is also guarded server-side in `packages/core/src/store.ts` via `validateLocale` (invalid values are dropped, never persisted).

**CLI inline-resources init (synchronous startup).** The TUI bundles all catalogs statically via a generated `cliResources` map and inits synchronously, so the first Ink frame is already localized — no async backend, no flash of raw keys:

```ts
// packages/cli/src/i18n/index.ts
void i18next.use(initReactI18next).init({
  ...baseInitOptions(),
  lng: locale,
  ns: [...CLI_NAMESPACES],
  resources: cliResources as unknown as Resource,   // inline → sync init
  react: { useSuspense: false },
});
```

`cliResources` is generated by `packages/i18n/scripts/gen-cli-catalogs.mjs` from the `locales/` directory — adding a locale is "add the folder, regenerate, done." CLI locale precedence: `--lang` flag → `GlobalSettings.language` → env (`LC_ALL`/`LANG`/…) → `en`.

**Locale primitives live in `packages/core/src/types.ts`.** The dashboard's Vite alias resolves the entire `@fusion/core` package to that single file:

```ts
// packages/dashboard/vite.config.ts
"@fusion/core": resolve(__dirname, "../core/src/types.ts"),
```

Anything the dashboard imports from `@fusion/core` must be reachable from `types.ts` — `SUPPORTED_LOCALES`, `Locale`, `DEFAULT_LOCALE`, and `isLocale` were placed there, not in a new module.

## What Didn't Work

1. **`initImmediate: true` at top level** — rejected by i18next v26's `InitOptions` types. v26 removed the flag; with inline `resources` and no async backend, init is already synchronous, so the fix was to drop the option entirely.
2. **`convertDetectedLanguage` as a top-level `InitOptions` field** — silently ignored. It is an `i18next-browser-languagedetector` option and belongs inside the `detection` block. Moving it there made navigator normalization (e.g. `zh-Hant-TW` → `zh-TW`) actually fire.
3. **Vitest couldn't resolve `@fusion/core`** without a per-package alias-to-source — the dashboard's runtime Vite alias does not carry into the test runner, so each consuming package needed its own `vitest.config.ts` alias.
4. **CI shard 1: `vi.mock("@fusion/core")` in `settings.test.ts` was incomplete** — the hand-written mock lacked the newly added `SUPPORTED_LOCALES` export, so the locale enum resolved to `undefined` and the shard failed deterministically (initially misread locally as flaky). Lesson: a manual module mock is a second source of truth that must be updated alongside the real module's public surface.
5. **CI shard 2: `LanguageSelector.css` used the banned `--text-secondary` token** — the FN-4286 text-token-canonicalization guard rejects it; canonical is `--text-muted`.

## Why This Matters

- **Bundle-size correctness.** The relative-import + assert-chunks guard is the difference between lazily-fetched per-locale chunks and one fat main bundle carrying all five languages — and the regression is silent without the guard.
- **zh-CN / zh-TW correctness.** Simplified vs. Traditional Chinese are not interchangeable. The normalizer + script-aware fallback + `load: "currentOnly"` guarantee Traditional-script users never silently get Simplified.
- **Single source of truth prevents drift.** `namespaces.json` is read by config, sync-locales, assert-locale-chunks, and gen-cli-catalogs; chunk-count expectations are derived, not hardcoded.
- **Settings parity across surfaces.** Both surfaces detect via the same normalizer, persist to the same `GlobalSettings.language`, and validate at the same store boundary — a locale chosen in the dashboard carries into the TUI and vice versa.

## When to Apply

- Adding i18n to a Vite app that relies on code-splitting catalogs — the relative-import constraint and a chunk-leak guard apply directly.
- Supporting script/region-split language pairs (zh-CN/zh-TW, sr-Latn/sr-Cyrl) where a generic base tag must not collapse the variants.
- Terminal/CJK UIs: budget for double-width rendering (Ink 6.8→7.0 here) and prefer inline-resource synchronous init so the first frame is localized.
- Monorepos where catalogs live in a shared package but the consuming app's bundler only statically analyzes app-relative specifiers — copy into the app tree (gitignored) rather than importing cross-package.

## Examples

**Cross-package import that fails vs. app-relative that splits:**

```ts
// ✗ defeats @rollup/plugin-dynamic-import-vars — all catalogs inline into main bundle
import(`@fusion/i18n/locales/${language}/${namespace}.json`)

// ✓ app-relative, one var per segment — Vite emits one chunk per locale/namespace
import(`../locales/${language}/${namespace}.json`)
```

**i18next v26 migration:**

```ts
// ✗ i18next ≤25
i18next.init({ initImmediate: false, convertDetectedLanguage: normalize, ... })

// ✓ i18next 26: initImmediate gone (inline resources are sync anyway);
//   convertDetectedLanguage lives in the languagedetector detection block
i18next.use(LanguageDetector).init({
  detection: { order: [...], convertDetectedLanguage: normalize },
  ...
})
```

## Related

- `docs/i18n-contributing.md` — the how-to guide for adding locales/strings (workflow; this doc covers the failure modes behind it)
- `docs/plans/2026-06-03-001-feat-ui-localization-i18n-plan.md` — the implementation plan (status: completed)
- GitHub issue #64 — "[i18n] Chinese (Simplified) Language Support for Dashboard" (originating request)
- PR #1352 — the implementation
