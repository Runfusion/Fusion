---
"@runfusion/fusion": patch
---

summary: Fix legacy databases missing newer task columns (e.g. checkout-lease, column dwell) after upgrade.
category: fix
dev: parseCreateTableSchemasFromSql now strips `--` comments before the non-greedy CREATE TABLE body regex, so a `);` inside a schema comment can no longer truncate a parsed table body and silently drop columns from ensureSchemaCompatibility()'s backfill set.
