---
"@runfusion/fusion": patch
---

summary: Block empty-diff task finalizes that skipped verification steps so reverted work can't reach done.
category: fix
dev: Generalizes evaluateNoCommitsNoOpFinalize (packages/core) to block any zero-diff finalize when a step is skipped — verification/QA/review-named skips block unconditionally, other skips block unless every non-skipped step is done AND the task is noCommitsExpected. Applies at all finalize lanes (merger-ai empty lane, merger.ts, self-healing stranded-todo promoter + no-op review finalize). Closes the FN-8141 laundering path.
