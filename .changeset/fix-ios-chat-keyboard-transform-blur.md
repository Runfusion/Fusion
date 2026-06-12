---
"@runfusion/fusion": patch
---

Fix the mobile chat keyboard collapsing on iOS Safari. Several ancestor/scroll mutations were blurring the focused composer textarea:

1. `.chat-thread--keyboard-active` declared `transform: translateY(...)` + `will-change: transform` in CSS, keeping a non-`none` transform on `.chat-thread` (an ancestor of the composer) for the whole keyboard-active window. The drift compensation is now applied imperatively in JS only when iOS actually shifts the visual viewport (`offsetTop > 0`), so the ancestor stays `transform: none` on focus.

2. The mobile keyboard scroll-lock pinned `body { position: fixed }` a beat after the composer was focused — the textbook iOS keyboard-dismiss trigger. App-level and ChatView keyboard pins now use a new `useMobileKeyboardViewportLock` that locks `overflow: hidden` + `scrollTo(0, 0)` WITHOUT changing `position` (the same approach the Quick Chat panel uses), so iOS keeps the input focused. Modals are unchanged and keep the `position: fixed` lock.

3. The direct-chat composer's `handleInputFocus` ran `window.scrollTo(0, 0)` on every focus to undo iOS layout drift. That scroll fires while iOS is still raising the keyboard, which aborts the raise — the keyboard opened then immediately dismissed on re-focus (first tap fine, every tap after a dismiss broken). The drift reset now happens on **blur** instead — when the keyboard is already closing, so there is nothing to dismiss — immediately plus a short follow-up that is cancelled on the next focus, so a fast re-tap can't scroll mid-raise. Each focus therefore starts at `scrollY 0` and the keyboard lock's `scrollTo(0, 0)` is a harmless no-op.

4. The mobile bottom nav stayed on screen while the keyboard was up: `.mobile-nav-bar--keyboard-open` only pinned it to `bottom: 0` and relied on the keyboard to cover it, but on iOS the layout viewport doesn't shrink, so the bar overlapped the composer. It now slides fully off-screen (`translateY(100%)` + `pointer-events: none`) while typing. Safe for the keyboard because the nav is a sibling of the input, not an ancestor.
