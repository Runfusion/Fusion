---
"@runfusion/fusion": minor
---

summary: Navigation quick access now has five configurable slots, including Chat, shared by desktop and mobile.
category: feature
dev: `MAX_MOBILE_NAV_PRIMARY_ITEMS` goes from 4 to 5 and `chat` becomes an eligible quick-access destination with a `chat` entry in the shared navigation registry, so the wide footer's right-hand slot renders the fifth resolved shortcut instead of a hardcoded Chat button. `resolveMobileNavPrimaryItems` now completes ANY shorter valid selection up to five from `DEFAULT_MOBILE_NAV_PRIMARY_ITEMS` (which ends with `chat`), preferring its tail; this is render-time only, so existing four-destination values keep Chat at the far right with no migration and no second settings key. Removed: the mobile footer swipe-up-to-open-Chat shortcut (the `useFooterSwipeUpGesture` hook now opens the navigation menu behind the new project setting `mobileNavMenuSwipeGesture`, which hides the hamburger and renders the menu as a bar-width drawer) and the mobile shell's dynamic promotion of unconfigured destinations (`MOBILE_NAV_DYNAMIC_PROMOTION_ORDER`, `MAX_MOBILE_NAV_DIRECT_DESTINATIONS`, `computeMobileNavDirectDestinationCount`, slot-width measurement), which made the pill diverge from the desktop bar for the same configuration.
