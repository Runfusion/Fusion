---
title: CSS animations silently frozen by transition tokens used as durations (IACVT)
date: 2026-06-03
category: ui-bugs
module: dashboard
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "Spinners, status-dot pulses, and entrance animations render but never move"
  - "No console errors, no DevTools strikethrough, no @keyframes parse errors"
  - "getComputedStyle(el).animationName returns \"none\" on affected elements; el.getAnimations() is empty"
  - "Other animations on the same page work fine, making the bug look intermittent"
root_cause: wrong_api
resolution_type: code_fix
severity: high
related_components:
  - tooling
tags: [css-custom-properties, iacvt, animation, design-tokens, transition-tokens, regression-test, dashboard-css]
---

# CSS animations silently frozen by transition tokens used as durations (IACVT)

## Problem

Dashboard spinners, status-dot pulses, and entrance animations rendered but never moved. The `--transition-*` design tokens carry a duration+easing **pair** (`--transition-slow: 0.3s ease`), and 15 `animation` declarations across 14 CSS files reused them as bare durations — which silently invalidated each whole declaration.

## Symptoms

- Spinners/loaders/pulses visible in the DOM but completely frozen
- Zero diagnostics: no console error, no DevTools strikethrough, the declaration looks healthy in the Styles panel
- `getComputedStyle(el).animationName === "none"` and `el.getAnimations().length === 0` on affected elements
- Some animations on the same page kept working (see Why This Works), so the bug appeared intermittent
- Invisible to static CSS reading and to jsdom-based tests

## What Didn't Work

- **Prior partial fixes (FN-5855, FN-5913)** addressed only the `.animate-spin` utility, which uses a literal `1s` duration — a separate code path. The token-misuse pattern survived both fixes.
- Checking for `prefers-reduced-motion` overrides or `animation-play-state` rules — none existed.
- Suspecting duplicate `@keyframes spin` definitions across component CSS files — all were valid `rotate(360deg)` definitions; identical re-definitions are harmless.
- Dev-server repro without a backend (Vite's `/api` proxy prefix-matches the app's own `/api.ts` module requests, blanking the page). Repro that worked: **production build served statically**, injected test elements, measured via `getComputedStyle`/`getAnimations()`.

## Solution

Fix PR: Runfusion/Fusion#1386 (commit `2d2024fb0`).

Split the tokens: bare durations become the source of truth, transition pairs are derived so the two can never drift (`packages/dashboard/app/styles.css`):

```css
/* Before — token encodes BOTH duration and easing */
--transition-slow: 0.3s ease;

/* After — duration is the source of truth; transition pair is derived
   (same pattern for instant/fast/normal/slow) */
--duration-slow: 0.3s;
--transition-slow: var(--duration-slow) ease;
```

All 15 animation declarations switched to the duration tokens:

```css
/* Before — IACVT: substitutes to two <easing-function> values */
animation: spin var(--transition-slow) linear infinite;
/* Before — IACVT: calc() cannot multiply "0.3s ease" */
animation: spin calc(var(--transition-slow) * 4) linear infinite;

/* After */
animation: spin var(--duration-slow) linear infinite;
animation: spin calc(var(--duration-slow) * 4) linear infinite;
```

`transition:` consumers of `--transition-*` were always valid and stay unchanged.

## Why This Works

This is the **invalid-at-computed-value-time (IACVT)** mechanism from CSS Custom Properties Level 1. `var()` substitution happens *after* parsing, as opaque tokens — the parser cannot type-check. When the substituted value is invalid for the property, the browser does not ignore just the bad token; **the entire declaration is discarded** and the property falls back to inherited/initial. For `animation`, initial is `none`. No error is reported anywhere.

```
animation: spin var(--transition-slow) linear infinite
              ↓ substitution
animation: spin 0.3s ease linear infinite
                 ↑    ↑      ↑
             <time> <easing> <easing>   ← second easing keyword = invalid
              ↓ IACVT
animation: none                        ← whole declaration silently dropped
```

Why some animations kept working: `animation: spin var(--transition-slow) infinite` (no second easing) is *valid* — `0.3s ease` parses as `<time> <easing-function>`. Only declarations adding their own easing keyword, or wrapping the token in `calc()`, broke. That inconsistency is what made the bug look intermittent.

## Prevention

- **The failure mode generalizes:** IACVT applies to *any* property consuming a custom property — the same silent whole-declaration drop can disable `transition`, `grid-template-columns`, `transform`, etc. Treat token value *shape* as part of its contract.
- **Token design rule:** never bundle multiple value types in one token if any consumer needs just one of them. Keep duration-only tokens (`--duration-*`) as the source of truth and derive combined tokens (`--transition-*: var(--duration-*) ease`) from them.
- **Regression test:** `packages/dashboard/app/__tests__/animation-duration-tokens.css.test.ts` sweeps every CSS file under `app/` and fails on the three invalid shapes:
  1. `animation:` shorthand combining `var(--transition-*)` with an explicit easing keyword
  2. `calc(var(--transition-*)` anywhere
  3. `animation-duration: var(--transition-*)`

  It also asserts the duration tokens exist and that `--transition-*` stay derived. It enumerated all 15 broken sites red before the fix.
- **Verification rule:** IACVT cannot be caught by linters (the CSS is syntactically valid) or jsdom (no computed-value validation). Definitive check is in a real browser engine: `getComputedStyle(el).animationName !== "none"` and `el.getAnimations().length > 0`.

## Related Issues

- Runfusion/Fusion#1386 — fix PR for this bug
- Runfusion/Fusion#39 / PR #40 — earlier frozen-spinner incident with a *different* root cause (`.animate-spin`/`@keyframes spin` not globally scoped); useful contrast case at the same symptom layer
- `docs/dashboard-guide.md` §Design tokens / §Common pitfalls — token family documentation (update candidates)
- The token misuse spread widely because dashboard CSS was previously extracted from a 40k-line monolith into ~56 component files (auto memory [claude])
