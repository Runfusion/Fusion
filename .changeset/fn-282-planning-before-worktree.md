---
"@runfusion/fusion": minor
---

summary: Plan tasks on main before creating worktrees and separate AI concurrency from worktree capacity.
category: feature
dev: Removes resolver fields `effectiveLimit`/`bindingKnob`, API fields `effectiveMaxConcurrent`/`concurrencyBindingKnob`, and planning-worktree acquisition; adds required `consumesWorktree` admission classification.
