---
"@runfusion/fusion": patch
---

summary: Fix Planning Mode and Settings dropping typed text after the first character.
category: fix
dev: The FN-8606 floating-window migration declared `ModalShell` as a component inside `PlanningModeModal`/`SettingsModal` render, so each render produced a new element type and remounted the whole subtree, destroying the focused input. Replaced with a plain `renderModalShell(children)` call so element types stay stable.
