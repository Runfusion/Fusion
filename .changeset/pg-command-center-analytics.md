---
"@runfusion/fusion": minor
---

summary: Command Center productivity, team, token, and tool analytics work on the PostgreSQL backend.
category: feature
dev: Ports aggregateProductivityAnalytics/aggregateTeamAnalytics/aggregateTokenAnalytics/aggregateToolAnalytics to accept Database | AsyncDataLayer, adding a PG branch ("ping" in dbOrLayer) that runs schema-qualified raw SQL over project.tasks/task_commit_associations/pull_requests/agents/usage_events/approval_request_audit_events with snake_case columns and the same aggregation semantics as the SQLite path. The command-center tokens/tools/productivity/team routes pass getAsyncLayer() ?? getDatabase() and await; the interim 503 guards are removed. GitHub-issue, signal, and live-snapshot analytics remain 503 in PG mode (follow-up). Adds command-center-analytics.pg.test.ts to test:pg-gate.
