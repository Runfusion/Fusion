# @fusion-plugin-examples/grok-runtime

## 0.2.3

### Patch Changes

- @fusion/core@0.60.0
- @fusion/plugin-sdk@0.60.0

## 0.2.2

### Patch Changes

- @fusion/core@0.59.0
- @fusion/plugin-sdk@0.59.0

## 0.2.1

### Patch Changes

- @fusion/core@0.58.0
- @fusion/plugin-sdk@0.58.0

## 0.2.0

### Minor Changes

- Drive agent sessions over native ACP (`grok agent stdio`) for realtime streaming, tool visibility, multi-turn session reuse, and Fusion permission-gate integration. Vendors the ACP client under `src/acp/` (no runtime dependency on `fusion-plugin-acp-runtime`). Probe (`grok --version`) and model discovery (`grok models`) unchanged. Retires one-shot `grok -p --output-format json` as the primary prompt transport.
- Load Fusion tools and skills into ACP sessions: operator MCP servers + executable `fusion-custom-tools` bridge for engine `fn_*` customTools; session-scoped `--plugin-dir` / `_meta.pluginDirs` with the bundled Fusion skill and `additionalSkillPaths`.

## 0.1.0

### Minor Changes

- FN-7705: initial release of the Grok CLI runtime plugin — `grok-cli` model provider, API-key-auth probe, and model discovery via `grok models`.
