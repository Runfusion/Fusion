---
"@runfusion/fusion": patch
---

summary: Fix background SQLite integrity checks holding short-lived CLI commands open unnecessarily.
category: fix
dev: `integrityCheckSqliteFileAsync`'s spawned `sqlite3` child (+ stdio) is now unref'd via the shared `unrefQmdChildProcess` helper, and `scheduleBackgroundIntegrityCheck`'s 60s scheduling timer is now `.unref()`'d, so a short-lived process (e.g. a `fn` one-shot CLI command) that opens a disk-backed `Database` exits promptly instead of being pinned by the background integrity check (FN-7706/FN-7707-class leak). Audited every other non-FN-7708 inline spawn site across `@fusion/core`/`@fusion/engine`/`@fusion/dashboard`/cli and found them SAFE (synchronous, awaited-as-own-work, or intentionally-tracked persistent processes) — see FN-7709's audit document.
