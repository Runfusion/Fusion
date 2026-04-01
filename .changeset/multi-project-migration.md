---
"@fusion/core": minor
"@gsxdsm/fusion": minor
---

Add migration and first-run experience for multi-project support

- Auto-detect and register existing projects on first run after upgrade
- New `fn init` command to initialize kb projects
- Maintain backward compatibility for single-project workflows
- Interactive first-run setup wizard API in dashboard
- Idempotent migration — safe to re-run
- Rollback procedure documented in AGENTS.md
