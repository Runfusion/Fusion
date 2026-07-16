---
"@runfusion/fusion": patch
---

summary: Fix already-approved plans being re-asked for approval after recovery.
category: fix
dev: Plan-approval fingerprint now ignores auto-injected ## Original Description / Frontend UX hygiene sections so finalizeApprovedTask idempotency survives on-disk PROMPT.md injection (FN-8008). Keeps approve-plan producer and manual-gate consumer hashing identical normalized content.
