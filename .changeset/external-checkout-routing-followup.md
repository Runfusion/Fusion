---
"@runfusion/fusion": patch
---

summary: Keep operator-routed external checkouts authoritative across recovery, remediation, verification, and cleanup.
category: fix
dev: Re-reads persisted checkout metadata and prevents managed-worktree fallback or cleanup on external routes.
