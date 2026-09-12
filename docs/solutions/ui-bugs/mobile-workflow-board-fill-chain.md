---
title: "Mobile workflow board fill chain"
date: 2026-06-13
category: ui-bugs
module: packages/dashboard/app/styles.css
problem_type: ui_bug
component: frontend_css
symptoms:
  - "On mobile viewports, workflow-mode kanban renders as a small content-sized box in the upper-left corner"
  - "The mobile footer/nav still spans the viewport while the workflow toolbar and columns do not"
  - "With Alpha disabled, columns stop short or extend behind the standard footer instead of keeping symmetric spacing"
root_cause: board_css_fill_chain_gap
resolution_type: code_fix
severity: medium
related_components:
  - packages/dashboard/app/components/Board.tsx
  - packages/dashboard/app/components/Lane.css
  - packages/dashboard/app/components/__tests__/board-mobile-initial-render.test.tsx
  - packages/dashboard/app/__tests__/board-mobile-overscroll-containment.test.ts
tags:
  - mobile-board
  - workflow-mode
  - css-fill-chain
  - scroll-containment
  - css-regression-test
applies_when:
  - "A board variant is wrapped by `.project-content` and must fill the mobile viewport"
  - "Later mobile `.board` rules can override base/tablet workflow fill rules"
---

# Mobile workflow board fill chain

## Problem

Workflow-mode board rendering uses `.board-workflow-view` around `main.board.board-workflow-columns`. On phones (`max-width: 768px`), the generic mobile board sizing rules can win after the workflow fill rules and leave the workflow board content-sized. The visible symptom is a small toolbar/column cluster in the upper-left while the rest of the dashboard chrome still fills the viewport.

The same fill chain also applies to the standard non-Alpha shell on desktop, tablet, portrait phone, and short landscape viewports. Its lower boundary is the top of the fixed `ExecutorStatusBar` (above `MobileNavBar` on mobile), reserved exactly once by `.project-content`; the Board must not calculate either chrome height itself.

## Root cause

The desktop/tablet workflow rules established a fill chain, but the mobile tier did not restate it after the generic `.board` and `.board > .column` overrides. That made the mobile path depend on inherited/earlier flex sizing through:

```text
.project-content → .board-workflow-view → .board.board-workflow-columns → .column
```

When the later mobile rules changed board/column sizing without reasserting definite `flex`, `width`, `height`, `min-height: 0`, and stretch behavior for the workflow path, the workflow board could collapse to its intrinsic content size.

A second failure mode came from a feature boundary inserted between the keep-alive host and Board. The Alpha-enabled boundary was `display: contents`, but its non-Alpha sibling was an ordinary anonymous block. That block had no flex/min-height contract, so it broke the otherwise-correct parent-relative height chain only when Alpha was absent or disabled.

## Solution

In the mobile media query, explicitly restate the full workflow fill contract after the generic board rules:

- `.project-content` remains a stretching flex container with `min-width: 0`, `min-height: 0`, and hidden outer overflow; it alone reserves the standard footer and mobile navigation.
- Feature/context boundaries between the keep-alive host and Board remain layout-transparent in every enabled/disabled state.
- `.board-workflow-view` fills its parent as a column flex container.
- `.board.board-workflow-columns` fills available width/height, remains the horizontal scroller, and keeps `overscroll-behavior-x: contain`, `touch-action: pan-x pan-y`, and `scroll-snap-type: x proximity`.
- Workflow columns keep a fixed mobile column basis/min-width while stretching vertically.
- The Board owns horizontal overflow only; each `.column-body` owns vertical card overflow, so the top and bottom Board padding remain symmetric and the document never becomes the vertical scroller.

Do not solve this with `100vh`/`100dvh`, duplicated footer or safe-area subtraction, by relaxing page-level mobile pan locks, changing board snap to `x mandatory`, or clipping the workflow board's horizontal overflow; those changes regress established mobile board navigation and overscroll behavior.

## Regression coverage

`packages/dashboard/app/components/__tests__/board-mobile-initial-render.test.tsx` should assert the mobile CSS fill chain for `.project-content`, `.board-workflow-view`, `.board.board-workflow-columns`, and workflow columns, including toolbar-present/toolbar-absent and empty/populated workflow states.

Keep `packages/dashboard/app/__tests__/board-mobile-overscroll-containment.test.ts` green alongside it so future fill fixes cannot weaken horizontal overscroll containment or change snap strictness. App-level coverage must also exercise Alpha absent and explicitly disabled with the standard footer, while the browser smoke checks positive column height, symmetric padding, no footer overlap, no document scroll, and reachability of overflowing cards through `.column-body`.
