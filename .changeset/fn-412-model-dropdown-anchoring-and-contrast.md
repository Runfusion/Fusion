---
"@runfusion/fusion": patch
---

summary: Model picker now stays anchored to its chat window and stays readable in dark mode.
category: fix
dev: CustomModelDropdown and ChatThinkingLevelControl re-anchor on FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT plus capture-phase pointermove/pointerup; downward placement no longer clamps to the 160px height floor; `.model-combobox-option` resets the native button background/border/width.
