---
"@runfusion/fusion": patch
---

summary: Route every AI lane through runtime resolution so CLI-runtime models (e.g. Cursor CLI) work everywhere chat does.
category: fix
dev: `createFnAgent` now delegates to `createResolvedAgentSession` (CLI runtime hint derivation, mock forcing, runtime-resolved visibility) with a host-registered default PluginRunner per project root; `DefaultPiRuntime` re-enters via a `__rawPiSession` marker into `createPiAgentSessionRaw`. Mission and milestone/slice interviews also pass their request-scoped pluginRunner and prompt via the engine `promptWithFallback` dispatcher, fixing "cursor-cli/auto ... not found in the pi model registry" in mission planning.
