---
"@runfusion/fusion": patch
---

summary: Approval reuse now works on PostgreSQL instead of minting a duplicate request every retry.
category: fix
dev: `ApprovalRequestStore.findLatestByDedupeKey` fed Drizzle's already-parsed jsonb `targetContext` through the string-only `fromJson`, so the dedupe scan never matched in backend mode. Adds `normalizeTargetContext` to handle both the SQLite JSON-string and PG parsed-object shapes at `rowToRequest` plus both dedupe scan sites.
