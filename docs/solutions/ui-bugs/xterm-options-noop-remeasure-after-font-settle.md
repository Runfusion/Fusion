---
title: "xterm OptionsService no-op reassignment silently skips post-load remeasure"
date: 2026-07-04
category: ui-bugs
module: packages/dashboard/app/components/TerminalModal
problem_type: ui_bug
component: frontend_terminal
applies_when: "Code reapplies an xterm.js Terminal option (fontFamily, fontSize, etc.) to a value that may already equal the terminal's current option value, expecting that reassignment to force an internal recompute (character measurement, renderer dimensions, letter-spacing compensation)."
symptoms:
  - "Mobile terminal text still renders with excessive inter-character spacing on the very first layout even after text-size-adjust is disabled and a document.fonts settle/remeasure step was already added"
  - "The spacing only 'repairs itself' after an unrelated event: toggling the virtual keyboard, rotating the device, reconnecting the session, or manually changing the font size and changing it back"
  - "Existing --keyboard-overlap/--vv-height/--vv-width/text-size-adjust: none assertions and a mocked resize(80, 24) all pass while the real-device symptom persists"
root_cause: xterm_optionsservice_setter_is_a_strict_noop_on_identical_values_so_reassigning_the_same_resolved_font_after_an_async_settle_never_fires_onoptionchange_and_never_forces_charsizeservice_domrenderer_remeasure
resolution_type: code_fix
severity: high
related_components:
  - packages/dashboard/app/components/TerminalModal.tsx
  - packages/dashboard/app/components/SessionTerminal.tsx
  - packages/dashboard/app/utils/terminalPreferences.ts
  - packages/dashboard/app/components/__tests__/TerminalModal.test.tsx
  - packages/dashboard/app/components/__tests__/SessionTerminal.test.tsx
  - packages/dashboard/app/utils/__tests__/terminalPreferences.test.ts
  - FN-7456
  - FN-7460
  - FN-7561
  - FN-7567
tags:
  - xterm
  - font-loading
  - options-service
  - mobile-safari
  - remeasure
  - letter-spacing
  - domrenderer
---

# xterm OptionsService no-op reassignment silently skips post-load remeasure

## Problem

FN-7561 is the third recurrence of "mobile terminal renders with excessive inter-character spacing" after this exact subsystem was touched twice before:

- FN-7456 added the iOS keyboard/viewport baseline and a symbols-free measured font stack (see `xterm-symbols-nerd-font-unicode-range.md`).
- FN-7460 added `-webkit-text-size-adjust: none` / `text-size-adjust: none` on `.terminal-xterm, .terminal-xterm *` after a real iPhone Safari report showed spacing surviving FN-7456, plus 10px/12px coverage.

Despite both fixes, the real-device symptom persisted. Both prior fixes treated the browser's DOM text-size-adjust/font-boosting behavior as the entire mechanism. It was not.

### The actual mechanism

xterm.js measures character/cell metrics via `CharSizeService`, then `DomRenderer._setDefaultSpacing()` bakes a compensating `letter-spacing` onto `.xterm-rows`:

```ts
// @xterm/xterm src/browser/renderer/dom/DomRenderer.ts
private _setDefaultSpacing(): void {
  // measure same char as in CharSizeService to get the base deviation
  const spacing = this.dimensions.css.cell.width - this._widthCache.get('W', false, false);
  this._rowContainer.style.letterSpacing = `${spacing}px`;
  this._rowFactory.defaultSpacing = spacing;
}
```

This recompute only runs from `_handleOptionsChanged()` (wired to `optionsService.onOptionChange`) or from `handleCharSizeChanged()`. Both app terminal surfaces (`TerminalModal.tsx`, `SessionTerminal.tsx`) reapply xterm font options after `waitForTerminalFontMetrics()` (added by FN-7456) settles, expecting that reassignment to force this recompute against the font that only just finished loading. But real xterm's `OptionsService` setter is a strict no-op on an unchanged value:

```ts
// @xterm/xterm src/common/services/OptionsService.ts
const setter = (propName: string, value: any): void => {
  value = this._sanitizeAndValidateOption(propName, value);
  // Don't fire an option change event if they didn't change
  if (this.rawOptions[propName] !== value) {
    this.rawOptions[propName] = value;
    this._onOptionChange.fire(propName);
  }
};
```

In the common case (the user never touched terminal preferences), the resolved `fontFamily`/`fontSize` after settle are *identical* to what was already applied a few lines earlier at xterm construction/effect setup. Reassigning the same value is therefore a total no-op: no `onOptionChange` fires, `CharSizeService` never remeasures, and `DomRenderer._setDefaultSpacing()` never recomputes the letter-spacing compensation against the now-loaded web font. The stale pre-load cell metrics (measured against a fallback system font before the custom font finished loading) persist as visible excess gaps on the very first mobile layout — exactly matching the report that the terminal "only repairs itself after keyboard toggle/orientation/reconnect": those events happen to force a genuine value change elsewhere in the pipeline (e.g. `handleResize`/`handleDevicePixelRatioChange`), incidentally triggering the missing remeasure.

Both `TerminalModal.tsx` and `SessionTerminal.tsx` had this bug in **two** places each: the initial xterm-init settle path and the live-preferences-apply settle path.

## Why FN-7456/FN-7460 missed this

Both fixes (and their regression tests) only ever asserted the *final* font/size value and CSS text-size-adjust state, never whether a genuine value *transition* occurred inside xterm's internal option pipeline. A plain mock `options: { fontSize: 14 }` object cannot model xterm's no-op-on-unchanged-value contract, so no test could distinguish "the code reassigned the resolved value" (looks correct) from "xterm's internal measurement pipeline actually recomputed" (the real requirement).

## Solution

Force a genuine (distinct-value) transition through xterm's option setter every time font metrics settle, regardless of whether the resolved value already equals the terminal's current option value:

```ts
// packages/dashboard/app/utils/terminalPreferences.ts
const TERMINAL_FONT_REMEASURE_SENTINEL_FONT_FAMILY = "monospace";

export function forceTerminalFontRemeasure(
  terminal: { options: { fontFamily?: string } },
  fontFamily: string,
): void {
  const sentinel =
    fontFamily === TERMINAL_FONT_REMEASURE_SENTINEL_FONT_FAMILY
      ? `${TERMINAL_FONT_REMEASURE_SENTINEL_FONT_FAMILY}, monospace`
      : TERMINAL_FONT_REMEASURE_SENTINEL_FONT_FAMILY;
  terminal.options.fontFamily = sentinel;
  terminal.options.fontFamily = fontFamily;
}
```

Both assignments run synchronously with no yield in between, so no intermediate frame paints — the terminal never visibly flashes the sentinel font. Both `TerminalModal.tsx` and `SessionTerminal.tsx` now call `forceTerminalFontRemeasure(terminal, resolvedFontFamily)` (instead of a plain `terminal.options.fontFamily = resolvedFontFamily`) at every post-settle site, immediately before reapplying `fontSize` and refitting/resizing/refreshing.

Do not:

- Add a hardcoded `letterSpacing`, fixed cell width, or fixed column count to mask the symptom.
- Skip the reassignment when the resolved value already matches the current option value — that equality is exactly what causes the bug.
- Remove or weaken the FN-7456/FN-7460 `text-size-adjust`/font-stack/keyboard-overlap coverage; this fix is additive to those invariants, not a replacement.

## Regression coverage

jsdom cannot exercise real xterm.js internals, so the regression coverage models xterm's documented no-op-on-unchanged-value contract directly on the test double, and asserts the *transition*, not just the final value:

- Wrap the mocked `Terminal.options` object in a real getter/setter pair with the same equality check as `@xterm/xterm`'s `OptionsService` setter, and track a counter that only increments on a genuine (distinct-value) `fontFamily`/`fontSize` transition.
- Simulate the real recurrence: xterm opens before `document.fonts.load()`/`document.fonts.ready` resolve (deferred promises), the resolved font/size are already applied and unchanged once they settle.
- Assert the transition counter goes from 0 to a positive count once `waitForTerminalFontMetrics()` settles — this fails pre-fix (a plain reassignment to the same value is a no-op) and passes post-fix (`forceTerminalFontRemeasure` always forces at least one genuine transition).
- Add a focused unit test for `forceTerminalFontRemeasure()` itself in `terminalPreferences.test.ts`, covering both "resolved value unchanged" and "resolved value genuinely different" cases.
- Cover both `TerminalModal` (mobile viewport, keyboard-open and keyboard-closed initial render) and `SessionTerminal` (embedded attach surface) — both surfaces independently reapply font options after settle and both had the bug.
- Run: `pnpm --filter @fusion/dashboard exec vitest run app/components/__tests__/TerminalModal.test.tsx app/components/__tests__/SessionTerminal.test.tsx app/components/__tests__/SessionTerminal.mobile.test.tsx app/__tests__/terminal-input.test.ts app/utils/__tests__/terminalPreferences.test.ts --silent=passed-only --reporter=dot`.
- Real mobile Safari/Chrome verification remains the strongest signal for this class of bug; if unavailable, record that as an explicit gap rather than treating desktop WebKit/jsdom as proof (see `docs/ios-acceptance.md`).

## Recurrence #4 (FN-7567): forcing a genuine remeasure BEFORE `fit()` bakes stale spacing

FN-7561's `forceTerminalFontRemeasure()` fix (above) is necessary but was not sufficient. On the real
mobile device, ordinary ASCII (`test`, `ls`, filenames) still rendered with visible gaps on the
initial paint even with the FN-7561 fix, FN-7460's `text-size-adjust: none`, and FN-7456's
symbols-free font stack all present.

### New root cause

Real xterm's `DomRenderer._setDefaultSpacing()` — the letter-spacing compensation baked onto
`.xterm-rows` as `spacing = dimensions.css.cell.width - widthCache.get('W')` — only recomputes from
two call sites:

- `handleCharSizeChanged()`, wired to `CharSizeService.onCharSizeChange`, which fires on any
  **genuine** (distinct-value) `fontFamily`/`fontSize` option transition — exactly what
  `forceTerminalFontRemeasure()` forces.
- `handleDevicePixelRatioChange()`.

It is **never** recomputed from `handleResize()` — the path `fitAddon.fit()` →
`terminal.resize(cols, rows)` takes.

Both mobile settle sites in `TerminalModal.tsx` and `SessionTerminal.tsx` (the initial post-font-load
settle and the live-preferences-apply settle) called `forceTerminalFontRemeasure()` **before**
`fitAddon.fit()`. That correctly forces a genuine option transition and does bake letter-spacing —
but it bakes it against the column count that predates the fit. `fitAddon.fit()` then changes the
column count (and therefore the true cell width) but never re-bakes the spacing, so the terminal keeps
rendering with a spacing value computed against a column count that no longer matches reality. The
gap persists until an unrelated later event (device-pixel-ratio change, orientation, reconnect)
happens to force another genuine option/DPR-triggered remeasure — exactly matching the report that
the terminal "only repairs itself after an incidental refit."

### Why FN-7456/FN-7460/FN-7561 missed this

All three prior fixes and their regressions asserted CSS-property presence (`text-size-adjust: none`,
symbols-free `fontFamily`) or a remeasure **call count** (`fontRemeasureCount`), never the actual baked
letter-spacing value relative to the **post-fit** column count. A test that only checks "a remeasure
happened" cannot distinguish "remeasure happened but was baked against stale pre-fit geometry" from
"remeasure happened and reflects final geometry."

### Solution

Force a **second** genuine remeasure **after** `fitAddon.fit()` settles the column count, so the
letter-spacing bake is recomputed against the FINAL (post-fit) geometry, not the pre-fit one:

```ts
// packages/dashboard/app/components/TerminalModal.tsx (mirrored in SessionTerminal.tsx)
forceTerminalFontRemeasure(terminal, resolvedFontFamilyRef.current);
terminal.options.fontSize = fontSizeRef.current;
fitAddon.fit();
resizeRef.current?.(terminal.cols, terminal.rows);
forceTerminalFontRemeasure(terminal, resolvedFontFamilyRef.current); // re-bake against final cols
terminal.refresh(0, Math.max(0, terminal.rows - 1));
```

The `scheduleRefit(rebakeSpacingAfterFit)` path in `TerminalModal.tsx` only re-bakes on the *settled*
(font-metrics-ready) call site, not on the immediate first frame — at that point the web font may not
have loaded yet, so re-baking there would only bake against fallback-font metrics again.

Do not:

- Re-bake unconditionally on every frame/resize — only after a settle that already forced a genuine
  remeasure and then fit.
- Replace this with a hardcoded letter-spacing/cell-width compensation.

### Regression coverage (geometry-based, not CSS/call-count)

jsdom cannot exercise real xterm.js internals, so the FN-7567 regression models the real
`CharSizeService`/`DomRenderer` contracts directly on the test double instead of a plain mock:

- `mockHandleCharSizeChanged()` mirrors `CharSizeService.measure()` → `DomRenderer.handleCharSizeChanged()`
  → `_setDefaultSpacing()`: recomputes `bakedLetterSpacingPx = cellWidthPx - measuredCharWidthPx` using
  the **current** (possibly stale, pre-fit) column count, firing only on a genuine option transition.
- `mockFitAddonFit()` mirrors `FitAddon.fit()` → `terminal.resize(cols, rows)` →
  `DomRenderer.handleResize()`: recomputes `cols`/cell-width from the current measured char width but
  deliberately does **not** touch the baked letter-spacing (matching real xterm).
- The assertion is the actual rendered geometry invariant: baked letter-spacing must equal `0` (cell
  width matches the settled glyph advance width) after the full settle+fit sequence — not merely that
  `forceTerminalFontRemeasure`/`fontRemeasureCount` was called.
- See `TerminalModal.test.tsx` describe block "FN-7567 mobile inter-character spacing (stale post-fit
  letter-spacing bake)" and the mirrored `SessionTerminal.test.tsx` coverage.
- Run: `pnpm --filter @fusion/dashboard exec vitest run app/components/__tests__/TerminalModal.test.tsx app/components/__tests__/SessionTerminal.test.tsx app/components/__tests__/SessionTerminal.mobile.test.tsx app/utils/__tests__/terminalPreferences.test.ts app/__tests__/terminal-input.test.ts --silent=passed-only --reporter=dot`.
- Real mobile Safari/Chrome sanity check remains the strongest signal; a real-device screenshot was not
  obtainable in this execution environment (headless coding agent, no physical device access) — this
  gap is recorded explicitly rather than treating jsdom/desktop WebKit as proof. See task document
  key="repro" on FN-7567 and `docs/ios-acceptance.md`.

## Recurrence #5 (FN-7603): mock/real divergence — Canvas vs DOM character measurement

FN-7561's `forceTerminalFontRemeasure()` and FN-7567's post-fit re-bake both ran correctly, and both
were validated ONLY against jsdom test doubles that never exercise real `@xterm/xterm@5.5.0`. On the
reported real mobile device, ordinary ASCII still rendered with visible gaps on the initial paint. This
is the fifth recurrence of the same defect, so the FN-7603 executor was required to read the installed
`@xterm/xterm@5.5.0`/`@xterm/addon-fit@0.10.0` source before touching production code (see task
document key="xterm-source-audit" on FN-7603).

### The actual mechanism

xterm's `CharSizeService` selects ONE of two measurement strategies **the moment `terminal.open()`
runs**:

```js
// @xterm/xterm/lib/xterm.js (installed 5.5.0), CharSizeService constructor
try { this._measureStrategy = new OffscreenCanvasStrategy(optionsService) }      // canvas: ctx.measureText("W")
catch { this._measureStrategy = new DomFallbackStrategy(document, container, optionsService) } // DOM: offsetWidth/32
```

The Canvas strategy is chosen whenever `OffscreenCanvas` + `CanvasRenderingContext2D.measureText()`
reporting `fontBoundingBoxAscent`/`fontBoundingBoxDescent` are available — true on essentially every
real modern mobile Safari/Chrome. `dimensions.css.cell.width` (which feeds both `FitAddon.fit()`'s
column count, per the installed `addon-fit@0.10.0` `proposeDimensions()`, and
`DomRenderer._setDefaultSpacing()`'s baked letter-spacing) derives from whichever strategy
`CharSizeService` picked.

Separately, `DomRenderer._setDefaultSpacing()` and `DomRendererRowFactory.createRow()`'s per-glyph
override BOTH measure via `WidthCache`, which is **always** DOM-based (`offsetWidth` of a hidden
32×-repeated-character span) — entirely independent of `CharSizeService`'s strategy choice. Real glyphs
are painted 100% through the DOM (`DomRenderer` never draws through canvas). Canvas 2D text measurement
and DOM/CSS text layout are two different browser rendering pipelines that can disagree — even by a
fraction of a device pixel — for the same font on the same device; this is a documented,
long-standing cross-API text-metrics inconsistency. `_setDefaultSpacing()`'s formula
(`dimensions.css.cell.width - widthCache.get('W')`) only correctly converges to zero (tight, contiguous
cells) when both operands are measured through the SAME pipeline. None of FN-7456/FN-7460/FN-7561/
FN-7567 (or their test doubles) ever modeled this — all four assumed CharSizeService's measurement and
WidthCache's measurement were the same value.

### Why FN-7456/FN-7460/FN-7561/FN-7567 missed this

Every prior fix's test double (`mockHandleCharSizeChanged`) treated the measured character width as a
single shared value used for both "the cell width that drives fit" and "the width WidthCache subtracts
in `_setDefaultSpacing()`" — a faithful-looking model of xterm's DOM-only fallback strategy, but NOT of
the Canvas strategy that real xterm actually selects by default on real mobile browsers. Because jsdom
cannot run real `@xterm/xterm`, and no fix before FN-7603 cross-checked the double against the installed
source, the divergence between "what CharSizeService measures" (Canvas, in the real common case) and
"what WidthCache measures" (always DOM) went completely uncovered for four recurrences.

### Solution

Force `CharSizeService` to construct with its own DOM fallback strategy — unifying the cell-width
measurement with `WidthCache`'s measurement — by making `OffscreenCanvas` transiently unavailable for
the synchronous duration of `terminal.open()` (where `CharSizeService` is constructed):

```ts
// packages/dashboard/app/utils/terminalPreferences.ts
export function withDomBasedTerminalCharacterMeasurement<T>(fn: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(window, "OffscreenCanvas");
  delete (window as any).OffscreenCanvas;
  try {
    return fn();
  } finally {
    if (descriptor) Object.defineProperty(window, "OffscreenCanvas", descriptor);
  }
}
```

Both `TerminalModal.tsx` and `SessionTerminal.tsx` now wrap their `terminal.open(container)` call in
`withDomBasedTerminalCharacterMeasurement(() => terminal.open(container))`. `CharSizeService`'s
constructor try-block throws (no `OffscreenCanvas` global), so it self-selects the SAME DOM-based
strategy `WidthCache` already always uses — no hardcoded letter-spacing/cell-width compensation is
added; the fix unifies the measurement pipeline instead.

Do not:

- Patch `window.OffscreenCanvas` outside the narrow synchronous `open()` window — other page code
  (charts, canvas-based rendering elsewhere in the dashboard) may legitimately need it.
- Assume this is scoped to mobile only — desktop with the DOM renderer (WebGL addon failed to load, or
  `renderer: "canvas"` preference) has the identical divergence and benefits from the same fix.
- Treat this as a replacement for FN-7561/FN-7567 — both remain necessary; this fix addresses a
  different, independent measurement-pipeline mismatch.

### Regression coverage (Canvas-vs-DOM divergence, not CSS/call-count)

- Extended the FN-7567 double: `mockCanvasCharWidthPx` (drives `FitAddon.fit()`'s column count,
  mirroring `dimensions.css.cell.width`) can diverge from `mockDomCharWidthPx` (mirrors
  `WidthCache.get('W')`) by a fixed offset, gated on `window.OffscreenCanvas` being defined at the
  moment the mock's `open()` runs — exactly mirroring the real `CharSizeService` constructor's
  try/catch strategy selection.
- The assertion is the same rendered-geometry invariant as FN-7567 (baked letter-spacing `== 0`), but
  now fails on HEAD even with the full FN-7561/FN-7567 settle+pre/post-fit-remeasure sequence present,
  because the divergence is NOT an ordering bug — it's a measurement-pipeline bug those fixes cannot
  see or fix.
- See `TerminalModal.test.tsx` describe block "FN-7603 mobile inter-character spacing (Canvas vs DOM
  CharSizeService measurement divergence)".
- Run: `pnpm --filter @fusion/dashboard exec vitest run app/components/__tests__/TerminalModal.test.tsx app/components/__tests__/SessionTerminal.test.tsx app/components/__tests__/SessionTerminal.mobile.test.tsx app/utils/__tests__/terminalPreferences.test.ts app/__tests__/terminal-input.test.ts --silent=passed-only --reporter=dot`.
- Real mobile Safari/Chrome sanity check remains the strongest signal; a real-device screenshot was not
  obtainable in this execution environment — this gap is recorded explicitly (task document
  key="repro" on FN-7603) rather than treating jsdom/desktop WebKit as proof.
