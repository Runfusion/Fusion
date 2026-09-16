---
title: "A ViewLayout page with its own scroller hosted in a scrolling mobile drawer creates two competing scroll owners"
date: 2026-09-16
category: ui-bugs
module: packages/dashboard/app/components/dashboard/MainContent.tsx
problem_type: ui_bug
component: frontend_css
symptoms:
  - "On a phone, a destination's list renders but cannot be scrolled to its last entry"
  - "A fix that only covered the standalone modal/window presentation of the same body leaves the in-drawer destination broken"
  - "Leaf-rule CSS assertions stay green while the operator still cannot reach the end of the list"
root_cause: drawer_body_and_hosted_view_both_own_vertical_overflow
resolution_type: code_fix
severity: medium
related_components:
  - packages/dashboard/app/components/MobileDrawer.tsx
  - packages/dashboard/app/components/MobileDrawer.css
  - packages/dashboard/app/components/FilesView.css
  - packages/dashboard/app/components/FileBrowser.css
  - packages/dashboard/app/components/__tests__/FilesView.mobile-drawer.test.tsx
tags:
  - mobile-drawer
  - scroll-containment
  - view-layout
  - fill-chain
  - css-regression-test
applies_when:
  - "A destination whose view composes `ViewLayout` with `contentOwnsScroll` is routed into `MainContentDrawer` (`mobile-drawer-main-content`) on a phone"
  - "The same body also has a standalone window/modal presentation that was already bounded by an earlier fix"
---

# A drawer-hosted page with its own scroller fights the drawer body (FN-445, after FN-427)

## Problem

The operator reported, twice, that the phone file explorer's list would not scroll. FN-427 fixed the
`FileBrowserModal` **window** presentation (`.floating-window--file-browser.floating-window--mobile-drawer`) and
shipped a green regression suite. The report came back unchanged, because the surface the operator actually used is a
different host: the **Files destination** reached from the footer "More" menu, rendered by `MainContentDrawer` inside
`.mobile-drawer__body`.

## Root cause

Two independent contracts have to agree, and only one of them was satisfied:

1. **Ownership flag.** `MobileDrawer` documents that `contentOwnsScroll` suppresses the drawer body's own scroller and
   that only a view with a complete bounded internal scroll chain may set it. `MainContentDrawer` passed a constant
   `contentOwnsScroll={false}` for every destination, so `.mobile-drawer__body` kept `overflow: auto` even for
   `FilesView`, which already ends in a bounded `.file-browser-list`. Two boxes in one chain claimed the same vertical
   gesture.
2. **Fill chain.** The chain `.files-view` → `.view-layout__body` → `.view-layout__content` → `.dock-files-view` →
   `.file-browser` → `.file-browser-list` declared its boundedness only through the LOGICAL `min-block-size: 0`. A
   single intermediate box left at `min-height: auto` is enough to let the list grow past the panel again, which is
   exactly the failure mode FN-427 had already had to bound for the window host.

The general shape: **a page that owns its scroller, hosted by a shell that also owns one, is broken by construction —
fixing either half alone leaves the symptom.**

## Solution

- Make scroll ownership a **per-destination** property of the drawer bridge: `MainContentDrawer` derives
  `contentOwnsScroll` from the exported `MOBILE_DRAWER_CONTENT_SCROLL_VIEWS` set (today: `files` only). Ordinary long
  views keep the drawer body as their reachable scroller — flipping the flag globally would strand them.
- Restate the fill chain for that specific host, in physical `min-height: 0` as well as its logical form, scoped by
  `html[data-mobile-drawers="true"][data-viewport-mode="mobile"] .mobile-drawer__body .files-view` (page chain in
  `FilesView.css`, browser chrome/list split in `FileBrowser.css`). `.file-browser-list` becomes the single bounded
  scroll owner with `overscroll-behavior: contain`.
- Do **not** relax the global mobile `touch-action` lockdown in `styles.css`; fix on the specific host, per
  [mobile-touch-action-ancestor-intersection-defeats-leaf-scroll.md](./mobile-touch-action-ancestor-intersection-defeats-leaf-scroll.md).

## How to test this class of bug

A leaf-rule string match is a floor, never the gate. The gate is an **ancestor-chain** test:

1. Mount the **production** composition (here `MainContentDrawer` → `FilesView` → `DockFilesView` → `FileBrowser`), not
   a fixture shell — a shell copy can stay green while production regresses.
2. Inject the real stylesheet with `loadAllAppCss()` into a `<style>` element and set the phone attributes
   (`data-viewport-mode`, `data-mobile-drawers`) plus a narrow `window.innerWidth`.
3. Walk from the scrollable leaf up to the drawer panel and assert **exactly one** vertical scroll owner, `min-height: 0`
   on every intermediate box, and a `touch-action` that still permits `pan-y` everywhere.
4. Cover every data state that changes the overflow shape (populated, empty, loading, error, search filler) and add
   negative scope controls: desktop, phone without the drawer opt-in, and the optional dock host.

### jsdom pitfalls measured on this task

- jsdom does **not** expand the `overflow` shorthand into `overflow-y`. Reading `overflowY` alone reports `visible` for a
  box that really scrolls (`.mobile-drawer__body { overflow: auto }`), which silently turns the single-scroll-owner
  assertion into a no-op. Resolve the longhand first and fall back to the shorthand.
- jsdom does **not** resolve logical `min-block-size` into `min-height`. That is useful here (it makes the physical
  restatement observable), but it means a box probed for gating must not already receive a physical `min-height` from an
  unrelated rule — `.mobile-drawer__body > *` gives `.files-view` `min-height: 0` on every host, so `.dock-files-view` is
  the honest probe for "these rules are attribute-gated".
- Gesture cases need a positive control (a downward drag from the top of the list still claims dismissal), otherwise a
  disabled listener would make the non-interference cases pass vacuously.

## Regression coverage

`packages/dashboard/app/components/__tests__/FilesView.mobile-drawer.test.tsx`. Confirmed red on the pre-fix tree
(6 failed / 2 passed) and green after. `FileBrowserModal.mobile-drawer.test.tsx` (FN-427) remains green unchanged.
