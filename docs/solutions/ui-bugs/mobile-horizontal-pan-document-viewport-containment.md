---
title: "Mobile document horizontal pan containment"
date: 2026-06-13
category: ui-bugs
module: packages/dashboard/app/styles.css
problem_type: ui_bug
component: frontend_css
symptoms:
  - "On mobile, the entire dashboard can be horizontally panned into a shifted state"
  - "Header, board, and footer slide left together while a dark empty void appears on the right"
  - "The inner kanban board should scroll horizontally, but the document/page itself must not"
root_cause: mobile_viewport_containment
resolution_type: css_fix
severity: high
related_components:
  - packages/dashboard/app/__tests__/mobile-horizontal-pan-containment.test.ts
  - packages/dashboard/app/__tests__/mobile-scroll-snap.test.ts
  - packages/dashboard/app/__tests__/board-tablet-overflow.test.ts
tags:
  - mobile
  - viewport
  - overflow
  - touch-action
  - visual-viewport
  - kanban-board
---

# Mobile document horizontal pan containment

## Problem

The mobile dashboard can enter a broken off-axis state where the whole page chrome shifts left and exposes an empty dark strip on the right. The screenshot for FN-6365 showed the header, board, and footer all shifted together, which means the document/visual viewport was panned horizontally — not just the intended `.board` column strip.

## Root cause

The mobile global CSS locked `overflow: hidden` on `html`, `body`, and `#root`, but every element was also assigned `touch-action: pan-x pan-y`. That allowed horizontal gestures that began on root chrome, fixed bars, modal chrome, or other non-board surfaces to be interpreted as page-level horizontal panning. The board was the intended horizontal scroller, but the document root did not explicitly enforce vertical-only touch handling, `overflow-x: hidden`, and `overscroll-behavior-x: none` as separate invariants.

Fullscreen mobile overlays were also only constrained by `width/max-width: 100%`; adding logical inline-size constraints keeps modal/overlay chrome from widening the document when the layout viewport and visual viewport diverge.

## Fix

In the mobile `@media (max-width: 768px)` global block:

- Lock `html`, `body`, and `#root` to the viewport inline axis with `width/max-width: 100%`, `overflow-x: hidden`, and `overscroll-behavior-x: none`.
- Make document-root/default touch handling vertical-only with `touch-action: pan-y`.
- Opt the known legitimate horizontal scrollers back into `touch-action: pan-x pan-y`: `.board`, `pre`, `code`, `.code-block`, and `table`.
- Keep `.board` horizontally scrollable with `overflow-x: auto`, `-webkit-overflow-scrolling: touch`, and `scroll-snap-type: x proximity`.
- Constrain mobile fullscreen overlay/modal chrome with `inline-size: 100%`, `max-inline-size: 100%`, and `min-width: 0` where appropriate.

## Regression coverage

`packages/dashboard/app/__tests__/mobile-horizontal-pan-containment.test.ts` asserts the containment contract directly from CSS fixtures:

- Mobile root has `overflow-x: hidden`, `overscroll-behavior-x: none`, and `touch-action: pan-y`.
- The mobile `.board` still has `overflow-x: auto` and `scroll-snap-type: x proximity`.
- Code/table opt-in horizontal scrollers keep `touch-action: pan-x pan-y`.
- Fullscreen overlay/modal chrome is constrained to the viewport inline size.
- The tablet `.board` overflow rule remains unchanged.

## Pitfall

Do not fix this class by blanket-clipping all descendants or removing `.board` horizontal scrolling. The board, code blocks, and tables are valid inner horizontal scrollers; the invariant is that the document/visual viewport itself must stay at horizontal offset zero.
