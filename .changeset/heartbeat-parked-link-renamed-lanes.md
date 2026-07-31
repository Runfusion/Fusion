---
"@runfusion/fusion": patch
---

summary: Agents no longer appear to be running a parked task on boards with renamed columns.
category: fix
dev: Both `isParkedTaskColumn` call sites in `agent-heartbeat.ts` omitted the resolved `parkedColumns` argument and took the legacy `todo`/`triage` default, so the stale-link clear never fired on a renamed board. Both now pass the task's resolved `hold`/`intake` lanes.
