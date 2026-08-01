---
"@runfusion/fusion": patch
---

summary: Leaked verification worktrees are now reaped, so planning no longer queues behind exhausted slots.
category: fix
dev: mission-verification's fn-verify-* checkouts leaked on process death (dispose is in-process best-effort); the self-healing temp-dir sweep now includes the fn-verify- prefix under tmpdir() with the same age gates and active-session refusal.
