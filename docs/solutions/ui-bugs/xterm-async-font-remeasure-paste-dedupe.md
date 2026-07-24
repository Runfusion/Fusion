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
  - FN-7460
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

The recurrence path was stricter real-iOS font/text measurement behavior. A long `document.fonts.load(`${fontSize}px ${resolvedFontFamily}`)` shorthand can reject on iOS WebKit; returning from that catch prevented xterm from reapplying `fontFamily`/`fontSize`, running `fitAddon.fit()`, publishing resize, and refreshing rows. Separately, the xterm measurement subtree must disable WebKit text-size adjustment entirely. FN-7460 reopened the issue after the 100% pin still let a real iPhone Safari keyboard-open 12px terminal render prompt and ASCII segments with excessive inter-character spacing.

A second pitfall is custom paste handling. If an `attachCustomKeyEventHandler` Cmd/Ctrl+V branch reads `navigator.clipboard.readText()` and forwards that text to the PTY while the browser also performs the native paste into xterm's helper textarea, the same payload reaches `terminal.onData` and is sent twice.

**Paste history (superseded twice — read this before touching the paste branch):**

1. This doc originally prescribed "prefer native paste, return `true`, never read the clipboard manually."
2. GitHub #1902 (2026-07-04) reversed that: relying only on helper-textarea paste swallowed physical Ctrl/Cmd+V in some environments, so TerminalModal switched to a custom `navigator.clipboard.readText()` path returning `false`.
3. GitHub #2121/#2307 review (2026-07-23) found the custom path double-delivered and hardened it. The CURRENT contract is below; following the original prescription verbatim would reintroduce the #1902 swallow, and following #1902's version verbatim reintroduces the double paste.

Hard-won xterm 5.5.0 facts (verified against `@xterm/xterm` source during the 2026-07-23 fix):

- Returning `false` from `attachCustomKeyEventHandler` skips xterm's key handling but does NOT cancel the browser's default action — the default paste still fires xterm's helper-textarea `paste` listener.
- Returning `true` for Ctrl+V on non-mac lets xterm's `_keyDown` convert it into a `\x16` (SYN) data event sent to the PTY AND `cancel(event)` the browser paste — never return `true` for paste.
- xterm's `handlePasteEvent` calls `stopPropagation()` but NOT `preventDefault()`, and the same paste handler is registered on both the helper textarea and the root element.

## Solution

Current Cmd/Ctrl+V contract in `TerminalModal.tsx` (single delivery on every path):

- **Async clipboard available (secure context):** call `event.preventDefault()` (otherwise the browser's default paste double-delivers via the helper textarea), read via `navigator.clipboard.readText()`, and deliver through `terminal.paste(text)` — never raw `sendInput` — so bracketed-paste wrapping and `\n`→`\r` normalization apply. Return `false`.
- **Async clipboard missing (non-HTTPS remote, older Firefox) or a prior read was permission-denied (sticky `clipboardReadBlockedRef`):** return `false` WITHOUT `preventDefault()` — xterm skips its key handling and the un-prevented native paste delivers exactly once through the helper textarea.
- **`readText()` rejection** sets the sticky blocked ref so every subsequent Ctrl/Cmd+V uses the native path; at most one paste (at denial time) is lost.
- Preserve custom copy behavior only for selected text, where suppressing terminal input is intentional.
- After `terminal.open()`, treat FontFaceSet loading as best-effort: try the full stack, fall back to concrete individual families only if the full shorthand rejects, await `document.fonts.ready`, and never let an iOS shorthand rejection skip the later remeasure.
- Guard async remeasure work with the expected session id and current terminal/addon refs so stale font-load promises cannot mutate a disposed or switched terminal.
- Reapply font options, run `fitAddon.fit()`, publish the resized cols/rows, and refresh visible rows once the FontFaceSet has settled.
- Disable `-webkit-text-size-adjust` / `text-size-adjust` on the xterm host subtree (`.terminal-xterm` and `.cli-session-terminal__viewport`) so iOS Safari cannot inflate DOM/canvas measurement nodes while xterm still honors the user's exact 10px/12px terminal font preference.

`SessionTerminal` is unaffected by paste duplication because it does not install a custom paste handler; native xterm paste is its only input path. It is affected by the font/cell-measurement invariant because it constructs xterm with the same user-selectable font presets and mobile DOM/canvas renderer path, so it must share both the best-effort font-load remeasure and the text-size-adjust pin.

## Regression coverage

Cover the invariant across terminal surfaces and input paths:

- Keyboard paste on macOS (`metaKey`) and non-mac (`ctrlKey`) with clipboard available: returns `false`, preventDefaults, calls `clipboard.readText()` once, and delivers exactly once via `terminal.paste()` (no direct `sendInput`).
- Clipboard API missing (undefined `navigator.clipboard` or no `readText`): returns `false` with `defaultPrevented === false` so the native helper-textarea paste is the single delivery path.
- After a `readText()` permission denial, the NEXT Ctrl/Cmd+V returns `false` with no `preventDefault` and no further `readText()` call (sticky denial → native path).
- Native helper-textarea paste without the shortcut handler sends exactly once, covering mobile/iOS context-menu paste.
- A controlled `document.fonts.load()` promise resolving after `terminal.open()` triggers a post-font-load fit, resize, and refresh.
- A controlled `document.fonts.load()` rejection (the real-iOS shorthand failure mode) still triggers font option reapply, fit/resize, and refresh for both `TerminalModal` and `SessionTerminal`.
- CSS contract tests assert both xterm host subtrees disable `text-size-adjust` for exact xterm cell metrics.
- `SessionTerminal` asserts it uses the shared terminal font presets, does not attach a custom key handler, and sends one native xterm paste input frame.

This avoids downstream byte de-duplication and fixes the two root causes at their renderer/input seams.
