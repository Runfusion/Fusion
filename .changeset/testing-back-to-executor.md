---
"@runfusion/fusion": minor
---

summary: Testing returns to the plan; the reviewer judges tests instead of pretending to run them.
category: feature
dev: Removes the `planning-implementation-only` seam and the `requireImplementationOnlySteps` Plan Review criterion from `builtin:coding-ideas-v2`, restoring the default triage prompt's `Testing & Verification` step region (real automated tests only, per-step test authoring, a final lint/tests/typecheck/build pass ordered before delivery). The Code Review prompt no longer instructs a `toolMode: "readonly"` session to run commands it cannot access — `bash` is denied and `fn_run_verification` is not in the readonly allowlist — and instead rules on test existence, realness, behaviour-not-comments, and invariant coverage. Deletes `builtin:review-gated-coding` outright rather than leaving it deprecated: it shared the documentation-delivery node with V2, so it was a silent second consumer of every change made for V2.
