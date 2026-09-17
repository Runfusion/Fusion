---
category: ui-bugs
module: packages/dashboard/app/components
tags:
  - react
  - refs
  - modals
  - floating-window
  - mobile-drawer
  - window-manager
  - update-depth
problem_type: infinite-render-loop
applies_when: >
  Composing a DOM ref callback that publishes into a React context which re-renders its
  consumers — dashboard window surfaces, overlays, portals, measurement registries.
---

# Opening a modal threw React #185 because the root ref callback was re-created every render

## Symptom

Since a recent push, opening **any** dashboard modal replaced the whole application with the
`ErrorBoundary` fallback and logged `Minified React Error #185`
(<https://react.dev/errors/185> → *Maximum update depth exceeded*). It reproduced most
aggressively on phones, where `MobileDrawer` is the default presentation and `FloatingWindow`
additionally mounts a keyboard-viewport surface.

## Attribution (verified with Git, not inferred)

Commit `4d7c0b3f28fee06751fe711b8c6adedc350df433` — *FN-512: centralize mobile keyboard viewport
measurement behind a single-owner surface adapter* (2026-09-17). In the whole FN-490 → FN-514
range only `4d7c0b3f2` and `7673d7936` (FN-493, corner quadrants) touched these primitives, and
FN-493 did not touch the ref. FN-512 needed the overlay element for measurement, so it replaced
the stable ref in **both** containers:

```diff
-      ref={windowSurface.rootRef}
+      ref={(node) => {
+        overlayRef.current = node;
+        windowSurface.rootRef(node);
+      }}
```

## Root cause

`useDashboardWindowSurface` returns an intentionally **stable** `rootRef`. Wrapping it in an
inline arrow function destroyed that stability, and the window manager is a publish/subscribe
registry, so instability became a feedback loop:

1. The inline `ref` callback has a new identity on every render.
2. React therefore detaches the old callback with `null`, then attaches the new one with the node.
3. Both calls reach `publish(...)` → `upsertSurface(...)`.
4. `upsertSurface` compares `previous.root !== surface.root`: `element → null` and
   `null → element` are two genuine changes, so `setSurfaceRevision` increments twice.
5. The provider re-renders its consumers, the container renders again, and step 1 repeats.
6. React aborts the recursion with `Maximum update depth exceeded`.

Closely related compositions were already correct and are useful negative controls:
`DashboardWindowSurfaceRoot` composes its refs inside a `useCallback` keyed on
`surface.rootRef`, while `UiDialog`/`UiDialogBackdrop` pass `windowSurface.rootRef` directly.

## Fix

In `FloatingWindow.tsx` and `MobileDrawer.tsx`, compose the local element ref and the registry
callback in a `useCallback` whose **only** dependency is `windowSurface.rootRef`:

```tsx
const setOverlayRef = useCallback((node: HTMLDivElement | null) => {
  overlayRef.current = node;
  windowSurface.rootRef(node);
}, [windowSurface.rootRef]);
```

Deliberately **not** done:

- Depending on the whole `windowSurface` binding — it is a fresh object each render, so the
  callback identity would churn exactly as before.
- Swallowing `null` inside the callback or inside `upsertSurface` — a real detach must still
  release the surface, otherwise unmounted windows leave phantom registrations.
- Removing the `previous.root` equality check, debouncing publications, counting renders, or
  disabling `StrictMode`. Each hides the loop instead of removing it.

## Why the pre-existing tests did not catch it

`MobileDrawer.test.tsx` and `mobile-keyboard-surfaces.integration.test.tsx` mount the containers
**without** `DashboardWindowManagerProvider`. With no provider, `upsertSurface` is `undefined`,
`publish` returns immediately, and no state is ever set — so the ref churn is invisible. The
causal participant is the provider, not the container alone.

## Regression coverage

`packages/dashboard/app/__tests__/modal-open-update-depth.integration.test.tsx` mounts the real
`RootErrorBoundary`, the real `DashboardWindowManagerProvider` and the real primitives, starts
**closed**, and clicks to open across phone 390×844, 320, phone landscape 932×430, tablet 768 and
900, and desktop 1280×900, in ordinary mode and under `StrictMode`. It asserts that no
`Maximum update depth exceeded` reaches `console.error`, that the fallback does not render, that
multi-character typing survives, that the DOM element identity survives an owner re-render with
new handler identities, and that the visible-surface count is exact (duplicate logical ids, a
closed `keepMounted` window, unmount → zero). The loop is never simulated with a thrown error and
the registry is never mocked.

## Limits

jsdom performs no layout, so the viewport matrix drives explicit metrics and proves registry,
state and identity behavior — not a rendered Safari/WKWebView or Android result. No browser was
reachable during this work, so the operator's own device incident is attributed to this commit by
diff and reproduction, not by on-device capture.

## Rule of thumb

A ref callback that publishes into a context is a **render input**. Give it a stable identity, or
the publication will re-render the component that owns the callback and the component will hand
React a new callback to re-run.
