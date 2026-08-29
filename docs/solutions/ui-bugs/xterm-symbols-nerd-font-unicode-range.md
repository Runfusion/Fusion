---
title: "xterm symbols Nerd Font unicode-range scoping"
date: 2026-06-13
category: ui-bugs
module: packages/dashboard/app/components/TerminalModal
problem_type: ui_bug
component: frontend_terminal
applies_when: "A symbols-only Nerd Font is listed in an xterm.js fontFamily stack with font-display: swap."
symptoms:
  - "Terminal glyphs render with oversized inter-character spacing after the symbols font loads"
  - "Mobile DOM/canvas xterm output wraps after very few columns even for ASCII commands"
  - "Powerline prompt glyphs are needed, but ASCII must measure against a real monospace text font"
root_cause: symbols_only_font_face_participated_in_ios_xterm_ascii_cell_measurement_even_when_unicode_range_scoped
resolution_type: code_fix
severity: high
related_components:
  - packages/dashboard/app/components/TerminalModal.css
  - packages/dashboard/app/components/SessionTerminal.css
  - packages/dashboard/app/components/TerminalModal.tsx
  - packages/dashboard/app/components/SessionTerminal.tsx
  - packages/dashboard/app/__tests__/terminal-input.test.ts
  - FN-6390
  - FN-6424
  - FN-6603
  - FN-6638
  - FN-6659
  - FN-6811
tags:
  - xterm
  - font-loading
  - font-display-swap
  - unicode-range
  - nerd-font
  - mobile-safari
---

# xterm symbols Nerd Font unicode-range scoping

## Problem

A symbols-only Nerd Font can corrupt xterm.js cell measurement when it participates in the terminal `fontFamily` stack. FN-6390 correctly added an async post-font-load remeasure, but FN-6424 found the recurrence: the browser could still measure ASCII cells against `SymbolsNerdFontMono` after `font-display: swap`, producing huge gaps such as `p n p m  b u i l d` on mobile.

FN-6603 found the third recurrence: the FN-6390 remeasure and FN-6424 `unicode-range` were both present, but the shared terminal preference stack still listed the symbols face first. Mobile WebKit/xterm canvas measurement could still use that first face for cell metrics while actual ASCII glyph rendering fell through to a later monospace font. The visible symptom was the same wide-cell layout (`A G E N T S . m d`) with intact powerline glyphs.

FN-6638 then added a `text-size-adjust: 100%` pin plus best-effort `document.fonts` settlement and unconditional xterm option reapply/fit/refresh. That recurrence's diagnostic measured `66.76px for AGENTS.md` across symbols-first, symbols-last, and system-mono stacks and was initially read as "font-stack ordering is inert." FN-6659 corrected that reading: all three diagnostic stacks were still symbols-inclusive because every preset appended `"Fusion Terminal Nerd Font Symbols"`, and that symbols face was the only bundled/loaded terminal `@font-face`. Playwright/desktop WebKit emulation and the unfinished real-iOS acceptance gate let four blind fixes ship despite the real iOS Safari symptom remaining.

FN-6811 found recurrence #6 in the attach/session terminal surface. `SessionTerminal` is code-split with its own `SessionTerminal.css`, so it could render without the scoped symbols `@font-face` owned by `TerminalModal.css`; tests mostly inspected combined CSS and did not prove each xterm surface owned the ASCII-excluding symbols face. The fix duplicated the scoped `@font-face` into `SessionTerminal.css`, made `resolveTerminalFontFamily()` defensively strip the symbols face from any xterm-measured stack, and added per-surface tests for modal and session terminals. Real-device iOS Safari verification remains an explicit gap for this recurrence; until it is run, rely only on the automated contract checks plus a documented manual/cloud-device pass before claiming the mobile symptom is closed.

## Solution

Keep the symbols font available for powerline/Nerd-Font codepoints, but do not let it participate in xterm's measured `fontFamily` option:

1. Scope its `@font-face` with `unicode-range` so printable ASCII is never resolved through that family during normal glyph fallback.
2. Keep `XTERM_FONT_FAMILY` and every terminal preset symbols-free. `resolveTerminalFontFamily()` should also defensively strip `"Fusion Terminal Nerd Font Symbols"` so a future preset edit cannot feed the symbols-only face into xterm measurement.
3. `TerminalModal` and `SessionTerminal` must pass only real text monospace stacks to `new Terminal(...)`, remeasure, and live-preference updates.
4. If a DOM-renderer symbols fallback is needed, attach it through a separate scoped CSS variable/rule for `.xterm-rows span` (for example `--terminal-glyph-font-family`) rather than the xterm option that drives ASCII cell measurement. Do not re-tune ordering: FN-6659 showed symbols-last was still unsafe on real iOS because the symbols face's mere presence polluted the measured shorthand.
5. Each code-split terminal CSS owner that exposes the DOM glyph fallback must define or import the scoped symbols face in that chunk. FN-6811 showed relying on `TerminalModal.css` alone leaks when `SessionTerminal.css` is loaded independently.

Use the standard Symbols Nerd Font ranges, including powerline and private-use blocks, for example:

```css
@font-face {
  font-family: "Fusion Terminal Nerd Font Symbols";
  src: url("/fonts/SymbolsNerdFontMono-Regular.ttf") format("truetype");
  font-display: swap;
  unicode-range: U+23FB-23FE, U+2665, U+26A1, U+2B58, U+E000-E00A, U+E0A0-E0D7, U+E200-E2A9, U+E300-E3E3, U+E5FA-E6B7, U+E700-E8EF, U+EA60-EC1E, U+ED00-F2FF, U+F300-F533, U+F0001-F1AF0;
}
```

Do not replace this with fixed `letterSpacing`, hardcoded column counts, or by removing the async remeasure. xterm should still refit after web fonts load; the measured xterm font stack must stay symbols-free so symbols-only metrics cannot apply to ASCII on real iOS Safari.

## Regression coverage

Automated jsdom tests cannot validate font advance widths, so cover the enforceable CSS contract and then run a real-browser check.

- Parse emitted/app CSS and assert the terminal symbols `@font-face` has a `unicode-range`.
- Assert the range contains required Nerd-Font/powerline blocks such as `U+E0A0-E0D7`, `U+E700-E8EF`, and `U+F0001-F1AF0`.
- Assert no range overlaps printable ASCII (`U+0020-007E`).
- Assert the shared default stack and every terminal font preset do **not** include `"Fusion Terminal Nerd Font Symbols"` in the xterm-measured family.
- Assert the retained symbols-rendering mechanism is separate from xterm measurement (for example CSS rules using `--terminal-glyph-font-family` on DOM row spans).
- Check every xterm consumer: `TerminalModal` and `SessionTerminal` both use `resolveTerminalFontFamily()`, so both need component-level coverage that the stack passed to `new Terminal(...)`, remeasure, and live preference updates is symbols-free.
- Check each code-split CSS owner independently (`TerminalModal.css` and `SessionTerminal.css`) for the scoped symbols `@font-face`; do not rely only on a combined app stylesheet scan.
- Verify on a real iOS Safari device/cloud path (not Playwright/desktop WebKit emulation) that ASCII output renders tightly while the powerline glyph still renders for the default `nerd-font` and `system-mono` presets on both `TerminalModal` and `SessionTerminal`. If the real-device pass is unavailable, record that as an explicit gap in the task/review notes rather than treating desktop WebKit or jsdom as proof.
