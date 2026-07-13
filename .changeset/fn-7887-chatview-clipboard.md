---
"@runfusion/fusion": patch
---

summary: Fix chat "Copy response" falsely reporting failure on non-secure origins (mobile/HTTP).
category: fix
dev: Migrated ChatView handleCopyResponse from direct navigator clipboard access to the shared copyTextToClipboard helper (secure-context guard + execCommand fallback, boolean-driven success/error feedback), the last direct clipboard caller found during the FN-7885 preflight.
