---
title: "A shared component's phone scroll invariant must be declared on the component, not host by host"
date: 2026-09-16
category: ui-bugs
module: packages/dashboard/app/components/FileBrowser.css
problem_type: ui_bug
component: frontend_css
symptoms:
  - "On a phone the file list renders but its entries run off screen and cannot be scrolled to, so nothing can be selected"
  - "The same symptom is reported again after each fix, from a host the previous fix did not name"
  - "The phone header stacks so many control rows that almost no height is left for the list"
root_cause: per_host_scroll_containment_left_remaining_hosts_unbounded
resolution_type: code_fix
severity: medium
related_components:
  - packages/dashboard/app/components/FileBrowser.tsx
  - packages/dashboard/app/components/FilesView.css
  - packages/dashboard/app/components/SettingsModal.css
  - packages/dashboard/app/components/__tests__/FileBrowser.mobile-layout.test.tsx
tags:
  - mobile-layout
  - scroll-containment
  - fill-chain
  - shared-component
  - touch-targets
  - css-regression-test
applies_when:
  - "A shared component owns an internal scroller and is mounted by several hosts with different chrome"
  - "A phone fix was written against one host's selector chain"
---

## Symptom

"Redo the file explorer layout on mobile so it is mobile friendly and above all so I can scroll my file list, because
right now the files run off screen and I cannot see them to select them." — reported three times for the same
component.

## Why the two earlier fixes did not hold

Both predecessors were correct, green, and scoped to exactly one host:

- **FN-427** bounded the standalone `FileBrowserModal` window in **drawer presentation**
  (`.floating-window--file-browser.floating-window--mobile-drawer`).
- **FN-445** bounded the Files **destination** inside `.mobile-drawer__body .files-view`.

The invariant itself was never written down for the component, so every remaining host kept an unbounded chain:

| Host | State before FN-462 |
| --- | --- |
| `FileBrowserModal`, phone full-screen sheet (no `data-mobile-drawers`) | sidebar panel at `min-height: auto`, scrolling against the list |
| Files page rendered **inline** (no drawer: non-project view mode, no current project, pre-opt-in) | `.dock-files-view` / `.view-layout__*` at `min-height: auto` |
| The three Settings pickers (`.settings-overlap-path-picker-body`) | a `.modal-body` with `overflow-y: auto` hosting a `height: 100%` browser bounded by nothing |

On top of that, the phone header stacked **four** rows (path, search, a full-width sort row, two full-width labelled
create buttons), so even a correctly bounded list had almost no height to show.

## The rule

Declare the invariant once, on the component, host-independently:

> On a phone, between `.file-browser` and its list there is exactly **one** vertical scroll owner —
> `.file-browser-list` — and **no** intermediate box is left at `min-height: auto`.

`FileBrowser.css` now states this under `html[data-viewport-mode="mobile"]` plus the pre-hydration arm
`html:not([data-viewport-mode])` inside the phone media query (the shape `ViewLayout.css` already uses). Any host,
present or future, inherits it; the FN-427/FN-445 rules stay as host-specific refinements and were **not** removed.
The chrome is capped at three touch rows, rows are `--touch-target-min-size` tall, names ellipsize, and the list
reserves `max(var(--space-md), env(safe-area-inset-bottom))` so the last entry clears the bottom navigation bar.

Compacting must never delete a control: the sort `<label>` and create-button text are hidden with a clip technique
(never `display: none`) and each create button carries an explicit `aria-label` from its existing i18n key, so the
icon-only form keeps every accessible name.

## Test method: walk the resolved ancestor chain, per host

CSS-text assertions cannot catch this class of bug — each earlier fix had them and was green. The regression file
mounts the **production composition of every host**, injects the real stylesheet with `loadAllAppCss()`, then walks
the chain from `.file-browser-list` up to that host's panel and asserts one scroll owner, `min-height: 0` everywhere,
and `touch-action` that still allows `pan-y`.

jsdom pitfalls that silently defeat the gate:

- It does not expand the `overflow` shorthand into `overflow-y`; resolve the longhand first and fall back. For the
  same reason, a rule that must beat `.modal-body { overflow-y: auto }` should declare the **longhands**.
- It does not evaluate `@media` for computed style, so anything proven with `getComputedStyle` must be attribute-scoped;
  the pre-hydration arm is pinned on its declaration instead.
- It does not expand `flex` into `flex-basis`; read `getPropertyValue("flex")` for shorthand rules.
- With the whole stylesheet injected, role queries can treat production controls as hidden (no layout engine). Click
  the production trigger by its own `aria-label` rather than weakening the case.

## Regression coverage

`packages/dashboard/app/components/__tests__/FileBrowser.mobile-layout.test.tsx`. Confirmed red on the pre-fix tree
for hosts (b) full-screen sheet, (d) inline Files page and (e) Settings picker, while the two already-fixed hosts
(a)/(c) stayed green — then all 18 cases green after the fix. `FileBrowserModal.mobile-drawer.test.tsx` (FN-427) and
`FilesView.mobile-drawer.test.tsx` (FN-445) remain green.
