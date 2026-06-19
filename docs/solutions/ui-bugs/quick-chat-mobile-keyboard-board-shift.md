---
title: "Quick Chat mobile keyboard board shift"
date: 2026-06-12
category: ui-bugs
module: packages/dashboard/app/utils/mobileBarKeyboardFlags
problem_type: ui_bug
component: frontend_mobile_layout
applies_when: "A fullscreen mobile overlay owns its own soft-keyboard and visual-viewport handling while the dashboard board remains mounted underneath."
symptoms:
  - "Opening Quick Chat on mobile focuses the composer and raises the soft keyboard"
  - "The board underneath shifts upward because App-level keyboard logic removes footer/mobile-nav padding"
  - "After dismissing the keyboard or closing Quick Chat, the board can remain shifted with a bottom gap"
root_cause: overlay_keyboard_state_leaked_to_board_layout
resolution_type: code_fix
severity: medium
related_components:
  - packages/dashboard/app/App.tsx
  - packages/dashboard/app/components/QuickChatFAB.tsx
  - packages/dashboard/app/hooks/useMobileScrollLock.ts
  - FN-6329
tags:
  - quick-chat
  - mobile-keyboard
  - visualviewport
  - overlay-layout
  - footer-padding
---

# Quick Chat mobile keyboard board shift

## Problem

Quick Chat's mobile UI is a fullscreen fixed sheet that covers the board and manages its own keyboard viewport with `--vv-height` and `--vv-offset-top`. App-level mobile keyboard logic did not know that sheet was open, so the Quick Chat composer keyboard was treated like an inline board keyboard.

On iOS, `computeMobileBarKeyboardFlags` returned `footerHidden: true` whenever `isMobile`, `keyboardOpen`, and `!anyModalOpen` were true. `App.tsx` mapped that to `mobileKeyboardOpen`, which removed `project-content--with-footer` / `project-content--with-mobile-nav` and hid the footer. Because Quick Chat is not part of `modalManager.anyModalOpen`, the board behind the sheet shifted up and could remain offset after iOS keyboard dismissal lag.

## Solution

Model fullscreen mobile overlays as explicit board-layout suppressors in `computeMobileBarKeyboardFlags`.

- Keep existing modal suppression intact.
- Add an `overlayOpen` input and suppress only `footerHidden` when `anyModalOpen || overlayOpen` is true.
- Preserve `navKeyboardOpen` and `footerKeyboardOpen` semantics so mobile nav/footer keyboard classes continue to reflect keyboard state where needed.
- In `App.tsx`, pass `overlayOpen: isMobile && quickChatOpen` so only Quick Chat's mobile fullscreen sheet suppresses board layout. Desktop Quick Chat remains unaffected.

This keeps the board's footer/mobile-nav padding classes present for the entire time Quick Chat is open. The board therefore never shifts in response to the Quick Chat keyboard, leaving nothing to snap back after the overlay closes.

## Related viewport-smoothing pitfall

FN-6498 found a separate Quick Chat viewport-tracking jank source inside `QuickChatFAB.tsx`: mobile `visualViewport` `resize` and `scroll` events can report the same `{ height, offsetTop }` sample during one keyboard animation tick, especially on Android Chrome with `interactive-widget=resizes-content`. The sheet should still own `--vv-height` / `--vv-offset-top`, but same-sample writes are deduped so the overlay does not add redundant style/layout invalidation while the board-shift suppression described above keeps the board underneath stable.

## Regression coverage

Cover the invariant at the pure helper seam:

- iOS + mobile + keyboard + no overlay still hides the footer for inline board keyboards.
- iOS + mobile + keyboard + modal keeps the footer visible.
- iOS + mobile + keyboard + fullscreen overlay keeps the footer visible.
- Android + mobile + keyboard + fullscreen overlay keeps `footerHidden` false while preserving nav keyboard state.
- Non-mobile remains all-false.

Prefer this narrow helper coverage over mock-heavy `App` rendering unless a future regression needs DOM-level evidence. `computeMobileBarKeyboardFlags` has a single production caller in `App.tsx`, making the seam small and reliable.
