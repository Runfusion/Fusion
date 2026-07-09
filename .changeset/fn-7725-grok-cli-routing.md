---
"@runfusion/fusion": minor
---

summary: Grok work can now be routed through the Grok CLI streaming runtime, not only the direct xAI endpoint.
category: feature
dev: FN-7725 formalizes, tests, and documents the existing agent Runtime-mode picker path (option (a)) as the decided Grok CLI routing wiring — setting an agent's Runtime Source to "Runtime" -> "Grok Runtime" sets runtimeConfig.runtimeHint="grok", which the existing generic extractRuntimeHint -> resolveRuntime -> resolvePluginRuntime -> plugin factory chain (packages/engine/src/agent-session-helpers.ts, runtime-resolution.ts) already resolved to GrokRuntimeAdapter (FN-7722) for other plugin runtimes; no new engine/dashboard code was required, only a routing test (packages/engine/src/__tests__/grok-runtime-routing.test.ts), an FNXC decision note at the extractRuntimeHint seam, and documentation. Direct xAI OpenAI-compatible path (FN-7711/FN-7714) remains the default and is unchanged; the new path is additive/opt-in and does not preserve a specific grok-cli/* model selection (documented limitation). Contract decision recorded in docs/grok-cli-contract.md.
