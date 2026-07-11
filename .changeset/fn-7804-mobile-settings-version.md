---
"@runfusion/fusion": patch
---

summary: Mobile Settings footer shows the compact "v0.x" version instead of the full word.
category: fix
dev: SettingsModal picks settings.footer.versionShort ("v{{version}}") when viewportMode === "mobile".
