---
title: "Mobile terminal renders blank: global `* { max-width: 100% }` collapses xterm's char measurement"
date: 2026-07-08
category: ui-bugs
module: packages/dashboard/app/styles.css
problem_type: rendering
component: embedded_terminal
applies_when: "The standalone (TerminalModal) or task-session (SessionTerminal) terminal shows nothing on mobile even though the WebSocket says Connected and the prompt has arrived."
symptoms:
  - "Mobile terminal is blank after opening; desktop renders fine"
  - "Header shows Connected; no prompt text is visible"
  - ".xterm-screen has style width:0px;height:0px while the .xterm container has a real size"
  - ".xterm-char-measure-element measures 0px width even though an identical monospace span measures ~295px"
root_cause: mobile_universal_max_width_100pct_caps_xterm_char_measure_element_at_zero
resolution_type: css_exemption
severity: high
related_components:
  - packages/dashboard/app/styles.css
  - packages/dashboard/app/components/TerminalModal.tsx
  - packages/dashboard/app/components/SessionTerminal.tsx
tags: [terminal, xterm, mobile, css, max-width, char-size, blank-screen, fn-7620, fn-7686, fn-7693]
---

# Mobile terminal renders blank: universal `max-width: 100%` collapses xterm's character measurement

## Problem

On the mobile terminal layout the terminal opens, the WebSocket connects, the shell prompt data
streams in and is written into xterm's row DOM — but the terminal is visibly blank. It is NOT a
network, PTY, or login-shell latency problem (measured live: `POST /terminal/sessions` 3ms, WS first
prompt bytes ~215ms, desktop renders <1s).

## Root cause

`styles.css` has a global mobile reset to prevent horizontal overflow:

```css
@media (max-width: 768px) {
  * { max-width: 100%; max-inline-size: 100%; }
}
```

This universal `* { max-width: 100% }` also matches xterm's hidden character-measurement subtree —
`.xterm-helpers` and its `.xterm-char-measure-element`. That subtree's containing block
(`.xterm-helpers`) is a 0x0 absolutely-positioned box, so `max-width: 100%` resolves to **`max-width:
0`** and hard-caps the measurement element at 0 width. xterm's `CharSizeService` therefore reads a
0-width character cell, `FitAddon.proposeDimensions()` yields 0 columns/rows, and `.xterm-screen` (plus
the WebGL renderer canvas) collapses to **0x0** — the prompt is painted into a zero-size box.

Reproduced live via mobile emulation: `.xterm-char-measure-element` measured 0 while an identical
monospace span in the same `.xterm` container measured ~295px; setting `max-width: none` on the measure
element immediately restored ~295px, and reopening the terminal with the exemption active rendered the
prompt with `.xterm-screen` sized 369x760.

The bug is **mobile-only** because the reset is inside a `max-width: 768px` media query — which is
exactly why the terminal renders fine at desktop widths.

### Why prior remeasure-based attempts failed

FN-7620/FN-7686 (and an initial FN-7693 attempt) tried to force xterm to remeasure/refit after mount.
That can never work here: the CSS re-caps the measurement element to 0 width on **every** remeasure, so
a resize, a font-size change, and a forced `CharSizeService` remeasure all still read 0. The fix must
remove the CSS cap, not re-run the measurement.

## Fix

Exempt xterm's measurement subtree from the mobile universal reset (in the same `@media` block in
`styles.css`):

```css
.xterm-helpers,
.xterm-helpers *,
.xterm-char-measure-element {
  max-width: none !important;
  max-inline-size: none !important;
}
```

`.xterm-helpers` is xterm's own class, so this covers both terminal surfaces (TerminalModal and
SessionTerminal) without per-component changes.

## Verification

- Live: with the exemption active, `.xterm-char-measure-element` measures ~295px (was 0) and
  `.xterm-screen` gets a real width (was 0x0), rendering the prompt on the mobile viewport.
- Physical-device note: root cause and fix were reproduced/validated in the automation browser via
  mobile emulation (393px, iPhone UA, forced touch), not a physical iPhone. Confirm on a real device
  when possible.
