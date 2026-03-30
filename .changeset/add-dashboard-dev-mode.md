---
"@dustinbyrne/kb": minor
---

Add `--dev` CLI option to `kb dashboard` for dashboard-only mode

The new `--dev` flag starts only the web UI without initializing the AI engine components (TriageProcessor, TaskExecutor, Scheduler) or auto-merge queue. This enables development workflows where the dashboard runs standalone while the engine operates in a separate process.

Usage: `kb dashboard --dev`
