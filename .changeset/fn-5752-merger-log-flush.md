---
"@runfusion/fusion": patch
---

Fix merger agent-log visibility by flushing buffered `AgentLogger` output before disposing AI sessions used for autostash conflict resolution, autostash hard-fail recovery, and rebase conflict resolution. This ensures trailing text/thinking deltas are persisted so merger activity reliably appears in the task agent log panel.
