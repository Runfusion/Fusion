---
"@runfusion/fusion": minor
---

Merger unification (master-plan U0): `runAiMerge` (the FN-5633 clean-room AI merge path) is now the **sole** merge path. The engine dispatch, the `fn task merge` CLI command, and the UI-only (`--no-engine`) dashboard merge all route through `runAiMerge`; the legacy `aiMergeTask` pipeline is soft-deprecated (body retained, `@deprecated`). The `merger.mode` setting is now **inert and deprecated** — the type and field are retained as published surface, but the `"deterministic"` value no longer selects a different pipeline; observing it logs a one-time deprecation warning and proceeds via the unified AI merge path. A new shared `assertNotWorkspaceTaskMerge` guard rejects workspace-mode tasks (populated `workspaceWorktrees`) at every merge entry point with a clear error until per-repo merge support (master-plan U6) lands.
