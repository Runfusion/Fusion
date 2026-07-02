---
"@runfusion/fusion": minor
---

summary: Goals work on the PostgreSQL backend — the Goals view and mission goal-links load instead of erroring.
category: feature
dev: Ports GoalStore to the AsyncDataLayer. Adds AsyncGoalStore (over the existing async-goal-store.ts helpers; ACTIVE_GOAL_LIMIT enforced atomically in the helpers' transactionImmediate, same as sync). getGoalStoreImpl returns it in backend mode; the dashboard /api/goals routes await it and the interim 503 is removed. Reverts the PG-mode goal-resolution degradations added earlier — mission routes and `fn mission` now resolve/validate real linked goals on both backends. CLI goals/mission/extension and engine agent-tools converted to await; goal-injection-diagnostics stays on its instanceof-guarded sync fallback. Adds goal-store.pg.test.ts to test:pg-gate.
