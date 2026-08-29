---
title: "Mobile auto-merge toggle blanks dashboard via document horizontal scroll"
date: 2026-06-11
category: ui-bugs
module: packages/dashboard/app/components/Board
problem_type: ui_bug
component: dashboard-board
symptoms:
  - "Toggling the in-review Auto-merge switch on a mobile viewport leaves the dashboard blank/white until refresh"
  - "React board subtree remains mounted; no PageErrorBoundary fallback or pageerror is emitted"
  - "Existing jsdom board/task-card/worktree tests pass because jsdom has no real viewport pan/paint"
root_cause: mobile_document_horizontal_scroll
resolution_type: code_fix
severity: high
related_components:
  - packages/dashboard/app/components/Column
  - packages/dashboard/app/hooks/useAppSettings
  - packages/dashboard/app/styles.css
tags:
  - mobile
  - real-browser
  - auto-merge
  - horizontal-scroll
  - blank-screen
  - fn-6243
---

# Mobile auto-merge toggle blanks dashboard via document horizontal scroll

## Problem

The recurring mobile blank-screen regression for the in-review **Auto-merge** toggle was not a React unmount or thrown exception. A real mobile browser can pan the **document** horizontally while bringing the offscreen in-review toggle into view/focus. Once `window.scrollX` is non-zero, the entire dashboard shell is shifted left and the viewport can look blank even though `main.board` and all columns remain mounted.

## Real-browser evidence

FN-6243 reproduced this with the existing Playwright CLI against a real dashboard process (`node packages/cli/dist/bin.js dashboard --port 0 --no-auth --dev --paused`) at a 375×812 mobile/touch viewport.

Pre-fix evidence:

- Before toggle: `main.board` box `{ x: 0, width: 375, height: 454.828125 }`; in-review column box `{ x: 948, width: 300, height: 430.828125 }`.
- After toggle: `main.board` still existed but box shifted to `{ x: -911, width: 375, height: 454.828125 }`; in-review column shifted to `{ x: -874, width: 300, height: 430.828125 }`.
- `pageErrors: []`.

Post-fix evidence:

- After toggle round-trip: `window.scrollX === 0`, `main.board` remained at `{ x: 0, width: 375, height: 454.828125 }`, in-review column was visible with non-zero size, and `pageErrors: []`.

## Solution

Keep the document/root horizontal scroll pinned to zero on mobile board stabilization and immediately after the auto-merge toggle fires. The board's own internal horizontal scroll remains the only horizontal scroller; do not reintroduce mandatory scroll snap.

Regression coverage should include both:

1. The existing jsdom integration surface for `useAppSettings.toggleAutoMerge` success and rollback paths.
2. A real-browser/manual or smoke run when the bug class involves viewport pan, paint, layout, visual viewport, or fixed mobile chrome. jsdom cannot reproduce this class.
