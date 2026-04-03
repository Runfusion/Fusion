---
"@gsxdsm/fusion": patch
---

Fix data corruption where steering comments duplicated in the comments field on every read-write cycle. The `rowToTask()` merge of `steeringComments` into `comments` was redundant since `addSteeringComment()` already writes to both columns. Also adds id-based deduplication to recover from prior corruption.
