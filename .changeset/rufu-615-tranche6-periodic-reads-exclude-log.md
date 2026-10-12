---
"@runfusion/fusion": patch
---

summary: Periodic board reads stop decoding the task-log text they never look at, cutting per-pass memory.
category: performance
dev: Ten scheduler / GitHub+GitLab reconciler / planning `listTasks` call sites now pass `excludeLog: true`, proven per file to have zero `task.log` reads. A V8 sampling heap profile attributed 1,187 MiB of one 10-minute window to `listTasksImpl -> rowToTask -> fromJson`, where `tasks.log` averaged 56 KB per card. New ratchet `list-tasks-full-hydration-ratchet.test.ts` fails on a new unbounded full read and on a ledger that stops shrinking.
