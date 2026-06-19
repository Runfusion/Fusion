---
title: "Tablet keyboard viewport mode flip"
date: 2026-06-10
category: ui-bugs
module: packages/dashboard/app/hooks/useViewportMode
problem_type: ui_bug
component: frontend_responsive_layout
symptoms:
  - "Opening the virtual keyboard on a tablet shrinks CSS/visual viewport height below the mobile height breakpoint"
  - "Dashboard shell snaps from tablet/desktop layout into mobile layout while typing, then snaps back when the keyboard closes"
  - "Downstream surfaces such as ChatView sidebars, Board stabilization, WorkflowNodeEditor, and SessionTerminal inherit the wrong mobile mode"
root_cause: responsive_breakpoint
resolution_type: code_fix
severity: medium
related_components:
  - packages/dashboard/app/components/Board.tsx
  - packages/dashboard/app/components/WorkflowNodeEditor.tsx
  - packages/dashboard/app/components/SessionTerminal.tsx
  - FN-6210
tags:
  - viewport-mode
  - virtual-keyboard
  - responsive-layout
  - tablet
  - mobile-breakpoint
  - visualviewport
---

# Tablet keyboard viewport mode flip

## Problem

`MOBILE_MEDIA_QUERY` intentionally includes `(max-height: 480px)` so landscape phones remain in mobile mode even when their CSS width exceeds `768px`. On tablets and desktops, however, opening a virtual keyboard can shrink the CSS viewport height (and iOS `visualViewport.height`) below `480px` without changing the physical device size. Any code that treated the height clause alone as mobile caused the dashboard shell and responsive consumers to flip into mobile layout while the user typed.

## Solution

Keep the exported `MOBILE_MEDIA_QUERY` string unchanged for listener compatibility, but route runtime mobile decisions through `isMobileViewport()`:

- `(max-width: 768px)` still resolves mobile directly.
- `(max-height: 480px)` resolves mobile only when `window.screen` has a phone-class short edge (`Math.min(width, height) <= 480`).
- Missing/zero `window.screen` data fails safe to width-only detection.

This preserves landscape-phone behavior while preventing keyboard-driven height shrink from changing tablet/desktop viewport mode. Direct breakpoint consumers (`Board`, `WorkflowNodeEditor`, and `SessionTerminal`) should subscribe to `MOBILE_MEDIA_QUERY` for reactivity but recompute state with `isMobileViewport()` rather than reading `.matches` as the final decision.

ChatView also keeps a defense-in-depth CSS guard from FN-6210: `.chat-sidebar` has a non-mobile `max-width` matching `CHAT_SIDEBAR_MAX_WIDTH`, with the mobile media rule overriding it back to `100%`. That guard bounds the sidebar even if viewport-mode state is temporarily wrong and the inline sidebar width is removed.

FN-6516 refined the FN-6494 keyboard-open behavior: tablet chat sidebars remain visible at the user's current/persisted width while the software keyboard is open, rather than narrowing to the minimum width. Resize controls still stay disabled while typing, collapsed sidebars remain collapsed, and the FN-6210 `max-width` CSS guard remains the upper bound.

## Regression coverage

Cover the invariant rather than the single repro:

- Tablet-class physical screen with short viewport height stays `tablet`.
- Desktop-class physical screen with short viewport height stays `desktop`.
- Landscape phone with phone-class physical screen and short viewport stays `mobile`.
- Portrait phone width stays `mobile` regardless of height.
- Undefined/zero `window.screen` does not throw and falls back to width-only detection.
- Component-local mobile hooks such as `SessionTerminal` also use the guarded predicate.
- ChatView sidebar CSS remains bounded at the sidebar max width during simulated viewport-mode flicker while the keyboard is open.
