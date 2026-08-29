---
"@runfusion/fusion": patch
---

summary: A failed merge no longer strands review-column tasks on their verification and delivery gates.
category: fix
dev: Two seal fixes in `execute-workflow-graph.ts`. (1) A `workflowAction: "deterministic-verification"` gate is no longer treated as write-capable: it needs a worktree to run the project's test/build commands but only reads the tree, and `workflowNodeRequiresWorktree` conflates the two via a name match on `/review|verification/i`. (2) A gate whose result is already `passed` or `skipped` resolves as satisfied instead of being refused, because a post-approval requeue (merge conflict, transient merge failure) replays the pre-review chain and re-running those gates would rewrite the very tree the review approved. Both turned a retryable merge into a terminal wedge, measured by pipeline-smoke S13.
