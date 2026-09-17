---
"@runfusion/fusion": patch
---

summary: Center the desktop footer shortcuts and drive the phone pill from the quick-access setting.
category: fix
dev: `.desktop-action-bar` becomes a three-track grid whose start and end tracks are the same `minmax(min-content, 1fr)` expression, so the direct row + **More** group is centered on the bar rather than on the residual space; the window-visibility placeholder is placed explicitly in the end track and reserved with `margin-inline-end: var(--touch-target-min-size)` on `.desktop-action-bar__right`, which drops its dead `margin-inline-start: auto`. `MobileNavBar` gains a `quickAccessItems` prop fed from App's live `mobileNavPrimaryItems`, resolved through the shared `resolveMobileNavPrimaryItems`, so the pill renders up to five settings-driven destinations (Board included) instead of a hard-coded four; the `command-center`, `tasks`, `chat`, and `mailbox` registry entries now honor the `surface` argument so overflow navigation closes the popover.
