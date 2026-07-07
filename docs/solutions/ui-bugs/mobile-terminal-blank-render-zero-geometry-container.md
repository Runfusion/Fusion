---
title: "Mobile terminal renders nothing when the xterm container's own box is unwatched"
date: 2026-07-06
category: ui-bugs
module: packages/dashboard/app/components/TerminalModal
problem_type: ui_bug
component: frontend_terminal
applies_when: "A terminal/xterm surface is opened inside a container whose real box may be zero (or otherwise not yet settled) at the moment `terminal.open()`/`fitAddon.fit()` first runs, and no observer watches that CONTAINER element's own geometry independently of any ancestor."
symptoms:
  - "The mobile terminal opens to a totally blank surface: no prompt, no output, no rows — a different, more severe failure than visible-but-mis-spaced ASCII."
  - "The blank render happens on the INITIAL layout (keyboard open or closed) and does not repair itself from a keyboard toggle, orientation change, reconnect, or manual refit — because none of those events touch the terminal container's own box."
  - "Desktop/docked/floating terminals are unaffected; only the mobile fullscreen shell (or any narrow/late-settling container) shows the blank symptom."
root_cause: real_fitaddon_proposedimensions_floors_to_a_degenerate_2x1_grid_on_a_zero_container_box_and_nothing_watched_the_container_itself_to_recover
resolution_type: code_fix
severity: high
related_components:
  - packages/dashboard/app/components/TerminalModal.tsx
  - packages/dashboard/app/components/SessionTerminal.tsx
  - packages/dashboard/app/components/__tests__/TerminalModal.test.tsx
  - packages/dashboard/app/components/__tests__/SessionTerminal.test.tsx
  - FN-7620
tags:
  - xterm
  - fitaddon
  - resize-observer
  - mobile-safari
  - blank-render
  - geometry
---

# Mobile terminal renders nothing when the xterm container's own box is unwatched

## Problem

FN-7620 reported the mobile dashboard terminal opening to a completely blank surface — no prompt, no scrollback, no rows. This is a DIFFERENT failure class than the FN-7456→FN-7603 inter-character-spacing family (`xterm-options-noop-remeasure-after-font-settle.md`), which always rendered visible-but-mis-spaced ASCII. Here nothing renders at all.

### The actual mechanism

Real `@xterm/addon-fit@0.10.0`'s `FitAddon.proposeDimensions()` reads `getComputedStyle(terminal.element.parentElement)` height/width (the xterm container, i.e. `TerminalModal`'s `terminalRef` div):

```js
proposeDimensions() {
  ...
  const o = parseInt(computedStyle(parentElement).height);
  const s = Math.max(0, parseInt(computedStyle(parentElement).width));
  ...
  return {
    cols: Math.max(2, Math.floor(availableWidth / cellWidth)),
    rows: Math.max(1, Math.floor(availableHeight / cellHeight)),
  };
}
```

Crucially, this does **not** bail out on a zero box — it floors to a degenerate `{cols: 2, rows: 1}` grid. If the container's real box is genuinely `0` at the moment of the first post-open `fitAddon.fit()` (plausible on a real mobile device on the very first paint — the mobile fullscreen `.terminal-modal--mobile` + `[style*="--keyboard-overlap"]` height cascade, `100dvh` support, or general layout/font settle can all delay the container's real box by a frame or more), xterm silently resizes to a near-invisible 2×1 grid clipped inside a container whose own box is *also* still ~0px — visually indistinguishable from "nothing renders".

The defect that made this **permanent** (not a one-frame flicker): only the OUTER MODAL (`modalRef`) had a `ResizeObserver`. A modal already sized to `100dvh`/the keyboard-constrained box does not re-fire that observer when only *inner* content (the xterm container) later settles to its real size — nothing else watched the container (`terminalRef`) itself. The prior "one opportunistic deferred re-fit" (added 2026-06-22 for the FN-7461 fold-transition spacing fix) only recovers if `clientWidth > 0` at the SINGLE scheduled rAF check; if the container is still zero at that moment, no later trigger ever re-measures it, and the terminal stays a degenerate grid forever — matching the report that no reconnect/orientation/keyboard-toggle/manual refit repaired it.

## Why this survived FN-7456→FN-7603

Every prior fix in this subsystem targeted the CHARACTER-measurement pipeline (font metrics, DOM-vs-Canvas divergence) — none of them touched CONTAINER-level geometry observation. A total blank render is a fundamentally different failure surface (container box, not glyph metrics) and none of the prior regressions modeled a zero/degenerate container box at all.

`SessionTerminal.tsx` (the sibling embedded CLI-agent terminal) never had this defect: it already attaches `resizeObserver.observe(containerRef.current)` directly on its own xterm container right after init.

## Fix

Add a persistent `ResizeObserver` directly on the xterm CONTAINER element (`terminalRef.current`), established for the life of each xterm instance and re-established whenever the container remounts (tab switch uses `key={activeTab?.sessionId}` on the container div), calling the existing `fitAndResizeForSession(sessionId)` on any change to the container's OWN box:

```tsx
// packages/dashboard/app/components/TerminalModal.tsx
useEffect(() => {
  if (!isOpen) return;
  const node = terminalRef.current;
  if (!node || typeof ResizeObserver === "undefined") return;

  let pendingFrame: number | null = null;
  const observer = new ResizeObserver(() => {
    if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = null;
      const sessionId =
        typeof xtermInitializedRef.current === "string" ? xtermInitializedRef.current : undefined;
      fitAndResizeForSession(sessionId);
    });
  });
  observer.observe(node);

  return () => {
    observer.disconnect();
    if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
  };
}, [fitAndResizeForSession, isOpen, activeTab?.sessionId]);
```

This mirrors the pattern `SessionTerminal.tsx` already uses. Per the ResizeObserver spec, an initial notification fires shortly after `observe()` is called even if the box hasn't changed since — so this also catches the very first zero-to-real transition, not just later changes. No arbitrary frame-polling loop, timeout, hardcoded cell/column count, or disabling of the mobile fullscreen path is used.

Do not:

- Replace this with a fixed cell/column count or an arbitrary mobile-only min-height — that masks the symptom instead of fixing the missing observation.
- Assume the outer modal's `ResizeObserver` is sufficient — it is not, because the modal's own box can stay constant (`100dvh`) while only the container's box changes.
- Gate this fix to mobile only — it is a general container-geometry gap; desktop/docked/floating benefit from the same additive fix with no observed regression.

## Regression coverage (rendered geometry, not init/fit call presence)

jsdom cannot exercise real CSS layout, so the regression models the exact mechanism directly:

- Override the xterm container's (`data-testid="terminal-xterm"`) `clientWidth`/`clientHeight` getters to report `0` at the moment of the first post-open fit, then flip them to a real, stable nonzero box a moment later — with NO reconnect/orientation/keyboard-toggle/manual-refit call.
- Swap the shared `FitAddon.fit()` mock's implementation (scoped to this describe block only) for a variant that mirrors real `proposeDimensions()`'s degenerate-floor formula (`Math.max(2, floor(width/cellWidth))` / `Math.max(1, floor(height/cellHeight))`) against the REAL container element, instead of the fixed-width mock the spacing-family tests use.
- Capture every `new ResizeObserver(cb)` instance/target via a `MockResizeObserver`, then fire the SAME notification a real browser delivers for the container element specifically — this is the decisive step: pre-fix, no ResizeObserver is ever attached to `terminal-xterm` (only the modal), so this assertion fails outright; post-fix it recovers to a real, non-degenerate grid.
- Covers keyboard-CLOSED and keyboard-OPEN initial layouts, tab-switch remount (the container's `key={sessionId}` swap must re-target the new node), and duplicate/rapid resize notification coalescing.
- `SessionTerminal.tsx` gets a parallel regression proving it already has (and keeps) this same container-level observer.
- Run: `pnpm --filter @fusion/dashboard exec vitest run app/components/__tests__/TerminalModal.test.tsx app/components/__tests__/SessionTerminal.test.tsx app/components/__tests__/SessionTerminal.mobile.test.tsx --silent=passed-only --reporter=dot`.
- Real mobile Safari/Chrome sanity check remains the strongest signal for this class of bug; a real-device screenshot was not obtainable in this execution environment (headless coding agent, no physical device access) — this gap is recorded explicitly (task document key="repro" on FN-7620) rather than treating jsdom/desktop WebKit as proof. See `docs/ios-acceptance.md`.
