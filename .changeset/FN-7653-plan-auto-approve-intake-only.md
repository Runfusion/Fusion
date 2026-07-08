---
"@runfusion/fusion": patch
---

summary: Auto-approve plan toggle now appears only on the planning column, not Todo.
category: fix
dev: Board.tsx gated the plan auto-approve prop pair on intake||hold; the built-in Coding workflow's Todo is a hold column, leaking the control. Gate is now intake-only (legacy triage path unchanged).
