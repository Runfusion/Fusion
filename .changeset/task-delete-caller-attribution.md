---
"@runfusion/fusion": patch
---

summary: Task deletions now record who asked — operator UI, CLI, agent tool, engine, or unattributed API.
category: fix
dev: Adds the `TaskDeleteCallerKind` union plus `callerKind`/`callerTaskId` in `task:deleted` run-audit metadata (both SQLite and PG delete paths). The dashboard client sends a self-reported `x-fusion-client: dashboard-ui` header that the DELETE route maps to `operator-ui`, defaulting to `api-unattributed`. Attribution only — not authentication, and no delete gating was added.
