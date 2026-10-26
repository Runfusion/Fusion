---
"@runfusion/fusion": patch
---

summary: Board admission holds less card text in memory, cutting repeated full-board retention.
category: performance
dev: The auto-claim snapshot's retained candidate no longer carries `title`, `description`, or `descriptionFirstLine`; the cached board read declares `fields: []`, so no PROMPT.md fan-out runs for a field no reader reads. `resolveFreshAutoClaimCandidates` still returns card text after canonical re-resolution, so its reads declare `fields: ["description"]`.
