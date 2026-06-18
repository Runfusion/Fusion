---
"@runfusion/fusion": patch
---

Fix the perpetual step off-by-one: `fn_task_update` and `fn_review_step` now treat `step` as 0-based, matching the `### Step N:` numbering in PROMPT.md (Step 0 = Preflight) and `TaskStore.updateStep`. Previously the tools were 1-indexed while everything agent-facing was 0-based, so agents could not mark Step 0 done and reviews/progress landed one step early.
