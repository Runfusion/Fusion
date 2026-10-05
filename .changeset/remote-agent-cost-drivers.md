---
"@runfusion/fusion": minor
---

summary: Explain why expensive remote agent work cost what it did, from measured token categories and request volume.
category: feature
dev: costDrivers derives per-category charges from reported counts times the rates actually applied; a test pins that the categories sum to the record's own total. Unpriced records are reported as unexplained rather than folded in at zero.
