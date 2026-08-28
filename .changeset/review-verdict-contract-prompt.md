---
"@runfusion/fusion": patch
---

summary: Reviewers are now asked for their verdict in a way that covers the case that made one answer in prose.
category: fix
dev: Audit of the `verdictBlock` in `execute-workflow-step.ts`, the last block of a review step's system prompt. Three defects, no behaviour outside the prompt text. (1) Its closing sentence read "Backward compat fallback: if JSON is unavailable, you may still begin output with REQUEST REVISION" — the final words of the whole prompt granted permission to skip the format, and the premise is false since emitting JSON is always possible; the path still exists in the parser but is now stated as degraded rather than alternative. (2) It forbade markdown fences while `parseWorkflowStepVerdict` scans fenced blocks first, making "compliant" narrower than "parseable"; fenced output is now explicitly accepted. (3) It offered APPROVE / APPROVE_WITH_NOTES / REVISE with no legal way to say "I cannot see the change" — the measured multi-repo case, where a reviewer given an empty scope found nothing, had no truthful option and wrote prose instead. That case now maps explicitly onto REVISE with the search stated in notes. A dedicated UNAVAILABLE member would model it better but `WorkflowStepVerdict` has none, and adding one reaches the parser, step results, merge admission and the dashboard — out of proportion to a prompt repair.
