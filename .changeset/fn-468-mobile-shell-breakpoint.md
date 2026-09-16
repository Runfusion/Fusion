---
"@runfusion/fusion": minor
---

summary: Tablets now use the mobile interface, whose floating menu reveals more shortcuts as the screen widens.
category: feature
dev: The measured desktop boundary moves to 1024px (`TABLET_MEDIA_QUERY` is now `(min-width: 769px) and (max-width: 1023.98px)`). A shared `isMobileShellMode` predicate owns navigation-shell decisions: `resolveNavigationSurfaces` mounts wide surfaces only on `desktop`, `MobileNavBar`'s mount predicate covers `mobile` and `tablet`, and the chrome CSS arms move `tablet` from the wide arm to the mobile arm. The pill row is composed from the resolved quick-access selection plus `MOBILE_NAV_DYNAMIC_PROMOTION_ORDER`, truncated by the pure `computeMobileNavDirectDestinationCount` and capped at `MAX_MOBILE_NAV_DIRECT_DESTINATIONS`; promoted destinations are removed from the overflow menu. `resolveChatHost` gains a `mobileShellActive` input so the whole mobile shell resolves to the `"mobile-page"` host (the tablet band otherwise answered `"none"` and rendered an empty main panel), and `MainContent` keys `chatPageHostEnabled` on that host. Tablet touch geometry, full-screen sheets, mobile drawers, and keyboard state stay phone-only.
