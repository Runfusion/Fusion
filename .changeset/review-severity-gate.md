---
"@runfusion/fusion": minor
---

summary: Reviews now block only on high-priority findings, cutting repeated plan/code review fix rounds.
category: feature
dev: Adds `applyReviewSeverityGate`/`resolveReviewBlockingSeverity` (`packages/core/src/workflows/review-severity-gate.ts`) making the existing `WorkflowReviewFinding.severity` load-bearing. New per-workflow settings `planReviewBlockingSeverity` (default `high`) and `codeReviewBlockingSeverity` (default `critical`); set either to `any` to restore the previous behavior where every REVISE blocks. A REVISE carrying no finding at or above the threshold is recorded as APPROVE_WITH_NOTES and its findings are written to PROMPT.md as a non-blocking `## Review Advisory Notes` section. Fails closed: a REVISE with no findings, or with any unclassified finding, still blocks. Plan/Code Review prompts now request the structured findings schema, define the severity vocabulary as P0/P1/P2, suppress nits, and use an incremental re-review contract; remediation injection renders findings grouped by priority and sanctions an explicit decline with rationale.
