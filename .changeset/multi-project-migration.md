---
"@fusion/core": minor
"@fusion/engine": minor
"@gsxdsm/fusion": minor
---

Add migration and first-run experience for multi-project support

- Auto-detect and register existing kb projects on first run
- MigrationOrchestrator with filesystem scanning and safety checks
- FirstRunExperience with setup wizard state management
- Backward-compatible single-project mode (TaskStore.getOrCreateForProject)
- `--project` flag support for CLI multi-project targeting
- `KB_SKIP_MIGRATION` environment variable for recovery
- Graceful fallback when central database unavailable
- New `fn init` command to initialize kb projects
- Interactive first-run setup wizard API in dashboard
- Idempotent migration — safe to re-run
- Rollback procedure documented in AGENTS.md
