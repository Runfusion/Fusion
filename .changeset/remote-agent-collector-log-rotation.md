---
"@runfusion/fusion": patch
---

summary: Remote-agent collector logs are timestamped and can rotate themselves, so they stay small and can be dated.
category: fix
dev: Collector lines carry UTC timestamps (omitted under journald, which adds its own). `--log-file` writes the log directly and rotates it at 10 MiB with three older copies; the launchd example uses it because launchd never rotates `StandardOutPath`.
