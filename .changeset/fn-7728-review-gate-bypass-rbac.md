---
"@runfusion/fusion": minor
---

summary: Add a dedicated permission for who may bypass a failed review gate, separate from task mutations.
category: feature
dev: Adds a new `review_gate_bypass` permission-policy category (packages/core/src/types.ts, agent-permission-policy.ts) governing `fn_task_bypass_review` (FN-7720). `fn_task_bypass_review` is classified into it in the shared `gating-classifications.ts` source and resolves identically in both `evaluateAgentActionGate` and the permanent-agent gate. Defaults to `require-approval` even under the `unrestricted` preset (stricter than the uniform preset default), while `approval-required`/`locked-down` presets already cover it uniformly. `toolRules.fn_task_bypass_review` exact overrides continue to apply on top. The dashboard permission-policy editor (project-default + per-agent override) renders the category as its own row. No DB migration required; a stored policy missing the key resolves to the preset default. The tool's CLI/pi-extension-only registration surface is unchanged.
