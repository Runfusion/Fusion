---
"@runfusion/fusion": patch
---

summary: New tasks no longer sit queued for minutes when a triage poll hangs — a watchdog recovers admission loudly.
category: fix
dev: One hung poll left this.polling true forever, silently dropping every 15s tick and task:created wake (observed as 5-10 min "Queued to plan" with open capacity, rescued only by unrelated sweeps). Past 120s the guard force-opens with a WARN naming the stuck duration.
