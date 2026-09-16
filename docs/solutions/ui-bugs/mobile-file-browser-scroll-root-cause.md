---
title: "A non-shrinking flex ancestor, not min-height, is what stops the file browser list from scrolling"
date: 2026-09-16
category: ui-bugs
module: packages/dashboard/app/components/FileBrowser.css
problem_type: ui_bug
component: frontend_css
symptoms:
  - "On a phone the folder/file list cannot be scrolled at all; its last entries stay off screen and cannot be tapped"
  - "The list reports clientHeight === scrollHeight, so scrollTop physically cannot change — no gesture, wheel, or fling helps"
  - "Three successive CSS fixes (FN-427, FN-445, FN-462) shipped green jsdom style tests and the symptom returned each time"
root_cause: non_shrinking_flex_ancestor_defeats_min_height_zero
resolution_type: code_fix
severity: high
related_components:
  - packages/dashboard/app/components/ViewSidebar.css
  - packages/dashboard/app/components/FileBrowserModal.tsx
  - packages/dashboard/src/__tests__/file-browser-scroll-browser.test.ts
  - packages/dashboard/app/components/__tests__/FileBrowser.scroll-interactions.test.tsx
tags:
  - file-browser
  - flexbox
  - scroll-containment
  - mobile
  - css-cascade
  - browser-verification
applies_when:
  - "A bounded flex column hands its height to a child that carries `flex: none` (or `flex-shrink: 0`) from a shared primitive"
  - "A fix attempt only declares `min-height: 0` / `overflow: hidden` on the intermediate boxes"
  - "The regression coverage is jsdom-only, which computes no layout at all"
---

# A non-shrinking flex ancestor, not `min-height`, is what stops the file browser list from scrolling

## Symptom

> « Pourquoi sur mobile, sans l'explorateur de fichier, je n'arrive pas à scroll dans la liste des
> dossiers/fichiers ? »

The folder/file list runs past the bottom of the screen and no gesture moves it. This was reported four
times against the same component.

## What was actually measured

Real Chromium, production hosts, 80 mixed entries, **before** the fix:

| Host | `.file-browser-sidebar` | `.view-sidebar__panel` | `.file-browser-list` client/scroll | touch pan |
|---|---|---|---|---|
| `FileBrowserModal` 390×844 | 731px | **3719px** | 3584 / 3584 | `scrollTop` 0 → 0 |
| `FileBrowserModal` 768×1024 | — | — | 2568 / 2568 | 0 → 0 |
| `FileBrowserModal` 1280×900 | 607px | **2717px** | 2568 / 2568 | 0 → 0 |

`clientHeight === scrollHeight` means the list is **not a scroll container at all**. `scrollTop` cannot
change, so this is not a gesture problem, not an overlay capturing touches, and not a `touch-action`
cascade problem — those were all ruled out by the same run (the drawer panel carried no transform after
a pan, the document never moved, and `elementFromPoint` at the list centre hit a real row).

## Root cause

`ViewSidebar.css` declares the shared rail panel as:

```css
.view-sidebar__panel { flex: none; /* = 0 0 auto */ }
```

`.file-browser-sidebar` is a `flex-direction: column` container. A flex item with `flex-shrink: 0` and
`flex-basis: auto` takes the height of its **content** and never shrinks to its parent. The panel therefore
grew to the full 80-entry height, `.file-browser { height: 100% }` resolved against that overgrown box, and
`.file-browser-list { flex: 1; overflow-y: auto }` received a client height equal to its scroll height.

The defect is a property of the **box**, not of a breakpoint: it reproduced identically on phone, tablet and
desktop.

## Why three previous fixes did not see it

FN-427, FN-445 and FN-462 each declared `min-height: 0` and `overflow: hidden` on this very element (among
others). **`min-height: 0` has no effect on an item that does not shrink** — it only removes the automatic
minimum size that would otherwise stop a shrinking item. Because nothing shrank, nothing changed.

Their regression coverage was jsdom-only. jsdom computes no layout: it can read declared styles but it can
never report that a box is 3719px inside a 731px parent. Every one of those suites was legitimately green
while the product was broken.

## Fix

`packages/dashboard/app/components/FileBrowser.css`, base rule, no media query:

```css
.file-browser-sidebar > .file-browser-sidebar__panel {
  flex: 1 1 auto;
  max-block-size: 100%;
}
```

Deliberate choices:

- **No media query.** The defect was never breakpoint-specific, so a phone-scoped rule would have left
  tablet and desktop broken — exactly the trap the previous three host-scoped fixes fell into.
- **Parent `>` child form (specificity 0,2,0).** `ViewSidebar.css` declares `flex: none` at 0,1,0. Both are
  component stylesheets whose injection order depends on import order, so an equal-specificity rule would
  only win by cascade luck.
- **Block axis only.** `inline-size` — the rail width, including the operator's persisted width — stays owned
  by `ViewSidebar.css`, and no other `.view-sidebar__panel` consumer is touched.

A second, smaller correction shipped with it: `FileBrowser`'s "close the context menu on scroll" listener
subscribed through `document.querySelector(".file-browser-list")`, i.e. the **first** list in the document.
With two browsers mounted, the second instance's menu never closed on its own scroll and wrongly closed on
the first one's. It now uses a local ref.

## Regression coverage

- `packages/dashboard/src/__tests__/file-browser-scroll-browser.test.ts` — real Chromium. It measures the
  bounded height, counts the vertical scroll owners in the resolved ancestor chain, hit-tests the list
  centre, and drives **native** CDP touch pans (never a `scrollTop` write) until the last entry is reachable
  and tappable. Reverting the CSS fix turns three of its cases red, and the first failure names the
  offending box: `aside.view-sidebar__panel.file-browser-sidebar__panel`.
- `packages/dashboard/app/components/__tests__/FileBrowser.scroll-interactions.test.tsx` — jsdom companion:
  the mechanism (the panel must be a shrinkable flex item, not merely `min-height: 0`), gesture ordering
  around the scroll, two-instance independence, and the data states that replace the list.

## Rule to carry forward

When a leaf will not scroll, walk the **resolved** ancestor chain in a real engine and compare each box's
height with its parent's before adding another `min-height: 0` / `overflow: hidden`. If the offending box
comes from a shared primitive, check `flex-shrink` first: a non-shrinking ancestor makes every containment
declaration below it inert, and jsdom cannot tell you so.
