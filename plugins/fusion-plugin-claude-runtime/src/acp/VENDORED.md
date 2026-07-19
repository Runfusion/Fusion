# Vendored ACP client

**Source:** `plugins/fusion-plugin-acp-runtime/src/` (Fusion ACP runtime plugin)
**Vendored:** 2026-07-11 for Grok ACP self-containment

## Why

`fusion-plugin-grok-runtime` is a **bundled, auto-installed** runtime.
`fusion-plugin-acp-runtime` is **experimental / on-demand**. Importing the latter at runtime would couple Grok availability to the ACP plugin install path and drag Claude-bridge packaging into Grok.

## What is copied

Client-side ACP only:

| Module | Role |
| --- | --- |
| `runtime-adapter.ts` | `AgentRuntime` lifecycle |
| `provider.ts` | connect / session / authenticate / prompt |
| `process-manager.ts` | spawn env allow-list + SIGKILL registry |
| `event-bridge.ts` | `session/update` → Fusion callbacks |
| `control-handler.ts` | permission floor |
| `fs-capabilities.ts` / `path-jail.ts` | optional client fs |
| `cli-spawn.ts` | settings resolution |
| `prompt-builder.ts`, `sanitize.ts`, `tool-mapping.ts`, `types.ts` | support |

**Not** copied: plugin `index.ts`, Claude bridge setup, generic ACP probe/setup UI.

## Syncing

When fixing ACP client bugs in `fusion-plugin-acp-runtime`, re-copy the modules above into this directory (or cherry-pick the same change) and note the date in FNXC comments.
