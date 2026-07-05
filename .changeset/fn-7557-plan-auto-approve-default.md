---
"@runfusion/fusion": minor
---

summary: Plan auto-approval is now the default; specified tasks skip manual approval unless you opt into workflow/require-all.
category: feature
dev: `DEFAULT_PROJECT_SETTINGS.planApprovalMode` flips `workflow` → `auto-approve-all`; existing projects with an explicit stored value are unchanged; consumed by `resolvePlanApprovalRequired` at the triage gating sites.
