---
"@runfusion/fusion": minor
---

summary: Show collector health per server: heartbeat age, spool depth, and parse and delivery failures.
category: feature
dev: Migration 0090 adds nullable health columns to external_session_hosts. The collector heartbeat carries optional counters; null means unreported and is never rendered as zero. An older collector's heartbeat cannot blank a newer one's reported health.
