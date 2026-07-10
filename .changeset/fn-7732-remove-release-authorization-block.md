---
"@runfusion/fusion": patch
---

summary: Removed leftover UI/i18n/docs for the deleted "awaiting release authorization" planning hold.
category: internal
dev: FN-7732 — removes the residual release-authorization planning-block scaffolding left after the triage gate was deleted (b5b0458): the unemitted `task:release-authorization-required` activity type, the dead `isReleaseAuthorizationHold` TaskCard badge/label + CSS, orphaned i18n keys across all locales, and the stale solutions doc. The backward-compat `awaitingApprovalReason` DB column (migration 138) and the operator-only `scripts/lib/release-authorization-gate.mjs` publish guard are intentionally left intact.
