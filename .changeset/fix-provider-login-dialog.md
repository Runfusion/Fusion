---
"@runfusion/fusion": patch
---

summary: Show a persistent sign-in dialog during provider logins, with the paste field and status always visible.
category: fix
dev: New `ProviderLoginDialog` replaces the vanishing pre-flight confirm plus card-inline paste field for `requiresManualCode` OAuth flows. It is rendered as a SIBLING of the onboarding FloatingWindow (a portal moves the DOM node but not the React tree, so events bubbled to the window's raise-to-front handler and lifted it above the dialog), claims `nextFloatingZ()` once on open, and stops pointer propagation — now ratcheted for every portaled `.modal-overlay` in FloatingWindow.test.tsx. Spacing uses the shared `.modal-header`/`.modal-actions` primitives with `var(--modal-padding)` on every row; the paste field sinks to `var(--bg)` because `.form-input` and `.modal` both resolve to `var(--surface)`; the paste region is pinned outside the scroll area so Submit cannot scroll out of reach. Dialog anatomy rules documented in docs/dashboard-guide.md.
