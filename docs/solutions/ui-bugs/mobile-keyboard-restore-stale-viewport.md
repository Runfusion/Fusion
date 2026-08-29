---
title: "Mobile keyboard restore stale viewport reset"
date: 2026-06-13
category: ui-bugs
module: packages/dashboard/app/hooks/useMobileKeyboard
problem_type: ui_bug
component: frontend_mobile_layout
applies_when: "A mobile browser restores the page from hidden/pageshow after the soft keyboard collapses while the focused input remains active."
symptoms:
  - "Returning to the dashboard on iOS can leave mobile layout in a keyboard-open state after the keyboard is already down"
  - "Viewport height/offset metrics remain stale when an input stays focused across the hidden → visible or pageshow transition"
  - "Footer/mobile-nav spacing can stay suppressed until a later resize or blur event corrects the metrics"
root_cause: stale_visualviewport_sample_held_after_restore
resolution_type: code_fix
severity: medium
related_components:
  - packages/dashboard/app/App.tsx
  - packages/dashboard/app/utils/mobileBarKeyboardFlags.ts
  - FN-5155
  - FN-6362
tags:
  - mobile-keyboard
  - visualviewport
  - ios
  - pageshow
  - visibilitychange
  - viewport-metrics
---

# Mobile keyboard restore stale viewport reset

## Problem

`useMobileKeyboard` protects normal in-session keyboard handling from impossible iOS samples: when an input is focused, a transient sample that reports a restored full viewport but still carries stale open-keyboard metrics can be held so the dashboard does not flicker. That FN-5155 guard is useful while the page is active, but it also masked a real restore transition.

When the app returned from `hidden`/`pageshow` with the soft keyboard collapsed and the focused input still active, the hook reused the previous open-keyboard metrics. Because focus remained on the input, the impossible-sample hold treated the collapsed restore sample as suspicious and kept `keyboardOpen`, `viewportHeight`, and `offsetTop` stale until another resize or blur arrived.

## Solution

Handle page restore as a distinct sampling path rather than weakening the normal in-session guard.

- On `visibilitychange` back to `visible` and on `pageshow`, take an immediate restore sample.
- If the restore sample is a collapsed/full-height viewport, reset the baseline viewport height and bypass the impossible-sample hold for that one sample.
- Keep FN-5155's impossible-sample hold in place for regular resize/focus/tail updates.
- Continue scheduling delayed tail updates after restore so later iOS viewport corrections still land.

This lets a collapsed restore clear `keyboardOpen`, `viewportHeight`, and `offsetTop` even when `document.activeElement` is still an input, while a genuinely open restored keyboard remains open.

## Regression coverage

Cover restore as a surface invariant, not only the single iOS reproduction:

- `visibilitychange` from hidden to visible with retained focus and a collapsed viewport resets stale open-keyboard metrics.
- `pageshow` with stale positive `visualViewport.offsetTop` drift clears the keyboard state when the viewport is full height.
- A genuinely shrunken restored viewport remains keyboard-open.
- Android-style shrink metrics reset without carrying iOS offset drift.
- Existing FN-5155 in-session impossible-sample coverage remains green, proving the normal guard was not removed.

The hook-level test seam is preferable here because callers already consume the hook-provided `keyboardOpen` and viewport values; no consumer-specific behavior needed to change.
