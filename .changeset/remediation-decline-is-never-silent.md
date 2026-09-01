---
"@runfusion/fusion": patch
---

summary: A blocked review that produces no fix steps now says why on the task instead of stopping silently.
category: fix
dev: `requestPreMergeOptionalStepFix` has 34 refusal exits and roughly half wrote nothing. The outer seam now observes whether the call narrated (via a store proxy over `logEntry`/`addTaskComment`) and emits one diagnostic entry when a `false` return left no explanation. The graph-failure remediation backstop also records its two previously-silent returns (deferred admission, unheld claim). Behaviour is unchanged; this is visibility only.
