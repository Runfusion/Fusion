---
"@runfusion/fusion": patch
---

summary: Prevent chat checkpoints from failing on NUL-containing tool output.
category: fix
dev: Sanitizes chat JSONB persistence boundaries and observes best-effort checkpoint failures.
