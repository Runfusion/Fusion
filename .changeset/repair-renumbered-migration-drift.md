---
"@runfusion/fusion": patch
---

summary: Fixes chat failing with "column memory_focus does not exist" — the missing column is now repaired at startup.
category: fix
dev: A ledger row asserts that a migration with a given NUMBER ran, which is not the same claim as "this column exists" once a migration has been renumbered. `0066_chat_session_memory_focus.sql` was renumbered four times (0059 → 0060 → 0061 → 0065 → 0066) as upstream batches claimed each sequence, so a database can carry a row from one numbering while a different migration owned that number on the boot that recorded it. The applier then trusts the ledger, skips the migration, and reports a successful startup over a schema that does not match it; every `chat_sessions` read then fails with `column "memory_focus" does not exist`, because Drizzle's `select()` emits the binary's full column list. Both migrations renumbered on this branch (0066 memory focus, 0067 session contention wait state) now verify their materialized columns in addition to the marker and replay their idempotent `ADD COLUMN IF NOT EXISTS` when a column is absent — the same defence `0047` task recommendations already carried. Covered by two PostgreSQL regression tests that reproduce the drifted state exactly.
