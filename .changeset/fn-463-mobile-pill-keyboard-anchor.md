---
"@runfusion/fusion": patch
---

summary: Keep the mobile navigation pill anchored at the bottom when the keyboard opens.
category: fix
dev: Removes the `--mobile-nav-keyboard-lift` token and `computeMobileNavKeyboardLift`; `--mobile-nav-pill-bottom` is now `--mobile-nav-system-offset` plus `--mobile-nav-floating-gap` only, while `--mobile-nav-viewport-offset-top` still feeds the popover height cap.
