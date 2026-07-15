---
"@runfusion/fusion": patch
---

summary: Fix startup failures when several projects migrate against one PostgreSQL cluster at the same time.
category: fix
dev: Migration 0006's `fusion_runtime` setup used a check-then-CREATE ROLE that cannot be atomic — roles live in cluster-wide `pg_authid`, but the applier's `pg_advisory_xact_lock('fusion:schema-applier')` is per-database, so concurrent appliers on different databases of one cluster all saw the role as absent and raced, and the losers failed with 23505 on `pg_authid_rolname_index`. The create now tolerates losing the race (`EXCEPTION WHEN duplicate_object OR unique_violation`), catching the index-level violation the race actually raises as well as the plain duplicate.
