---
"@fusion/core": minor
"@gsxdsm/fusion": minor
---

Add migration and first-run experience for multi-project support

- Auto-detect and register existing projects on first run after upgrade
- Maintain backward compatibility for single-project workflows
- Interactive first-run setup wizard in dashboard
- Add `fn init` command for initializing new projects
- Add `/api/setup-state` and `/api/complete-setup` dashboard endpoints
- Idempotent migration — safe to re-run
- Rollback procedure documented in AGENTS.md
