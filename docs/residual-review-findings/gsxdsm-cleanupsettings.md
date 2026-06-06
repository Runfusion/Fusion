# Residual Review Findings — gsxdsm/cleanupsettings

Source: ce-code-review run `20260605-011952-1c8655ba` (mode:autofix) against `main` (BASE e5bab640f), reviewing the workflow-settings mechanism branch (plan: `docs/plans/2026-06-04-002-feat-workflow-settings-mechanism-plan.md`). 11 safe fixes were applied on-branch in `fix(review): apply autofix feedback`; the findings below were filed as tracker issues rather than fixed inline.

## Residual Review Findings

- [P2] `packages/core/src/store.ts:11848` — Migration may key workflow setting values by rootDir before project identity exists → [#1434](https://github.com/Runfusion/Fusion/issues/1434)
- [P2] `packages/core/src/store.ts:12921` — deleteWorkflowDefinition cascade of workflow_settings rows is not transactional → [#1435](https://github.com/Runfusion/Fusion/issues/1435)
- [P2] `packages/core/src/settings-export.ts:336` — v1 settings import fan-out overwrites existing per-workflow customizations → [#1436](https://github.com/Runfusion/Fusion/issues/1436)
- [P2] `packages/dashboard/app/components/WorkflowSettingsPanel.tsx:584` — pending value edits made while save is in flight are cleared → [#1437](https://github.com/Runfusion/Fusion/issues/1437)
- [P2] `packages/engine/src/merger.ts:11596` — runAiAgentForCommit throws if task deleted mid-merge (getTask for effective settings) → [#1438](https://github.com/Runfusion/Fusion/issues/1438)
- [P2] `packages/engine/src/self-healing.ts:5020` — in-review sweep resolves effective settings for every task, not just candidates → [#1439](https://github.com/Runfusion/Fusion/issues/1439)
- [P2] `packages/core/src/workflow-settings.ts:64` — WorkflowSettingRejection shape diverges from CustomFieldRejection → [#1440](https://github.com/Runfusion/Fusion/issues/1440)
- [P2] `packages/dashboard/src/routes/register-settings-sync-routes.ts:107` — outbound settings push not tombstone-filtered (defense-in-depth) and untested → [#1441](https://github.com/Runfusion/Fusion/issues/1441)
- [P2] `packages/core/src/store.ts:1587` — repeated silent settings-migration failure has no surfaced signal → [#1442](https://github.com/Runfusion/Fusion/issues/1442)
- [P3] `packages/core/src/store.ts:11876` — migration drops customized values for in-use custom workflows lacking declarations → [#1443](https://github.com/Runfusion/Fusion/issues/1443)
- [P3] test-helper and `kebab()` duplication across workflow-settings code → [#1444](https://github.com/Runfusion/Fusion/issues/1444)

Validated false during synthesis: "migration's global null-out stripped by its own guard" — the migration calls `globalSettingsStore.updateSettings` directly (`store.ts:11963`), bypassing the guarded wrapper; the null-out is effective.

Advisory (report-only, no ticket): `updateWorkflowSettingValues` read-modify-write lost-update under concurrent writers; cross-project v2 import can write orphan rows for unknown workflow ids; binary downgrade after migration runs moved policy at defaults (forward-only posture, documented in `docs/settings-reference.md`).
