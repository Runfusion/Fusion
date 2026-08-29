---
title: "Mobile iOS restore document scroll drift"
date: 2026-06-13
category: ui-bugs
module: packages/dashboard/app/hooks/useMobileScrollLock
problem_type: ui_bug
component: frontend_mobile_layout
applies_when: "An iOS Safari/PWA dashboard tab is restored from background or bfcache after the document has stale scroll or orphaned body offset."
symptoms:
  - "Returning to Fusion on iOS can leave the header/board pushed above the top of the screen"
  - "A large empty gap appears at the bottom even though the soft keyboard is down"
  - "The dashboard resting layout should have document scroll at the origin because body overflow is hidden"
root_cause: ios_restore_left_stale_document_scroll_or_body_offset
resolution_type: code_fix
severity: medium
related_components:
  - packages/dashboard/app/App.tsx
  - packages/dashboard/app/hooks/useMobileScrollLock.ts
  - packages/dashboard/app/hooks/useMobileKeyboard.ts
  - FN-6362
  - FN-6364
tags:
  - ios-safari
  - mobile-keyboard
  - document-scroll
  - visualviewport
  - bfcache
---

# Mobile iOS restore document scroll drift

## Problem

On iOS Safari/PWA, switching away from Fusion and returning can leave the layout viewport visually misaligned with the dashboard. The document may retain `window.scrollY > 0`, or a stale inline body offset from an earlier lock, even though Fusion's base shell uses `body { overflow: hidden }` and the resting document scroll position should be `(0, 0)`.

The visible symptom is the board/header appearing shifted upward with an empty gap at the bottom after foregrounding the app, including cases where no input is currently focused.

## Solution

Keep keyboard metrics recovery and document-scroll recovery as separate concerns:

- FN-6362 resets `useMobileKeyboard` metrics on `visibilitychange`/`pageshow` so `--vv-offset-top` consumers stop seeing a stale keyboard-open state.
- FN-6364 adds `useMobileViewportRestoreReset` in `useMobileScrollLock.ts` and wires it once from `App.tsx` for mobile layouts.

The restore hook only runs on iOS mobile devices. On `document.visibilitychange` it acts only when `document.visibilityState === "visible"`, and on `window.pageshow` it handles normal and bfcache restores. If no fullscreen scroll lock or keyboard viewport lock is active, it clears orphaned body fixed-position offset styles and calls `window.scrollTo(0, 0)` when stale document scroll is present.

Do not run this reset on Android or desktop, and do not run it while `useMobileScrollLock` or `useMobileKeyboardViewportLock` is active; live locks own their own restore path.

## Regression coverage

Cover the invariant at the `useMobileScrollLock` hook seam:

- iOS mobile + `visibilitychange` to visible + `scrollY > 0` calls `scrollTo(0, 0)`.
- iOS mobile + `pageshow` with `persisted: false` calls `scrollTo(0, 0)`.
- Android and desktop restore events are no-ops.
- `visibilitychange` to hidden is a no-op.
- Active fullscreen scroll locks and keyboard viewport locks prevent the restore hook from fighting the live lock.
- `scrollY === 0` is idempotent.
- Orphaned body `position: fixed` / `top` offset is cleared only when no lock is active.
