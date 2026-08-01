---
"@runfusion/fusion": patch
---

summary: Scheduler, merge queue, and continuation drain recover loudly from a hung pass instead of dying silently.
category: fix
dev: Same shape as the triage-poll death — a stuck re-entrance guard dropped every later tick without a log. Each pump now records its pass start and force-opens the guard past a duration sized to its legitimate work (schedule 10min, merge drain 30min, continuation drain 5min), logging a WARN with the stuck duration.
