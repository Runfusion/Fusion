---
title: "Mobile board iOS horizontal overscroll containment"
date: 2026-06-13
category: ui-bugs
module: packages/dashboard/app/styles.css
problem_type: ui_bug
component: frontend_css
symptoms:
  - "On iOS Safari/PWA, dragging the kanban board past the first or last column rubber-bands the column strip off screen"
  - "Horizontal edge overscroll can expose empty space and chain to the document even though the board's inner column scroll is intentional"
root_cause: css_scroll_containment_gap
resolution_type: code_fix
severity: medium
related_components:
  - packages/dashboard/app/components/Lane.css
  - packages/dashboard/app/__tests__/board-mobile-overscroll-containment.test.ts
tags:
  - ios-safari
  - mobile-board
  - overscroll-behavior
  - scroll-snap
  - css-regression-test
  - kanban
applies_when:
  - "A horizontally scrollable Board surface uses `overflow-x: auto` with mobile momentum scrolling"
  - "Edge dragging should keep native inner scrolling but must not chain or park content off screen"
---

# Mobile board iOS horizontal overscroll containment

## Problem

The mobile kanban Board intentionally scrolls horizontally between columns using `overflow-x: auto`, `-webkit-overflow-scrolling: touch`, and `scroll-snap-type: x proximity`. On iOS Safari/PWA, that same momentum scroller can rubber-band past its first or last column if the scroller does not contain horizontal overscroll. The visible result is that the columns slide away from the viewport edge, exposing empty space and sometimes chaining the drag to the document.

## Root cause

The board had page-level mobile overscroll protection on `html, body`, but the Board itself is the horizontal scroll container. The base `.board` and the live workflow-column `.board.board-workflow-columns` rules declare the intended scroll and snap properties with `overscroll-behavior-x: contain`, so iOS edge overscroll stops at the Board boundary. Both selected-workflow and All-workflows render paths use the workflow-column selector.

## Solution

Keep axis-specific containment on the current horizontal Board surfaces:

```css
.board,
.board.board-workflow-columns {
  overflow-x: auto;
  overscroll-behavior-x: contain;
}

@media (max-width: 768px), (max-height: 480px) {
  .board.board-workflow-columns {
    scroll-snap-type: x proximity;
  }
}
```

Keep `contain` rather than `none`: the Board retains its native inner scroll feel while edge overscroll stops at the Board container instead of chaining outward. Desktop and tablet workflow columns explicitly use `scroll-snap-type: none`; phone and short-landscape workflow columns use proximity snapping. Do not replace this with `overflow: hidden`/`clip`, and do not switch snap to `x mandatory`; both would regress intentional mobile column navigation.

## Regression coverage

Use CSS-fixture tests that load the combined dashboard CSS and assert:

- the base `.board` and `.board.board-workflow-columns` rules have `overflow-x: auto`, `overscroll-behavior-x: contain`, and `scroll-snap-type: none`;
- the phone and short-landscape `.board` and `.board.board-workflow-columns` rules retain `scroll-snap-type: x proximity`;
- neither Board workflow render path permits `scroll-snap-type: x mandatory`;
- the retired lane compatibility selector is absent from both the base and phone CSS slices.

For FN-6378 this lives in `packages/dashboard/app/__tests__/board-mobile-overscroll-containment.test.ts` and the companion column-swipe fixture.
