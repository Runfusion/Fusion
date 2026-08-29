---
title: "Mobile touch-action ancestor-chain intersection defeats a correct leaf scroll rule"
date: 2026-07-06
category: ui-bugs
module: packages/dashboard/app/components/TerminalModal.css
problem_type: ui_bug
component: frontend_css
symptoms:
  - "A flex row with overflow-x: auto, min-width: 0, flex-wrap: nowrap, and touch-action: pan-x still does not scroll horizontally on a real mobile touch device"
  - "Leaf-rule string-match tests (regex over the component's own CSS) stay green across multiple 'fixes' while the real symptom persists"
root_cause: mobile_touch_action_ancestor_intersection
resolution_type: code_fix
severity: medium
related_components:
  - packages/dashboard/app/styles.css
  - packages/dashboard/app/components/TerminalModal.tsx
  - packages/dashboard/app/components/__tests__/TerminalModal.test.tsx
tags:
  - mobile-terminal
  - touch-action
  - css-cascade
  - scroll-containment
  - css-regression-test
applies_when:
  - "A component-local horizontal (or vertical) scroll region sets its own touch-action but is nested inside a global mobile touch-action lockdown (e.g. `* { touch-action: pan-y }` to stop page-level pinch-zoom/rubber-band)"
  - "The leaf element's own touch-action is verified via computed style or rule-text match, but its ancestor chain up to html/body is not"
---

# Mobile touch-action ancestor-chain intersection defeats a correct leaf scroll rule

## Problem (FN-7621, recurrence #3)

The terminal's mobile shortcut bar (`.terminal-shortcut-panel`) was fixed twice (FN-7550, FN-7560) for "does not scroll horizontally on mobile", and both fixes landed a leaf-rule string-match regression test that stayed green. The bug still reproduced on real mobile devices on the third report.

FN-7550/FN-7560 only ever verified the PANEL's own CSS text (`min-width: 0;`, `overflow-x: auto;`, `flex-wrap: nowrap;`, `touch-action: pan-x;`) — all of which were, in fact, correct. The actual defect lived in a completely different file: `styles.css`'s `@media (max-width: 768px)` mobile lockdown resets `touch-action: pan-y` on the universal selector (`* { touch-action: pan-y; }`, to stop pinch-zoom/rubber-band) and then explicitly restates `pan-y` on `#root`, `html`, `body`, and `.modal-overlay:not(.confirm-dialog-overlay)` (the cross-cutting "full-screen modal on mobile" rule, which matches the terminal's own overlay).

## Root cause

`touch-action`'s *used value* for a touch gesture is the **intersection** of the touched element's computed value and every ancestor's computed value along the DOM chain up to the document root — not just the touched element's own value. A leaf element can correctly compute `touch-action: pan-x` and still have horizontal panning fully blocked if ANY ancestor between it and `<html>` resolves to `pan-y` (or `none`), because the browser intersects the allowed axes at every level.

This codebase already has a working example of the fix pattern: `.board` is the *only* element deliberately "opted back into" `touch-action: pan-x pan-y` inside the SAME mobile lockdown block in `styles.css` (see the comment "the board is the only always-present horizontal scroller on mobile ... opt known horizontal scrollers back into pan-x below"). Any OTHER component that adds its own horizontal (or vertical) scroll region on mobile must be added to that same carve-out convention — giving the leaf element `touch-action: pan-x` in its own component CSS file is necessary but not sufficient.

## Why the leaf-rule tests missed it

- FN-7550/FN-7560's regression tests used `terminalModalCss.match(/\.terminal-shortcut-panel\s*\{([^}]*)\}/)` — a regex over ONE file's rule text. They could never see `styles.css`'s cross-cutting mobile lockdown, because they never looked at it.
- Even a `getComputedStyle`-based test that only inspects the panel itself (not its ancestors) would still pass while the bug is present, because the panel's OWN resolved `touch-action` value is genuinely `pan-x` — the defeat happens at the ANCESTOR level via gesture-handling intersection, not via cascade override on the panel.

## Solution

1. Reproduce with a real-CSS layout test: load all app CSS (`loadAllAppCss()`) into a `<style>` element, render the component at a mobile viewport, and resolve `getComputedStyle` for the scrollable leaf AND every ancestor up to (at minimum) the portal root / overlay. Assert every ancestor's `touch-action` still allows the needed axis.
2. Fix at the ancestor(s), not the leaf: add `touch-action: pan-x pan-y` (matching the existing `.board`/`pre`/`code`/`table` carve-out pattern) to the specific ancestor selectors that the mobile lockdown targets — in this case `.modal-overlay.terminal-modal-overlay` and `.modal.terminal-modal(.terminal-modal--mobile)` in `TerminalModal.css` (higher specificity than the universal `*` reset, so it applies regardless of stylesheet order).
3. Do NOT loosen `html`/`body`/`#root`/the generic `.modal-overlay:not(.confirm-dialog-overlay)` rule — that page-level lock is intentional (prevents page-level horizontal rubber-band/pinch-zoom) and other modals rely on it. Only carve out the SPECIFIC component that needs the exception.
4. Keep the leaf-rule string tests as a cheap floor (they still catch accidental leaf regressions), but they are NOT sufficient acceptance on their own — the computed-style ancestor-chain test is the real gate.

## Regression coverage

`packages/dashboard/app/components/__tests__/TerminalModal.test.tsx` → `describe("real-CSS mobile cascade (FN-7621 recurrence #3)")` resolves `getComputedStyle` for the panel plus its `.terminal-modal` and `.modal-overlay` ancestors, at both mobile fullscreen and the `--keyboard-overlap` narrowed-visual-viewport variant, and asserts `touchAction` allows `pan-x` end-to-end. Confirmed to fail on the pre-fix tree and pass post-fix.
