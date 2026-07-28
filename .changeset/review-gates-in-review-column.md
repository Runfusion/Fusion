---
"@runfusion/fusion": minor
---

summary: Code Review and Browser Verification now run with the card in In review, showing the step as a card badge.
category: feature
dev: Moves the `code-review` / `browser-verification` optional-group nodes to `column: "in-review"` in the shared stepwise coding IR (inherited by `builtin:coding`, `builtin:stepwise-coding`, `builtin:brainstorming`, `builtin:coding-ideas`); their remediation nodes stay in `in-progress`, so a changes-requested verdict sends the card back to implementation. The dashboard badge was already lane-gated on `column === "in-review"`. Because `in-review` has no `wip` trait the slot is released during review, so the remediation crossing back into `in-progress` can hit the non-bypassable in-transaction capacity check; `workflow-column-boundary.onNodeEntry` now PARKS the run on a `capacity-exhausted` rejection instead of failing it, preserving the failed gate result and worktree so the next graph run retries once a slot frees. Non-capacity rejections still propagate. The legacy `builtin:legacy-coding` IR keeps its historical placement.
