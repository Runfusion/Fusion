---
"@runfusion/fusion": patch
---

summary: Reverted-work tasks no longer merge to done as empty no-ops; they park for review.
category: fix
dev: merger-ai.ts empty-outcome lane now requires positive already-landed proof (recorded merge, prior no-op proof, branch tip ancestor of main, or a strong already-on-main classifier match) before finalizing a commit-expected task; otherwise it sets task.error, emits `task:empty-merge-finalize-blocked-no-landed-proof`, and moves the task back to todo. Same guard mirrored in the workspace all-empty finalize (blocks the reverted/net-zero shape). noCommitsExpected tasks keep their existing path (FN-8141).
