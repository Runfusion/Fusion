---
title: "Unoffset .visually-hidden inflates mobile scrollWidth and breaks kanban scroll"
date: 2026-06-13
category: ui-bugs
module: packages/dashboard/app/styles.css
problem_type: ui_bug
component: frontend_css
symptoms:
  - "Mobile kanban board would not scroll left/right cleanly on iOS Safari"
  - "Dragging near the bottom slid whole columns off-screen"
  - "Table/list view rendered cut off and zoomed out, even though its own layout was clean"
  - "documentElement.scrollWidth measured ~1388px on a 390px viewport"
root_cause: mobile_viewport_containment
resolution_type: css_fix
severity: high
related_components:
  - packages/dashboard/app/__tests__/dashboard-overflow-containment.test.tsx
  - packages/dashboard/app/__tests__/mobile-horizontal-pan-containment.test.ts
tags:
  - mobile
  - viewport
  - overflow
  - visually-hidden
  - sr-only
  - containing-block
  - ios-safari
  - kanban-board
---

# Unoffset .visually-hidden inflates mobile scrollWidth and breaks kanban scroll

## Problem
A `.visually-hidden` (screen-reader-only) utility positioned `absolute` with no offsets sat at its static-flow position — off-screen-right inside the horizontally-scrolled kanban columns — and, because no ancestor was its containing block, escaped the board's overflow clipping and ballooned `documentElement.scrollWidth` to ~1388px on a 390px viewport. On iOS Safari this triggered a persistent shrink-to-fit zoom-out and let the whole page pan columns off-screen. Desktop was unaffected.

## Symptoms
- On a mobile (390px) viewport, `document.documentElement.scrollWidth` measured ~1388px while `clientWidth` stayed 390px.
- iOS Safari zoomed the page out (shrink-to-fit) despite `maximum-scale=1, user-scalable=no`.
- The zoom-out persisted after navigating to List view, making List look zoomed even though its own layout was clean (`scrollWidth` 390).
- The over-wide document allowed the entire page to pan horizontally, dragging kanban columns out of the viewport.

## What Didn't Work
The bug initially looked like a problem with the visible kanban columns — the natural assumption being that the `.board` flex scroller or the `.column` widths were leaking past the viewport. Setting `.column { position: relative }` *did* fix the measurement (`scrollWidth` → 390), proving the columns' containing block was implicated — but it was rejected as the fix: it only patches the board, would need repeating for lane mode and any future horizontal scroller, and treats the symptom rather than the cause.

The List view was a second red herring. It never overflowed (`scrollWidth` 390); it only *appeared* zoomed because iOS retains the board's shrink-to-fit zoom state across in-app navigation. Don't chase the List-view layout or the column widths — neither is the cause.

## Solution
The culprit was the shared `.visually-hidden` utility in `packages/dashboard/app/styles.css` (~line 49). Pin it to the origin with `top: 0; left: 0`.

**Before:**
```css
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

**After:**
```css
.visually-hidden {
  position: absolute;
  /* Pin to the containing block's origin. Without offsets an absolute box
     renders at its static-flow position; inside a horizontal scroller (e.g.
     the kanban board) that position is off-screen-right, and because the
     scroll container isn't a positioned containing block its overflow can't
     clip the span — so it balloons documentElement.scrollWidth and triggers
     iOS shrink-to-fit zoom-out + whole-page panning on mobile. */
  top: 0;
  left: 0;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

With the pin, the span's box stays 1px×1px (computed `top`/`left` = 0, still clipped and invisible) and `documentElement.scrollWidth` returns to 390. One global edit fixes the utility everywhere — board, lane mode, and any future horizontal scroller — with zero a11y or visual change. Shipped in commit `3cc82bdc4`.

## Why This Works
1. **No offsets → static-flow position.** A `position: absolute` element with no `top/left/right/bottom` is painted at its *static-flow* position — where it would have sat in normal flow. So each hidden span inherited the x-position of its parent column.
2. **The columns' static positions are off-screen-right.** `.board` is a horizontal flex scroller (`overflow-x: auto`); its 6 `.column` children lay out from x≈12 to x≈1872 at a 390px viewport. Columns past the fold sit at x≈1300+, and so do the hidden spans inside them.
3. **Overflow only clips descendants in *its own* containing block.** An ancestor's `overflow` clips an absolutely-positioned descendant *only if that ancestor is the descendant's containing block* — the nearest ancestor with `position != static` (or one otherwise establishing a containing block). Both `.column` and `.board` were `position: static`, so the spans' containing block was the **initial containing block** (`<html>`), not the board. The board's `overflow-x: auto` therefore could not clip them.
4. **The document grew, not the board.** Unclipped, the spans extended `documentElement.scrollWidth` to ~1388px while `<body>`/viewport stayed 390px.
5. **iOS shrink-to-fit.** On iOS Safari, `maximum-scale=1, user-scalable=no` is ignored, and an over-wide document triggers an automatic shrink-to-fit zoom-out. That zoom state persists across in-app navigation (hence List view looking zoomed), and the over-wide document also makes the whole page pannable.

Pinning `top: 0; left: 0` overrides the static-flow position and parks the span at its containing block's origin, so it can no longer push the document width — while the existing `width:1px / clip / overflow:hidden` keep it visually hidden and accessible exactly as before.

## Prevention
- **Treat offset-less `position: absolute` sr-only utilities as unsafe inside scroll containers.** Any `visually-hidden` / `sr-only` pattern that is `position: absolute` with no `top/left` floats to its static-flow position; inside a horizontal scroller that position can be off-screen and will widen the document. Pin such utilities to the origin (`top: 0; left: 0`), or guarantee every scroll container establishes a containing block. Pinning the utility is preferred — one edit, can't regress per-container.
- **Add a CSS-fixture regression assertion.** This repo guards layout invariants with static CSS-text tests (`packages/dashboard/app/test/cssFixture.ts` → `loadAllAppCss()`), not layout measurement — see `mobile-horizontal-pan-containment.test.ts` and `dashboard-overflow-containment.test.tsx`. The matching guard here is an assertion that the `.visually-hidden` rule block contains `top: 0;` and `left: 0;` (or otherwise pins its position). That style of test would have caught this regression.
- **jsdom cannot catch it by measurement.** jsdom has no layout engine, so `scrollWidth` is always 0 — a runtime-measurement test passes while the bug ships. Real-layout verification needs a browser/Playwright assertion: at a mobile viewport (e.g. 390×844), `document.documentElement.scrollWidth <= document.documentElement.clientWidth`.
- **Manual check after any horizontal-scroller change:** load at 390px and compare `documentElement.scrollWidth` vs `clientWidth`; a gap means something escaped the scroll container's clip.

## Related Issues
- [Mobile document horizontal pan containment](./mobile-horizontal-pan-document-viewport-containment.md) — sibling fix to the same "document must stay at horizontal offset zero" invariant, via root-chrome `touch-action`/`overflow-x` (FN-6365). Its containment contract did not catch a stray absolutely-positioned descendant escaping a non-positioned scroll container — which this doc explains.
- [Mobile board iOS horizontal overscroll containment](./mobile-board-ios-horizontal-overscroll-containment.md) — same component + iOS Safari, different mechanism (`overscroll-behavior-x: contain` rubber-band, FN-6378).
- [Mobile auto-merge toggle document scroll blank](./mobile-auto-merge-toggle-document-scroll-blank.md) — same failure class (unintended mobile document horizontal scroll), different trigger (FN-6243).
- Commit `3cc82bdc4` — `fix: lock mobile board to viewport by pinning .visually-hidden` (changeset `.changeset/mobile-board-sr-only-overflow.md`).
