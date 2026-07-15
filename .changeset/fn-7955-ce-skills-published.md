---
"@runfusion/fusion": patch
---

summary: Fix Compound Engineering plugin skills missing from the published package.
category: fix
dev: Stages bundled plugin src/skills into dist/plugins/<id>/skills during bundlePluginEntry() for #2094 / FN-7955.
