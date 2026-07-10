---
"@runfusion/fusion": patch
---

summary: Fix Grok CLI chat returning errors or empty replies in the dashboard.
category: fix
dev: Two independent defects. (1) The default (no-project) ChatManager received a bare PluginLoader as its runner; Grok CLI routing (deriveGrokRuntimeHintForNoVisibleKey → resolveRuntime) calls getRuntimeById/createRuntimeContext, which only exist on PluginRunner, so a grok-cli/* chat with no Fusion-visible GROK_API_KEY threw "getRuntimeById is not a function" and surfaced the misleading "requires the bundled Grok CLI runtime" error. New resolveChatManagerPluginRunner(options) prefers the engine's PluginRunner (the runner the project-scoped chat path already uses), falling back to the loader only in UI-only mode. (2) The CLI-bundled Grok plugin (packages/cli/dist/plugins/fusion-plugin-grok-runtime/bundled.js) was stale relative to the FN-7796 single-JSON adapter source, so project-scoped grok chat produced empty replies; a `pnpm build` (tsup) regenerates it. The bundled-plugin freshness guard only warns — the dev prebuild does not rebuild the CLI tsup bundle.
