---
"@runfusion/fusion": minor
---

summary: Navigation quick access now holds 4 destinations; swipe the mobile bottom bar up to open Chat.
category: feature
dev: `MAX_MOBILE_NAV_PRIMARY_ITEMS` drops from 5 to 4 and `DEFAULT_MOBILE_NAV_PRIMARY_ITEMS` loses `mailbox`; the `mobileNavPrimaryItems` key is reused with no migration (a persisted five-entry value is truncated and its fifth entry falls back to More). `chat` stays out of `MOBILE_NAV_PRIMARY_SELECTABLE_ITEMS`: the fifth footer slot is the existing `desktop-nav-chat-panel` button on the wide footer and the More-menu row on mobile. New touch-only hook `useFooterSwipeUpGesture` (passive `touchstart` on the pill, non-passive document `touchmove`, claim threshold, full cleanup before callback, one-shot ghost-click suppression) is consumed only by `MobileNavBar` and routes through the same `onChangeView("chat")` owner as the menu row.
