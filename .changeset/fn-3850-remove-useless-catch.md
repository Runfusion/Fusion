---
"@runfusion/fusion": patch
---

Remove a useless try/catch wrapper in the engine's `execute-once-then-complete` approval gate. Internal cleanup; no behavior change. Eliminates the workspace's last ESLint `no-useless-catch` warning.
