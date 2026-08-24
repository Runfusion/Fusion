---
"@runfusion/fusion": patch
---

summary: Remove retired Board compatibility styling without changing live scrolling behavior.
category: internal
dev: Removes the legacy `.lane-columns` CSS after verifying current selected-workflow and All-workflows Board paths and known/bundled plugin surfaces do not consume it; live desktop containment and phone proximity snapping remain covered by CSS-fixture regression tests.
