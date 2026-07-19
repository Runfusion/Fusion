---
title: "Confirm dialog mobile ghost-click dismissal"
date: 2026-07-17
category: ui-bugs
module: packages/dashboard/app/components/ConfirmDialog.tsx
problem_type: touch_event_compatibility
applies_when:
  - "A portal-mounted dialog opens from a touch target and immediately cancels itself"
  - "A backdrop press-origin guard is bypassed by delayed compatibility mouse events"
tags:
  - confirm-dialog
  - mobile
  - touch
  - ghost-click
  - portal
  - backdrop-dismissal
---

# Confirm dialog mobile ghost-click dismissal

## Problem

A task Delete tap on mobile opened the shared confirm dialog and then immediately dismissed it. FN-8073 already required a backdrop dismissal to begin on the backdrop, preventing a desktop trigger click from cancelling a freshly portaled dialog. That condition alone was insufficient for touch input.

After the touch-triggered click mounts the portal, mobile browsers can dispatch delayed compatibility mouse events (`mousedown` → `mouseup` → `click`) at the original tap coordinates. Because the overlay now occupies those coordinates, the synthetic `mousedown` begins on the backdrop and satisfies the FN-8073 press-origin check. Its following click incorrectly resolves the confirm as cancel.

## Solution

`ConfirmDialog` records when it opens and when a backdrop press begins. A backdrop click may cancel only when its matching press both began on the backdrop and began after the short opening-gesture settle window. The guard uses stored `Date.now()` timestamps; it adds no timeout, listener, or queue state.

```tsx
const wasPostOpenPress = pressStartedAt - openedAtRef.current >= OPENING_GESTURE_SETTLE_MS;
if (startedOnBackdrop && wasPostOpenPress && event.target === event.currentTarget) {
  onCancel();
}
```

The existing `nextFloatingZ()` call remains in the opening `useLayoutEffect`, so the portaled overlay receives its floating-stack z-index before paint. Investigation found no mobile CSS or z-order fault.

## Regression test pattern

Use fake timers and reproduce browser ordering explicitly, since JSDOM does not synthesize a click from touch events:

1. Dispatch `touchstart` and `touchend` on the delete trigger.
2. Dispatch the trigger `click` that opens the dialog.
3. Dispatch `mousedown`, `mouseup`, and `click` on the mounted `.confirm-dialog-overlay`.
4. Assert the dialog stays visible and delete remains pending; then explicitly click Confirm.

Also advance fake time past the settle window and assert a real backdrop press-and-release still cancels. Keep the existing desktop trailing-click coverage, plus Cancel, header close, Escape, choice, checkbox, queue, and floating-z tests.

## Prevention

For dialogs opened from touch-affordances, never rely only on `event.target === event.currentTarget` or whether a press began on the backdrop. A compatibility mouse burst can meet both conditions after a portal mounts. Guard the shared primitive using its opening boundary, rather than adding per-delete-trigger suppression, so every confirm caller receives identical protection while deliberate outside dismissal remains available.
