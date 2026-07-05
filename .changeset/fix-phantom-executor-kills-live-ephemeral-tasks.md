---
"@runfusion/fusion": patch
---

summary: Stop self-healing from killing actively-running tasks after ~30 minutes.
category: fix
dev: FN-7566. isPhantomExecutorBinding's liveness gate (heartbeat/checkout/runAudit) was blind to ephemeral executor agents, leaving only the age>graceMs*3 threshold, so any ephemeral-executor task running longer than ~30 min was reclaimed to `todo` mid-flight. Adds the in-process live-session veto (activeSessionRegistry path / executingTaskLock / isTaskActive), mirroring the isWorkspaceTaskLive/sessionDead predicate, and honors clearPhantomExecutorBinding's live-session refusal in reclaimSelfOwnedBranchConflicts.
