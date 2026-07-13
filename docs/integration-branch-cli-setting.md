# `integrationBranch` CLI setting (AIWO-039)

## Defect

`fn settings set integrationBranch <branch>` (and `fn settings set integrationBranch <branch> --project <name>`)
previously failed with:

```
Error: Unknown setting "integrationBranch"
```

even though `integrationBranch` is a real, documented `ProjectSettings` field
(`packages/core/src/types.ts`), already defaulted at the settings-schema layer
(`DEFAULT_PROJECT_SETTINGS` in `packages/core/src/settings-schema.ts`), and
consumed as the *first* entry in the engine's merge-target resolution chain:

```
resolveIntegrationBranch(): settings.integrationBranch → settings.baseBranch → origin/HEAD → "main"
```

(see `packages/engine/src/integration-branch.ts`).

The only working way to set it was the roundabout:

```bash
fn settings export --scope project
# hand-edit the exported JSON
fn settings import --scope project --merge --yes
```

This worked only because `importSettings()` calls `store.updateSettings()`
directly, bypassing the CLI's `VALID_SETTINGS` whitelist in
`packages/cli/src/commands/settings.ts` — the whitelist simply never had
`integrationBranch` added to it when the field was introduced.

## Fix

`packages/cli/src/commands/settings.ts` now includes `"integrationBranch"` in:

- `VALID_SETTINGS` — makes the key recognized by `fn settings set`.
- `PROJECT_ONLY_SETTINGS` — it is meaningless as a global setting (it resolves
  per-project merge behavior), so `fn settings set integrationBranch <branch>`
  without `--project` (and outside a project directory) correctly reports the
  existing "project-only" error, matching the behavior of `taskPrefix`,
  `defaultNodeId`, etc.
- `STRING_SETTINGS` — no special boolean/number/enum parsing is required; the
  value is a plain trimmed branch name string, exactly like `taskPrefix`,
  `defaultNodeId`, and `worktreesDir`.

It was also added to the "Merge" settings display group in
`runSettingsShow()` so `fn settings --project <name>` shows the value once set
(via the existing generic camelCase-to-title-case label fallback: "Integration
Branch" — no special-case label entry was needed).

Regression tests were added to `packages/cli/src/commands/__tests__/settings.test.ts`
covering:

- `VALID_SETTINGS` contains `"integrationBranch"`.
- `parseValue("integrationBranch", "  master  ")` trims and returns `"master"`.
- `runSettingsSet("integrationBranch", "master", "demo-project")` calls the
  mocked project store's `updateSettings({ integrationBranch: "master" })`.
- `runSettingsSet("integrationBranch", "master")` without `--project` exits
  with the standard project-only error.

## Explicit scope correction: `baseBranch` is NOT a `ProjectSettings` field

The original bug report speculated that `baseBranch` was "likely" also
missing from the CLI whitelist, since `resolveIntegrationBranch()`'s
resolution chain reads `settings.baseBranch` as a fallback. **This is
incorrect and was intentionally not acted on.**

`packages/core/src/types.ts` confirms `ProjectSettings` has **no `baseBranch`
field at all**. `baseBranch` only exists as:

- A **per-`Task`** field (`Task.baseBranch`, a task's individual merge-target
  override; see `types.ts` around lines 2301, 2777, 5176), and
- Separately, a field on `Mission`.

`resolveIntegrationBranch()` reads `settings.baseBranch` defensively through a
loose `{ baseBranch?: unknown }` intersection type specifically *because* no
real project-level setting by that name exists — it is dead weight in the
type signature, not evidence of a missing CLI whitelist entry.

`fn settings set` only ever writes `ProjectSettings`/`GlobalSettings` (via
`store.updateSettings()`); it never writes per-task fields. There is therefore
no `baseBranch` *project setting* to whitelist, and `"baseBranch"` must not be
added to `VALID_SETTINGS`, `PROJECT_ONLY_SETTINGS`, or `STRING_SETTINGS`. A
permanent regression test (`expect(VALID_SETTINGS).not.toContain("baseBranch")`)
guards against this being mistakenly re-attempted later.

## Related follow-up

`ProjectSettings` has ~50+ fields; most are structured objects (`mcpServers`,
`secretsEnv`, `worktreeCopyFiles`, etc.) unsuited to the CLI's single-string
`settings set` form. This task stayed scoped to `integrationBranch` only —
see the linked follow-up task (filed via `fn_task_create`) for any other
simple scalar `ProjectSettings` keys worth whitelisting later.
