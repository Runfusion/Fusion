---
"@runfusion/fusion": patch
---

summary: Progress-preserving recovery rebounds now keep the task's checkout instead of leaving it to the idle sweep.
category: fix
dev: "Ten self-healing rebounds gained `preserveWorktree: true`; deliberate discards carry a `worktree-discard-intended` marker enforced by a new ratchet test."
