---
"@runfusion/fusion": patch
---

Enforce `workflow_steps.toolMode="readonly"` as a hard tool allowlist at the engine's agent-session layer. Readonly workflow steps can no longer hold Edit, Write, Bash, or task/agent mutation tools. Steps that attempted to write under `toolMode="readonly"` now fail closed with a `READONLY_VIOLATION` outcome instead of silently staging files.
