---
"@runfusion/fusion": patch
---

summary: Keep the header Usage popover and the footer More menu above open windows.
category: fix
dev: Both surfaces now derive their layer from the live `--fusion-max-z` ceiling published by `floatingWindowStack.ts` (backdrop `+2`, panel `+3`) instead of static 30/90/91/100/101 values. The Usage popover is portaled to `document.body` so it is compared in the root stacking context, and the desktop/tablet footer carries the elevation on `.desktop-action-bar--menu-open` because the bar's `--z-sticky` stacking context traps its absolutely positioned menu.
