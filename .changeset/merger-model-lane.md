---
"@runfusion/fusion": minor
---

summary: Make the merger AI model configurable under Global and Project Models.
category: feature
dev: Adds project `mergerProvider`/`mergerModelId`/`mergerThinkingLevel` and global `mergerGlobalProvider`/`mergerGlobalModelId`/`mergerGlobalThinkingLevel`. Resolution is project merger → global merger → project/global default; does not inherit executor/planner/reviewer lanes.
