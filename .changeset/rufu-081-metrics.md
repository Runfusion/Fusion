---
"@runfusion/fusion": minor
---

summary: Add a Prometheus-format /metrics observability endpoint to the dashboard.
category: feature
dev: New GET /metrics route on the dashboard server exposes runtime (process CPU user/system time, heap/RSS memory, request count and latency histogram, child-process and git-spawn counters) and domain (projects active/idle, board tasks, running agents, PostgreSQL queries per second) metric families in Prometheus text exposition format. Sampling is interval-based with an in-flight tick guard and keeps the PostgreSQL sampler baseline stable across transient failures. Bound to the existing dashboard port; no new network surface.
