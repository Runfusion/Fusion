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
root_cause: mobile_css_fill_chain_gap
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

## Root cause

The desktop/tablet workflow rules established a fill chain, but the mobile tier did not restate it after the generic `.board` and `.board > .column` overrides. That made the mobile path depend on inherited/earlier flex sizing through:

```text
.project-content → .board-workflow-view → .board.board-workflow-columns → .column
```

When the later mobile rules changed board/column sizing without reasserting definite `flex`, `width`, `height`, `min-height: 0`, and stretch behavior for the workflow path, the workflow board could collapse to its intrinsic content size.

## Solution

In the mobile media query, explicitly restate the full workflow fill contract after the generic board rules:

- `.project-content` remains a stretching flex container with `min-width: 0`, `min-height: 0`, and hidden outer overflow.
- `.board-workflow-view` fills its parent as a column flex container.
- `.board.board-workflow-columns` fills available width/height, remains the horizontal scroller, and keeps `overscroll-behavior-x: contain`, `touch-action: pan-x pan-y`, and `scroll-snap-type: x proximity`.
- Workflow columns keep a fixed mobile column basis/min-width while stretching vertically.

Do not solve this by relaxing page-level mobile pan locks, changing board snap to `x mandatory`, or clipping the workflow board's horizontal overflow; those changes regress established mobile board navigation and overscroll behavior.

## Regression coverage

`packages/dashboard/app/components/__tests__/board-mobile-initial-render.test.tsx` should assert the mobile CSS fill chain for `.project-content`, `.board-workflow-view`, `.board.board-workflow-columns`, and workflow columns, including toolbar-present/toolbar-absent and empty/populated workflow states.

Keep `packages/dashboard/app/__tests__/board-mobile-overscroll-containment.test.ts` green alongside it so future fill fixes cannot weaken horizontal overscroll containment or change snap strictness.
