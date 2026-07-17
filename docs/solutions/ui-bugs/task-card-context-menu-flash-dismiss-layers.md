---
title: "Task-card popup menus dismiss after autofocus scroll"
date: 2026-07-16
category: ui-bugs
module: packages/dashboard/app/components/TaskContextMenu
problem_type: interaction_lifecycle_race
component: dashboard-task-card
tags:
  - task-card
  - context-menu
  - portal
  - focus
  - scroll
  - fn-8178
---

# Task-card popup menus dismiss after autofocus scroll

## Problem

A task-card context menu could flash open and immediately dismiss, leaving lifecycle actions unusable. The menu is portaled to `document.body`, but Board card and ListView hosts intentionally listen for capture-phase `scroll` and close an open menu when the operator scrolls.

## Root cause

`TaskContextMenu` automatically focused its first enabled action after mount. In browsers, focusing that fixed, portaled action can scroll a scrollable board ancestor into view. The resulting scroll reached the host's capture-phase dismissal listener, which correctly treated ordinary board scrolling as an explicit dismissal but could not distinguish focus-created scrolling. The result was an open → autofocus → scroll → close loop.

This was not a card stacking-context or outside-pointer containment failure: the popover is a `document.body` portal and its ref correctly recognizes presses inside the menu. All card entry methods converge on the same mounted `TaskContextMenu`, so ⋯ click, right-click, touch/pen long-press, and keyboard context-menu access shared the fault.

## Resolution

Keep automatic keyboard focus, but call `focus({ preventScroll: true })` for the first enabled menu item. This prevents the synthetic scroll while preserving intentional dismissal on item selection, outside pointerdown, Escape, and real board scrolling. Because `TaskContextMenu` is shared, ListView and Task Detail also retain their focus behavior without duplicated lifecycle guards.

## Regression coverage

The TaskCard suite simulates a browser that dispatches a scroll after default focus and verifies that each card entry method remains open with `preventScroll`, invokes its action, and still honors outside-click, Escape, and real-scroll dismissal.
