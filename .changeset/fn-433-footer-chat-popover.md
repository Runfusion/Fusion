---
"@runfusion/fusion": patch
---

summary: Bottom-bar Chat now opens the conversation list above its button instead of off-screen.
category: fix
dev: DashboardToolPopover resolves placement from measured geometry (`resolveToolPopoverGeometry`, `data-placement="above" | "below"`, never both `top` and `bottom`) and accepts an opt-in `preferredHeight` bounded by the available space; App passes `preferredHeight={560}` to the Chat panel only, so the virtualized conversation list has a measurable viewport. Header Activity and Notes keep their previous below-anchored geometry.
