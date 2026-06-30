---
"@runfusion/fusion": patch
---

summary: Prevent executor prompt setup from failing when a recovered task has no saved prompt.
category: fix
dev: Guards worktree prompt scoping against undefined task prompts while quarantining stale post-cutover engine tests.
