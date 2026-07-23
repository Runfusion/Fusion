---
"@runfusion/fusion": patch
---

summary: Fix embedded PostgreSQL crash-recovery boot on Windows — no self-shutdown race, no 30s .pgrunner log stall.
category: fix
dev: Issue #2411 (beta.4 follow-up). pgctl runner logs moved to a sibling `.pgrunner-<dataDirName>` dir so crash recovery's data-dir fsync walk never hits them (legacy in-dataDir `.pgrunner` is swept); the elevated readiness scan ignores 57P03 recovery rejections; owned starts wait for the cluster to accept connections before ensureDatabase (bounded by the start timeout); the join verify retries 57P03 for up to 15s; startup-factory's joined-instance-unreachable retry backs off across ~15s instead of one 500ms attempt.
