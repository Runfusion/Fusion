---
"@runfusion/fusion": minor
---

summary: Duplicate tasks are no longer auto-archived on creation by default — they are flagged for review instead.
category: feature
dev: Adds project setting `autoArchiveDuplicateTasksEnabled` (default false) gating the FN-4892 same-agent duplicate intake path in store `_maybeAutoArchiveSameAgentDuplicate`; disabled path uses new `flagSameAgentDuplicate` and sets `nearDuplicateOf` metadata. Tombstone-resurrection blocking is unchanged.
