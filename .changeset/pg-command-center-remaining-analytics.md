---
"@runfusion/fusion": minor
---

summary: Command Center workflow, GitHub-issue, signal, and live-snapshot analytics now work on the PostgreSQL backend.
category: feature
dev: Ports aggregateWorkflowAnalytics/aggregateGithubIssueAnalytics/aggregateSignalsAnalytics/composeLiveSnapshot to accept Database | AsyncDataLayer, adding a PG branch ("ping" in dbOrLayer) that runs schema-qualified raw SQL over project.tasks/task_workflow_selection/workflows/incidents/cli_sessions/agent_runs with snake_case columns and the same aggregation semantics as the SQLite path. The command-center workflows/github/signals/live routes pass getAsyncLayer() ?? getDatabase() and await; the interim 503 guards are removed. Every /api/command-center/* route now functions in backend mode. Adds command-center-remaining-analytics.pg.test.ts to test:pg-gate.
