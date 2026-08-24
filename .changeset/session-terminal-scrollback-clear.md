---
"@runfusion/fusion": patch
---

summary: The agent session terminal clears before replaying scrollback, as its protocol intended.
category: internal
dev: `cli-session-ws.ts` sends scrollback as its own frame explicitly "so the client can clear before replay", but `SessionTerminal` handled `scrollback` identically to `data` and appended. Latent rather than live — every reattach path there rebuilds a fresh xterm via `reattachEpoch` — but it becomes the duplicated-history bug just fixed in the PTY terminal the moment an in-place reconnect is added. Also drops dead `centralDbPath` plumbing in `BackupManager`/`createBackupManager`: it was written, never read (PgBackupManager takes only `includeCentral`), and a leftover of the removed SQLite file-copy backup — the same kind of stale artifact whose presence was being used as evidence about a Postgres install in onboarding.
