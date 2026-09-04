---
"@runfusion/fusion": patch
---

summary: Return the persisted prompt in task updates so prompt write read-back verifies.
category: fix
dev: `updateTask` assigns the prompt onto the returned task only after PROMPT.md reaches disk; prompt-derived declaredSymbols persist only after that write and retry if the follow-up row write fails so file and symbols cannot diverge; current-plan evidence is captured afterward and a capture failure does not reject the durable prompt (reconciliation repairs it). The PG `tasks` row has no `prompt` column. Regression tests cover read-back, write-failure isolation, symbol isolation, deferred evidence repair, and symbols-persist retry.
