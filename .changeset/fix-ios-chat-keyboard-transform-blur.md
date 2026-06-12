---
"@runfusion/fusion": patch
---

Fix the mobile chat keyboard collapsing the instant it opens on iOS Safari. Two ancestor mutations were blurring the focused composer textarea:

1. `.chat-thread--keyboard-active` declared `transform: translateY(...)` + `will-change: transform` in CSS, keeping a non-`none` transform on `.chat-thread` (an ancestor of the composer) for the whole keyboard-active window. The drift compensation is now applied imperatively in JS only when iOS actually shifts the visual viewport (`offsetTop > 0`), so the ancestor stays `transform: none` on focus.

2. The mobile keyboard scroll-lock pinned `body { position: fixed }` a beat after the composer was focused — the textbook iOS keyboard-dismiss trigger. App-level and ChatView keyboard pins now use a new `useMobileKeyboardViewportLock` that locks `overflow: hidden` + `scrollTo(0, 0)` WITHOUT changing `position` (the same approach the Quick Chat panel uses), so iOS keeps the input focused. Modals are unchanged and keep the `position: fixed` lock.
