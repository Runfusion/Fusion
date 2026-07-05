---
"@runfusion/fusion": patch
---

summary: Stop Plan Review from looping tasks forever and fix its "can't find the plan" reviews.
category: fix
dev: FN-7561 — Plan Review pre-merge gate hardening in packages/engine/src/executor.ts. (1) The reviewer ran readonly with cwd=worktree but the spec lives at project-root .fusion/tasks/<id>/PROMPT.md, so "Read PROMPT.md" produced "no PROMPT.md found / data is in a DB" non-verdicts; the spec text is now injected into the reviewer prompt via readTaskArtifact. (2) A malformed reviewer response now self-retries once on the primary model when no fallback is configured. (3) A malformed (advisory_failure, no verdict) plan-review result can never trigger a triage replan. (4) The unbounded plan-review replan default is capped at 15 attempts with a loud halting log entry, so a persistently-disagreeing planner/reviewer no longer burns LLM calls indefinitely (FN-7525 ran 13+ attempts overnight).
