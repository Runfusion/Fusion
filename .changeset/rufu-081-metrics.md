---
"@runfusion/fusion": minor
---

summary: Add a Prometheus-format /metrics observability endpoint to the dashboard.
category: feature
dev: New GET /metrics route on the dashboard server exposes runtime (process CPU user/system time, heap/RSS memory, request count and latency histogram, child-process and git-spawn counters) and domain (projects active/idle, board tasks, running agents, PostgreSQL queries per second) metric families in Prometheus text exposition format. Sampling is interval-based with an in-flight tick guard and a generation fence so a pre-close sample can never overwrite post-restart state. The PostgreSQL sampler tracks counters per database: a failed-probe gap invalidates the retained baseline (the first success after the gap re-baselines and keeps the last-known rate, so a stats reset inside the gap can never produce a cross-epoch rate), and a per-database backward delta is treated as a stats reset even when the cross-database sum stays positive. Bound to the existing dashboard port; no new network surface.
