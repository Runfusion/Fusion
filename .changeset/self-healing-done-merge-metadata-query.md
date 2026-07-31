---
"@runfusion/fusion": patch
---

summary: Completed tasks get their merge metadata repaired again on renamed boards.
category: fix
dev: `recoverDoneTaskMergeMetadata` read the literal `done`, so on a renamed board a completed card's merge metadata was never repaired and could keep pointing at a commit that is not the one that landed. Read resolves via `resolveProjectColumnsForRoles(["complete"])` — deliberately not the terminal union — and the per-card check resolves per card.
