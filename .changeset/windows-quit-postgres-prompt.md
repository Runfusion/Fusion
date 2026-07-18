---
"@runfusion/fusion": minor
---

summary: Closing the Windows desktop app now asks whether to also shut down the embedded PostgreSQL server.
category: feature
dev: "User-initiated window close on win32 shows a sync dialog (default: shut down); 'leave it running' skips only the embedded-cluster teardown in stopLocal({keepEmbeddedPostgres}) so pools/runtime still close. Programmatic quits (dashboard restart) never prompt and keep the full stop."
