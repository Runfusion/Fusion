---
"@runfusion/fusion": patch
---

Lock in defaults: worktrunk integration is off by default (opt-in), and the per-project worktree directory defaults to `<projectRoot>/.worktrees` when `worktreesDir` is unset. Regression tests now guard both invariants.
