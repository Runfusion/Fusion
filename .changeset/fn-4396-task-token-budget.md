---
"@runfusion/fusion": minor
---

Add per-task token-budget alerts. Soft cap emits a single notification; hard cap pauses the task with `pausedReason: token_budget_exceeded`. New project/global setting `taskTokenBudget` with optional per-size (S/M/L) overrides; new per-task `tokenBudgetOverride` set on resume. New optional `token-budget` ntfy event.
