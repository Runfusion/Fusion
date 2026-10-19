---
"@runfusion/fusion": patch
---

summary: Ghost-bug preflight now verifies the task's own revision and durably holds cards it cannot prove.
category: fix
dev: Probe target resolves a proven revision (task branch tip `refs/heads/<branch>`, then recorded base commit, then an identity-proven baseline) with resolve-once owned-worktree validation and a per-command-group repository-identity fence; any unproven outcome pauses with the fixed reason `ghost-bug-preflight-unverified` (pause + history in one atomic conditional write). A legitimate archive commits its decision inside the move's own transaction via a new optional fenced-decision parameter on `moveTaskIf`.
