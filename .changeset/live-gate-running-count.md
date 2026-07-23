---
"@runfusion/fusion": patch
---

summary: Board column and footer running counts now include live Code Review, Plan Review, and other gate sessions.
category: fix
dev: `isRunningAgentTask` treats a `pending` workflow-step-result lease as Running; shared by column headers, footer stats, admission, and CLI counts.
