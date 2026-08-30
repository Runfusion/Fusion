---
"@runfusion/fusion": patch
---

summary: Documentation now only documents — it can no longer hold a merge or send a card back with nothing to do.
category: fix
dev: Observed on a live card: the Documentation milestone returned an advisory REVISE, which recorded `advisory_failure`. `resolveRequiredPreMergeStepIds` included the group, so `evaluatePreMergeApprovals` read it as "not-approved" and held the merge door; the same REVISE also reached `requestPreMergeOptionalStepFix`, which bounced the card to `in-progress` where `sendTaskBackForFix` reopens nothing under the named-remediation policy — no pending step, foreach `already-expanded`, Code Review replayed over an unchanged tree, and the card merged when the second Documentation pass happened to pass. New opt-in `WorkflowOptionalGroupConfig.reportingOnly`, surfaced on `ResolvedWorkflowOptionalStep` and set only on `documentationDeliveryOptionalGroupNode`, excludes a reporting group from the required pre-merge approval set and refuses executor remediation for it. A general guard now also refuses any `stepReopenPolicy: "none"` bounce that appended no named steps, logging it on the card instead of looping. Code Review REVISE and the deterministic verification failure keep producing named fix steps; advisory gates that own remediation (browser verification) are untouched.
