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
simple scalar `ProjectSettings` keys worth whitelisting later. That follow-up
work landed as AIWO-040 (below).

## AIWO-040: seven more merge/handoff scalar settings whitelisted

Following on directly from the `integrationBranch` fix above, AIWO-040
whitelisted seven more genuine single-value `ProjectSettings` fields that were
still rejected by `fn settings set` as "Unknown setting" despite being fully
wired at the `settings-schema.ts` default layer and consumed by the merge
engine:

| Key | Type | Default (`DEFAULT_PROJECT_SETTINGS`) | Array added to |
|---|---|---|---|
| `pushAfterMerge` | `boolean` | `false` | `BOOLEAN_SETTINGS` |
| `pushRemote` | `string` | `"origin"` | `STRING_SETTINGS` |
| `autoResolveReviewComments` | `boolean` | `true` | `BOOLEAN_SETTINGS` |
| `mergeStrategy` | `"direct" \| "pull-request"` | `"direct"` | `ENUM_SETTINGS` |
| `directMergeCommitStrategy` | `"auto" \| "always-squash" \| "always-rebase"` | `"always-squash"` | `ENUM_SETTINGS` |
| `mergeAdvanceAutoSync` | `"off" \| "ff-only" \| "stash-and-ff"` | `"stash-and-ff"` | `ENUM_SETTINGS` |
| `owningNodeHandoffPolicy` | `"block" \| "reassign-to-local" \| "reassign-any-healthy"` | `"reassign-to-local"` | `ENUM_SETTINGS` |

All seven are project-only (added to `PROJECT_ONLY_SETTINGS`) — none are
meaningful as global settings since they all govern per-project merge/handoff
behavior, matching the existing pattern for `integrationBranch`,
`unavailableNodePolicy`, and `defaultNodeId`.

The four enum values were hardcoded inline in `ENUM_SETTINGS` (rather than
imported from `@fusion/core`) to match the existing `unavailableNodePolicy`
convention: the `MergeStrategy`/`DirectMergeCommitStrategy`/
`MergeAdvanceAutoSyncMode`/`OwningNodeHandoffPolicy` literal unions are not
exported as reusable const arrays from `packages/core/src/index.ts`, so the
literal tuples are duplicated in the CLI file, matching how
`unavailableNodePolicy`'s `["block", "fallback-local"]` values are already
hardcoded there rather than imported.

All seven were added to the `runSettingsShow()` display groups: the six
merge-related keys joined `integrationBranch` in the existing "Merge" group,
and `owningNodeHandoffPolicy` joined `defaultNodeId`/`unavailableNodePolicy`
in "Node Routing" (a closer conceptual fit than "Merge", since it governs
node handoff rather than merge strategy). No special-case labels were needed
— the existing camelCase-to-title-case fallback in `getSettingLabel()`
produces readable output for all seven (e.g. "Push After Merge", "Owning Node
Handoff Policy").

### Explicit exclusion: `requirePrApproval` is NOT missing — it was MOVED

`requirePrApproval` looks like an obvious eighth candidate (it's a `boolean`
field still declared on the `ProjectSettings` TypeScript type in `types.ts`),
but it is **intentionally excluded** from this whitelist. It was hard-MOVED
to workflow settings in U4:

- It has **no default** in `DEFAULT_PROJECT_SETTINGS`
  (`packages/core/src/settings-schema.ts`) — the corresponding line is a
  comment noting the MOVE, not a live default.
- It is listed in the `MovedProjectSettingsKey` union
  (`settings-schema.ts`, near the top of the file) alongside the other U4-era
  moved keys (`runStepsInNewSessions`, `maxParallelSteps`,
  `requirePlanApproval`, etc.) that are already excluded from `VALID_SETTINGS`.
- The field still exists on the raw `ProjectSettings` TS interface only for
  the engine's flat-read compatibility shim, not as a live per-project
  setting.

`fn settings set requirePrApproval <value>` must continue to reject with
`Error: Unknown setting "requirePrApproval"`, and use
`fn_workflow_settings` (or the workflow editor's review-gate settings)
instead. A permanent regression test
(`expect(VALID_SETTINGS).not.toContain("requirePrApproval")`) guards against
this being mistakenly re-added later, alongside an explicit
`runSettingsSet("requirePrApproval", ...)` rejection test.

### Resolved: `mergeIntegrationWorktree` (AIWO-041)

`mergeIntegrationWorktree` (`MergeIntegrationWorktreeMode`,
`packages/core/src/types.ts`) sat adjacent to the AIWO-040 fields in
`types.ts` and fit the same enum pattern, but it was not named in AIWO-040's
candidate list, so it was intentionally left out of that diff and filed
separately as a follow-up task (AIWO-041) rather than folded in silently.

AIWO-041 closed that gap. `fn settings set mergeIntegrationWorktree <value>
--project <name>` now works end-to-end. `mergeIntegrationWorktree` was:

- a real, live, unmoved `ProjectSettings` field — confirmed absent from
  `MovedProjectSettingsKey` in `packages/core/src/settings-schema.ts`
- already defaulted at the settings-schema layer
  (`DEFAULT_PROJECT_SETTINGS.mergeIntegrationWorktree = "reuse-task-worktree"`)
- already consumed by the merge engine (`packages/engine/src/merger.ts`,
  `packages/engine/src/merger-integration-worktree.ts`) via
  `normalizeMergeIntegrationWorktreeMode(settings.mergeIntegrationWorktree)`

**Accepted CLI values:** `ENUM_SETTINGS.mergeIntegrationWorktree` whitelists
only the two canonical, non-deprecated values:

```
["reuse-task-worktree", "cwd-integration-branch"]
```

**Design decision — the deprecated `cwd-main` legacy alias is intentionally
excluded from the CLI whitelist.** `MergeIntegrationWorktreeMode` has a third
member, `"cwd-main"`, explicitly commented in `types.ts` as `// legacy alias
for cwd-integration-branch; deprecated. Normalized at read time.` None of the
other enum settings already whitelisted in this file
(`unavailableNodePolicy`, `owningNodeHandoffPolicy`, `mergeStrategy`,
`directMergeCommitStrategy`, `mergeAdvanceAutoSync`, `worktrunk.onFailure`)
expose a deprecated alias through `ENUM_SETTINGS`, and doing so here would
actively encourage new usage of a value the type intentionally deprecated —
working against the reason `normalizeMergeIntegrationWorktreeMode()` exists
(to quietly migrate legacy config, not to keep issuing it). As a result:

```
fn settings set mergeIntegrationWorktree cwd-main
# Error: Invalid value for mergeIntegrationWorktree: "cwd-main".
# Valid options: reuse-task-worktree, cwd-integration-branch
```

This is enforced by the CLI's existing `parseValue()` `ENUM_SETTINGS`
throw-on-invalid branch — no engine or normalizer code was touched.
`normalizeMergeIntegrationWorktreeMode()` in `packages/core/src/types.ts`
remains the engine's read-time safety net: any project config that already
has `mergeIntegrationWorktree: "cwd-main"` (written before this fix, or via
hand-edited JSON through `fn settings import`) continues to be silently
normalized to `"cwd-integration-branch"` at read time in the merger, with a
one-time `console.warn`. The CLI simply refuses to let anyone author a new
`"cwd-main"` value going forward.

Deliberately **not** done: `normalizeMergeIntegrationWorktreeMode()` is not
called from inside `parseValue()`/`runSettingsSet()`. Doing so would silently
coerce a typo'd or otherwise unrecognized value to the default
(`"reuse-task-worktree"`) instead of rejecting it with a clear error — worse
UX than, and inconsistent with, every other enum setting in this file. Only
the normalizer's *accepted-value list* was reused; its *coercion behavior*
was deliberately left engine-side.

`mergeIntegrationWorktree` was also added to `VALID_SETTINGS`,
`PROJECT_ONLY_SETTINGS` (it is meaningless as a global setting), and the
`runSettingsShow()` "Merge" display group, alongside `mergeStrategy` /
`directMergeCommitStrategy` / `mergeAdvanceAutoSync`.
