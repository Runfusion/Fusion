---
"@runfusion/fusion": patch
---

summary: Fix cross-project data mixups by separating a record's owning project from PostgreSQL isolation.
category: fix
dev: Migration 0011 adds `owner_project_id` to research_runs, experiment_sessions, todo_lists, eval_runs, chat_sessions, chat_rooms, ai_sessions, chat_token_usage, project_insights, project_insight_runs, and cli_sessions (backfilled from the previously conflated `project_id`, `__legacy_unscoped__` → NULL). Stores now write/read the domain project through `owner_project_id`; `project_id` stays the RLS partition owned by the `fusion_assign_project_id` trigger and the `fusion.project_id` GUC, fixing composite-FK 23503 failures when a caller's domain projectId differed from the session partition.
