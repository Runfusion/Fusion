---
title: "Navigation history stale modal stack"
date: 2026-06-09
category: ui-bugs
module: packages/dashboard/app/hooks/useNavigationHistory
problem_type: ui_bug
component: frontend_navigation
symptoms:
  - "Mobile browser swipe-back sometimes does not close a reopened task detail modal"
  - "Browser back works after a fresh modal open but becomes inconsistent after closing with the X button"
root_cause: state_desync
resolution_type: code_fix
severity: medium
related_components:
  - packages/dashboard/app/components/AppModals.tsx
  - packages/dashboard/app/App.tsx
  - packages/dashboard/app/hooks/useModalManager.ts
tags:
  - history-api
  - popstate
  - modal-navigation
  - mobile-safari
  - stale-stack
---

# Navigation history stale modal stack

## Problem

`useNavigationHistory` mirrors modal/view opens into `window.history.pushState()` so browser back and mobile swipe-back can close the top modal or revert an overlay view. The internal stack must stay aligned with browser history entries.

A task detail modal could be opened, closed with the rendered close affordance, opened again, and then fail to close on mobile swipe-back. The close affordance updated modal state but did not remove the corresponding navigation entry, leaving a stale callback on the hook's stack.

## Symptoms

- Fresh open → browser back/swipe-back closes the modal.
- Open → close with X/mobile back button → reopen → swipe-back can no-op.
- The `popstate` handler sees a target `navIndex` that no longer matches the stale internal stack and returns without invoking the close callback.
- The issue is most visible on mobile because the fullscreen task detail modal has no overlay tap target; the browser gesture is the primary touch dismiss path.

## Root cause

`pushNav({ type: "modal", close })` added both:

1. an internal `NavEntry` in `useNavigationHistory`, and
2. a browser history entry via `history.pushState({ navIndex })`.

When a modal closed programmatically (X button, mobile header back button, state-driven close), only React/modal state changed. The hook stack retained the old `NavEntry`, so future opens produced duplicate or misindexed stack state. Browser history still moved independently, and `popstate` index arithmetic could silently bail out.

## Solution

Add `removeNav(closeOrRevert)` to `useNavigationHistory` and call it from programmatic close paths before the actual close callback:

```tsx
const closeDetailWithNav = useCallback(() => {
  removeNav(modalManager.closeDetailTask);
  deepLink.handleDetailClose();
}, [deepLink, modalManager.closeDetailTask, removeNav]);
```

`removeNav` is the inverse of `pushNav` for programmatic dismissals:

1. Search the stack from top to bottom for the matching `close` or `revert` callback.
2. Remove the matching entry from the internal stack.
3. Call `window.history.back()` to consume the browser history entry.
4. Mark the resulting `popstate` as self-triggered so the handler does not call the close/revert callback a second time.

The normal browser back/swipe path must **not** call `removeNav`; `popstate` already pops the stack and invokes the entry callback.

## Prevention

- Any modal or overlay view opened with `pushNav` must have its programmatic close path wired to `removeNav` with the same callback reference used by `pushNav`.
- Keep pushed callbacks stable (`useCallback` or modal-manager callbacks). Anonymous `revert: () => ...` callbacks cannot be removed later unless they are stored in a stable variable.
- For modal-to-modal transitions that reuse the same browser history slot, prefer `replaceCurrent` rather than `removeNav` + `pushNav`.
- Regression coverage should include both paths:
  - normal open → popstate closes modal
  - open → programmatic close → reopen → popstate closes modal

## Related files

- `packages/dashboard/app/hooks/useNavigationHistory.ts`
- `packages/dashboard/app/hooks/__tests__/useNavigationHistory.test.ts`
- `packages/dashboard/app/components/__tests__/navigation-history.test.tsx`
- `packages/dashboard/app/components/AppModals.tsx`
- `packages/dashboard/app/App.tsx`
