---
title: "Narrow desktop board pointer capture swallows clicks"
date: 2026-08-30
category: ui-bug
module: dashboard-board
problem_type: pointer_capture_retargeting
applies_when:
  - "Board controls stop responding after a desktop browser window becomes narrow"
  - "A viewport-gated ancestor captures pointer input before horizontal drag intent is established"
tags:
  - board
  - pointer-capture
  - mouse
  - mobile-viewport
  - jsdom
---

# Narrow desktop board pointer capture swallows clicks

## Problem

`isMobileViewport()` is width-based but not touch-gated. A regular desktop browser narrowed to 768 CSS pixels or less therefore enters the mobile board mode even when it has no touch screen.

The board's mobile column-snap owner captured every `pointerdown` on the board. Pointer capture on that ancestor retargeted the later `pointerup` and compatibility `click` away from a descendant task-card button, making controls appear dead until the window was widened. FN-9219 correctly marked Electron content as non-draggable, but that desktop-app drag-region rule cannot affect a regular browser.

## Solution

`useColumnScrollSnap` ignores mouse pointer events at every pointer gesture entry point. Touch, pen, wheel, scroll, and settle behavior remain owned by the existing mobile snap path.

`useBoardMousePan` is attached to every live Board root. It is mouse-only, excludes buttons and other interactive descendants, and takes pointer capture only after a four-pixel dominant-horizontal drag. The resulting rule is simple: stationary mouse input always remains native to the board control, while a proven horizontal mouse pan captures and consumes only its own compatibility click.

## Regression test pattern

jsdom cannot create trusted events or implement pointer capture retargeting. Use the existing `isUserInteraction` test seam to treat dispatched events as user input, and replace the scroller's capture methods with stateful spies.

The test-local emulator must dispatch `pointerdown` on the button, snapshot the capture holder before delivering `pointerup`, then dispatch both `pointerup` and `click` to that snapshot holder. Production release handling can clear capture during `pointerup`; reading capture state after that dispatch incorrectly sends the click back to the button and makes the regression pass on the defect. Include a self-check where an ancestor captures on down and releases during up, yet still receives the click.

Assert the narrow non-touch desktop classification, no mouse capture, no snap suspension or settle, and one descendant button click. Keep touch capture and wheel paging controls in the same file so the pointer-type fence cannot accidentally disable mobile paging.

## Prevention

Do not let a viewport-mode ancestor capture ordinary mouse presses before horizontal intent is proven. A narrow desktop layout can legitimately share mobile geometry without sharing touch gesture ownership. Keep mouse panning behind the existing interactive-target exclusion and movement threshold, and keep mobile snap ownership for touch and wheel paths.
