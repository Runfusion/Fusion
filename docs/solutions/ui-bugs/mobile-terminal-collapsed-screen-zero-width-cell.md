---
title: "Mobile terminal renders blank because xterm's screen collapses to 0x0"
date: 2026-07-08
category: ui-bugs
module: packages/dashboard/app/utils/terminalPreferences.ts
problem_type: rendering
component: embedded_terminal
applies_when: "The standalone (TerminalModal) or task-session (SessionTerminal) terminal shows nothing on mobile even though the WebSocket says Connected and the prompt has arrived."
symptoms:
  - "Mobile terminal is blank for many seconds (or indefinitely) after opening"
  - "Header shows Connected; no prompt text is visible"
  - ".xterm-screen has style width:0px;height:0px while the .xterm container has a real size"
root_cause: xterm_charsize_service_measured_zero_width_cell_on_mobile_layout
resolution_type: measurement_validity_guard
severity: high
related_components:
  - packages/dashboard/app/components/TerminalModal.tsx
  - packages/dashboard/app/components/SessionTerminal.tsx
tags: [terminal, xterm, mobile, fit-addon, char-size, blank-screen, fn-7620, fn-7686, fn-7692]
---

# Mobile terminal renders blank: xterm screen collapses to 0x0

## Problem

On the mobile fullscreen terminal layout the terminal opens, the WebSocket connects, the shell prompt
data streams in and is written into xterm's row DOM — but the terminal is visibly blank. It is NOT a
network, PTY, or login-shell latency problem (measured live: `POST /terminal/sessions` 3ms, WS first
prompt bytes ~215ms, desktop renders <1s).

## Root cause

`terminal.open()` + `FitAddon.fit()` can run while xterm's `CharSizeService` resolves the character
cell to **0 width**. `FitAddon.proposeDimensions()` then yields 0 columns/rows and `.xterm-screen`
(and, on desktop, the WebGL renderer canvas) collapses to **0x0**. The prompt is painted into a
zero-size box, so it is invisible. Reproduced live via mobile emulation: the `.xterm` container
measured 385x758 while `.xterm-screen` stayed `width:0px;height:0px` and xterm's own
`.xterm-char-measure-element` read 0 — while an identical monospace span in the same container measured
~295px. So the correct measurement is achievable and xterm is holding a stale 0.

The bug is:

- **Renderer-independent** — reproduced on both the DOM renderer (touch/mobile) and the WebGL renderer.
- **Mobile-layout-specific** — desktop widths render immediately.
- **Not self-healing** — a `window.resize` and a font-size change both re-fit but do not recover, because
  every prior guard validates the *container* width (`clientWidth > 0`) and font load
  (`waitForTerminalFontMetrics`), never the *resulting* measured screen/cell width, and a single 0
  measurement is cached and never re-validated.

## Fix

`guardAgainstCollapsedTerminalScreen(container, terminal, fit, fontFamily)` in
`app/utils/terminalPreferences.ts`, armed by both TerminalModal and SessionTerminal right after their
initial fit:

- Detects the collapsed state: container has a width but `.xterm-screen` does not
  (`isTerminalScreenCollapsed`).
- Forces a genuine `CharSizeService` remeasure via `withDomBasedTerminalCharacterMeasurement(() =>
  forceTerminalFontRemeasure(...))` followed by `fit()`.
- Re-driven by a `ResizeObserver` so it re-attempts exactly when the mobile modal/keyboard geometry
  finally settles (it waits, rather than giving up, while the container itself is not yet measurable).
- Bounded by `maxAttempts` so it never spins, and a no-op once the screen has a non-zero width.
- Tied to the xterm instance lifetime — disposed on every re-init/close/reinitialize path.

## Verification

- Unit tests in `app/utils/__tests__/terminalPreferences.test.ts`
  (describe "guardAgainstCollapsedTerminalScreen"): classifies collapse only when the container is
  measurable; forces remeasure+fit and stops once the screen reports a width; waits while the container
  is not yet measurable and recovers on the ResizeObserver relayout; stays bounded when the screen never
  recovers; no-op when already healthy.
- Physical-device note: the root cause and DOM signature were reproduced in the automation browser via
  mobile emulation (393px, iPhone UA, forced touch), not a physical iPhone. Confirm on a real device
  when possible.
