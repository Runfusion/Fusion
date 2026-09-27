---
"@runfusion/fusion": patch
---

summary: A project opened through a symlinked path now uses its registered identity instead of a separate data partition.
category: fix
dev: `lookupRegisteredProjectIdByPath` falls back to a unique real-path match when the exact registry path misses. Symptom: remote-agent reads for the dashboard's start project answered 503 "storage unavailable" on macOS temp paths.
