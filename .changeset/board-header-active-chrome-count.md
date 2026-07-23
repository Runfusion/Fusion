---
"@runfusion/fusion": patch
---

summary: Board column headers now count REVISING (replan) cards and other visibly active cards in the processing count.
category: fix
dev: Column header count = shared Running predicate ∪ card activity-chrome predicate (isTaskAgentActive); footer/admission keep live-agent-only semantics.
