---
"@runfusion/fusion": patch
---

summary: Tasks are no longer stuck "awaiting release authorization" — the over-firing release gate was removed.
category: fix
dev: Removed the triage release-authorization gate (packages/engine/src/triage-release-authorization.ts + finalizeApprovedTask block) and its dashboard approve/reject-plan guards. It false-flagged specs that merely mentioned release tooling and stranded tasks in awaiting-approval with no in-band exit. Legacy `awaitingApprovalReason: "release-authorization"` rows now render as ordinary manual plan-approval holds. Releases are kept out of Fusion by agent instruction (AGENTS.md → Releasing) instead.
