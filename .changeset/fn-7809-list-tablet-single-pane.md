---
"@runfusion/fusion": patch
---

summary: Fix the List view controls and quick-add box being cut off on tablet-width screens.
category: fix
dev: ListView collapses to a single-pane layout at the `useViewportMode()` "tablet" tier (769–1024px) instead of the desktop two-pane split, which lacked horizontal room and clipped the primary action cluster and expanded QuickEntryBox. Split-vs-single now keys off a shared narrow gate; touch-only long-press stays gated on mobile.
