---
"@runfusion/fusion": patch
---

summary: Fix copy actions crashing or mis-reporting on non-secure origins (mobile/HTTP).
category: fix
dev: Migrated remaining dashboard copy handlers (agent id, secrets, git manager, CLI binary, PR conflicts, stash ref, login instructions, agent-error modal) and the reports plugin share-blocks panel from direct navigator.clipboard.writeText to the shared copyTextToClipboard helper (secure-context guard + execCommand fallback, boolean result handling). Added ./app/utils/copyToClipboard subpath export from @fusion/dashboard.
