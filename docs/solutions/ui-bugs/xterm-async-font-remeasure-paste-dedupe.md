---
title: "xterm async font remeasure and native paste"
date: 2026-06-13
category: ui-bugs
module: packages/dashboard/app/components/TerminalModal
problem_type: ui_bug
component: frontend_terminal
applies_when: "An xterm.js terminal opens before its web font finishes loading, or a custom paste shortcut competes with xterm's helper textarea paste path."
symptoms:
  - "Terminal glyphs render with oversized inter-character spacing after a font-display: swap web font loads"
  - "Cmd/Ctrl+V paste sends the same payload to the PTY twice"
root_cause: xterm_opened_with_fallback_font_metrics_and_duplicate_clipboard_delivery
resolution_type: code_fix
severity: high
related_components:
  - packages/dashboard/app/components/TerminalModal.tsx
  - packages/dashboard/app/components/TerminalModal.css
  - packages/dashboard/app/components/SessionTerminal.tsx
  - packages/dashboard/app/components/SessionTerminal.css
  - packages/dashboard/app/utils/terminalPreferences.ts
  - packages/dashboard/app/components/__tests__/TerminalModal.test.tsx
  - packages/dashboard/app/components/__tests__/SessionTerminal.test.tsx
  - packages/dashboard/app/__tests__/terminal-input.test.ts
  - FN-6390
  - FN-6638
tags:
  - xterm
  - font-loading
  - font-display-swap
  - clipboard
  - paste
  - mobile-safari
---

# xterm async font remeasure and native paste

## Problem

xterm.js measures character-cell geometry when `terminal.open()` runs. If a custom web font is declared with `font-display: swap`, a cold load can let xterm cache fallback-font metrics and then swap to the real font later. The renderer may keep the stale cell width, producing widely spaced glyphs on mobile/DOM-renderer surfaces.

FN-6638 was the fourth recurrence of the mobile wide-cell defect (FN-6390 → FN-6424 → FN-6603 → FN-6638). The FN-6603 font-stack ordering hypothesis was ruled out: the supplied diagnostic measured `66.76px for AGENTS.md` identically for symbols-first, symbols-last, and system-mono stacks, and desktop/mobile-emulated WebKit rendered ASCII tightly while a real iOS Safari screenshot still showed `A G E N T S . m d`. Treat Playwright/desktop WebKit emulation as a blind spot for this class; it can prove CSS contracts and fallback paths but cannot be the acceptance surface.

The recurrence path was stricter real-iOS font/text measurement behavior. A long `document.fonts.load(`${fontSize}px ${resolvedFontFamily}`)` shorthand can reject on iOS WebKit; returning from that catch prevented xterm from reapplying `fontFamily`/`fontSize`, running `fitAddon.fit()`, publishing resize, and refreshing rows. Separately, the xterm measurement subtree lacked `-webkit-text-size-adjust: 100%`, allowing iOS Safari text inflation to perturb cell metrics.

A second pitfall is custom paste handling. If an `attachCustomKeyEventHandler` Cmd/Ctrl+V branch reads `navigator.clipboard.readText()` and forwards that text to the PTY while the browser also performs the native paste into xterm's helper textarea, the same payload reaches `terminal.onData` and is sent twice.

## Solution

Keep one canonical paste path and remeasure after font resolution.

- Prefer xterm's native helper-textarea paste for Cmd/Ctrl+V; return `true` from the custom key handler so the browser/xterm path runs, and do not read/send clipboard text manually.
- Preserve custom copy behavior only for selected text, where suppressing terminal input is intentional.
- After `terminal.open()`, treat FontFaceSet loading as best-effort: try the full stack, fall back to concrete individual families only if the full shorthand rejects, await `document.fonts.ready`, and never let an iOS shorthand rejection skip the later remeasure.
- Guard async remeasure work with the expected session id and current terminal/addon refs so stale font-load promises cannot mutate a disposed or switched terminal.
- Reapply font options, run `fitAddon.fit()`, publish the resized cols/rows, and refresh visible rows once the FontFaceSet has settled.
- Pin `-webkit-text-size-adjust: 100%` / `text-size-adjust: 100%` on the xterm host subtree (`.terminal-xterm` and `.cli-session-terminal__viewport`) so iOS Safari cannot inflate DOM/canvas measurement nodes.

`SessionTerminal` is unaffected by paste duplication because it does not install a custom paste handler; native xterm paste is its only input path. It is affected by the font/cell-measurement invariant because it constructs xterm with the same user-selectable font presets and mobile DOM/canvas renderer path, so it must share both the best-effort font-load remeasure and the text-size-adjust pin.

## Regression coverage

Cover the invariant across terminal surfaces and input paths:

- Keyboard paste on macOS (`metaKey`) and non-mac (`ctrlKey`) returns `true`, does not call `clipboard.readText()`, and sends exactly one PTY input frame via xterm `onData`.
- Native helper-textarea paste without the shortcut handler sends exactly once, covering mobile/iOS context-menu paste.
- A controlled `document.fonts.load()` promise resolving after `terminal.open()` triggers a post-font-load fit, resize, and refresh.
- A controlled `document.fonts.load()` rejection (the real-iOS shorthand failure mode) still triggers font option reapply, fit/resize, and refresh for both `TerminalModal` and `SessionTerminal`.
- CSS contract tests assert both xterm host subtrees pin `text-size-adjust` to 100%.
- `SessionTerminal` asserts it uses the shared terminal font presets, does not attach a custom key handler, and sends one native xterm paste input frame.

This avoids downstream byte de-duplication and fixes the two root causes at their renderer/input seams.
