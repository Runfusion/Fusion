---
"@runfusion/fusion": patch
---

summary: Style the Thinking Level dropdown to match the dark model picker across all surfaces.
category: fix
dev: Adds a `.thinking-level-select` rule in CustomModelDropdown.css mirroring the canonical dark `select` tokens; fixes the OS-default white control shown in model pickers incl. the quick-add QuickEntryBox/InlineCreateCard popups. No logic/prop changes.
