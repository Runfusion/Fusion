# Workspaces (Multi-Repository Projects)

## Overview

A workspace is one Fusion project whose root is **not** a Git repository and whose direct child directories are Git repositories. Use it when one task regularly changes several repositories that must be reviewed and landed together. Use separate Fusion projects when the repositories have independent task queues, settings, or lifecycle ownership.

| Concern | Single-repository project | Workspace project |
| --- | --- | --- |
| Project root | Git repository | Browse-only non-Git parent directory |
| Task checkout | One root worktree | One on-demand worktree per configured sub-repository |
| Landing | One merge | Per-repository, non-atomic land loop |
| Recovery | Single merge recovery | Per-repository landing proof and partial-land recovery |

## Setup and detection

You can register a workspace from three surfaces:

- In the **Setup Wizard**, choose **Use Existing Directory**. Fusion calls `POST /api/projects/detect-workspace` while you select the directory and pre-checks **Workspace mode (multi-repo)** when it finds candidates. The checkbox applies only to an existing directory.
- The project registration API accepts `workspaceMode`. An explicit `true` requests detection; an omitted value also permits automatic detection. The detection endpoint returns `{ repos, isWorkspace }`.
- The interactive CLI project resolver detects candidates, asks you to confirm workspace mode, initializes the store, then writes the workspace configuration.

`detectWorkspaceRepos` scans only direct children of the selected root. It excludes `node_modules`, `.fusion`, `.git`, and `.pi`; a child must have a `.git` marker and pass a real Git work-tree probe. Nested repositories are not discovered. Registration then prepares every configured or detected member: each member must have a verifiable `HEAD` and the managed `.gitignore` rules (`.fusion/`, `.pi/`, `.worktrees/`, `fusion.db`, `fusion.db-wal`, and `fusion.db-shm`). If a member is non-Git or unborn, Fusion initializes it and creates a baseline; if preparation fails, no workspace project row is registered or activated. When workspace configuration is present, `ensureGitRepositoryForProjectPath` intentionally skips `git init` at the root: do not create a root repository just to make workspace mode work.

## The workspace config file

Fusion records members in:

```text
<workspace-root>/.fusion/workspace.json
```

For example:

```json
{
  "repos": ["api", "web"]
}
```

Each `repos` entry is relative to the workspace root and must stay inside it. Absolute paths, `..` escapes, empty values, and non-string values are rejected or filtered when `loadWorkspaceConfig` reads the file. Keep member repositories as direct children so they remain discoverable and easy to operate.

The configuration file is written by registration, repository initialization, the interactive CLI resolver, and `addWorkspaceRepo`. The configuration file makes the root a workspace at repository-initialization time. The automatic path prepares members before publishing the workspace decision, then writes the `workspaceMode` setting before `workspace.json`, preventing a partially written configuration from making the next registration incorrectly treat the root as a workspace. The root remains browse-only and non-Git throughout.

## Adding a repository to an existing workspace

In **Settings → General → Workspace repositories**, choose a detected candidate or enter a direct-child directory and select **Add**. The same operation is available to integrations as `POST /api/git/workspace-repos` with `{ "repo": "api" }`. Adds are idempotent. Fusion requires an in-root direct child that is a real Git work tree and rejects excluded names (`node_modules`, `.fusion`, `.git`, `.pi`, `.worktrees`), absolute paths, and escapes.

A running task picks up a newly added member on its next `fn_acquire_repo_worktree` call without restarting the engine. Membership only grows during a live run: a failed or empty refresh preserves the last known-good members; removals require an engine restart. Tasks already in review or merging refuse late acquisition to avoid bypassing review; create a follow-up task instead.

## The workspaceMode setting

`workspaceMode` is a project-scoped boolean. Its default is unset, which is disabled: when enabled, the project root is treated as a workspace containing multiple Git sub-repositories; tasks run per sub-repository and Fusion does not create a root Git repository. You can set it during existing-directory registration through the Setup Wizard.

An explicit `workspaceMode: false` in `.fusion/config.json` prevents `ensureGitRepositoryForProjectPath` from automatically detecting and re-enabling workspace mode. The setting is not itself the member list: the workspace-config writers are registration, repository initialization, and the interactive CLI flow. If you change the setting and need to create, remove, or refresh `.fusion/workspace.json`, re-register the project or manage that file deliberately; toggling alone may not create or remove it.

## How a workspace task executes

A workspace task starts with its session current directory at the browse-only, non-Git root. Fusion does not acquire a root worktree and leaves the task's singular `worktree` field unset. Before editing a member repository, the agent calls:

```text
fn_acquire_repo_worktree
```

The tool accepts only a configured repository name and returns an isolated, task-specific worktree path in that sub-repository. Work only in that returned path. Each member uses its own branch and its own repository branch resolution; Fusion will not commit using a non-task branch.

Fusion adds acquired member paths to the task's active-worktree set, so liveness and ownership checks see the root plus every active member worktree. A live remembered worktree is reused across a resumed task or executor restart. If another task is acquiring the same member, the tool returns a temporary busy error asking the agent to retry `fn_acquire_repo_worktree` shortly; acquire a different member or retry rather than editing the original repository checkout.

### Custom working branches

In the task form's **Advanced** branch controls, an operator can enter one branch name for a workspace task. Fusion validates the name as a safe Git branch/ref name: it rejects empty or whitespace-padded names, spaces or control characters, `..`, `@{`, a leading `-`, empty path segments, dot-prefixed segments, and trailing `.` or `.lock` segments. Fusion applies the exact valid name in every acquired sub-repository. If the branch already exists in a member repository, Fusion attaches to it without recreating it; it still refuses a branch that is checked out by another live worktree.

Fusion records whether a branch was written by an operator or by Fusion. An operator-supplied branch is retained after merge, teardown, and recovery, including a name under the `fusion/` namespace, and PR creation uses it as the head branch. Fusion continues to clean up branches it created itself, including canonical `fusion/<task-id>` branches and entry-point-derived branch-group branches. Ownership follows recorded write provenance, not a branch-name prefix: editing a branch-group task transfers the selected branch to the operator; a later Fusion group reassignment takes ownership back. Shared-group members still work on their canonical task branch. Older tasks without a provenance marker retain their existing behavior.

## Choosing the base branch

Set a task's `baseBranch` in the New Task form or Task Detail to choose the base for a workspace task. At acquisition, Fusion verifies that ref independently in every sub-repository. Where it resolves, it is that worktree's start point, base-SHA anchor, land target, and revert target. Where it does not resolve, Fusion safely falls back to that repository's own integration branch rather than failing acquisition; the requested and selected refs are recorded in the task log and Task Detail, while run audit stores only the task/repository identifiers and fixed decision outcome.

The choice is pinned per repository at acquisition. The recorded `WorkspaceWorktreeEntry.baseBranch` wins for land, self-healing, and revert even if `task.baseBranch` is later edited. If a recorded ref disappears, those operations fall back to that repository's integration branch and leave a breadcrumb. Legacy entries without a recorded base (including worktrees acquired before this feature or a restored task) continue to target their own integration branch and ignore `task.baseBranch`; Fusion does not backfill them, and mixed legacy/recorded workspaces are valid. Checking out a desired branch first is not required: the task field is authoritative when it verifies in that member repository.

## Review and verification

Fusion captures changes per acquired sub-repository, not from the non-Git root. Modified file paths are repository-prefixed, such as `api/src/server.ts`, and each member is diffed against its own base. Per-repository branch attribution, contamination, and worktree-invariant checks apply to those member worktrees. Review and verification should therefore identify the member repository alongside every changed path and command result.

## Merging: the per-repo land loop

`landWorkspaceTask` processes configured/acquired repositories in a deterministic per-repository loop. Each repository lands on **its own local integration ref**; a shared workspace integration branch is not used. This means the operation is non-atomic: an earlier repository can land before a later repository fails.

The CLI command `fn task merge` reports each repository as `landed`, `empty`, or `failed`, and exits non-zero for a partial land. Fusion finalizes the task to `done` only after every member has either landed or has no changes to land. A partial result remains recoverable and must be treated as an operator-visible state, not as one atomic merge.

## landedSha idempotency

After a repository's integration ref advances, Fusion persists that repository's `landedSha`. `isRepoLanded` first proves that recorded SHA is an ancestor of the repository integration ref. If the ref advanced but persistence was lost in that narrow window, `findProvenLandedCommit` can instead prove the task's `Fusion-Task-Id` trailer on the integration history.

On a re-run, a proven landed repository is skipped and its exact proven SHA is retained. This prevents a partial-land retry from creating a second squash commit for a repository that already landed.

## Partial-land recovery and self-healing

The non-atomic land loop has a partial-land window. The `task:reconcile-workspace-partial-land` self-healing sweep re-enqueues an eligible task so it can retry unlanded repositories while skipping proven ones. It takes no action when auto-merge is off, the user paused the task, or a live member worktree/merge owner proves work is still active.

If a member task branch is gone and Fusion has no recorded or otherwise proven `landedSha`, the sweep parks the task as failed with a manual-intervention-required error. Inspect the per-repository integration history and task logs, establish whether the missing work landed or must be recovered, then repair/retry the task only after the workspace is safe. Do not assume a partial land rolled back repositories that already landed.

Additional sweeps emit `task:reconcile-orphaned-workspace-worktree` when they remove a recorded dead member worktree and `task:reclaim-phantom-workspace-land-lease` when they reclaim a leaked member landing lease. Search run-audit records for these event IDs and `task:reconcile-workspace-partial-land` when diagnosing recovery.

## Reverting a workspace task

Workspace Git revert is all-or-nothing across member repositories: Fusion classifies every repository before committing. If every repository is clean or already reverted, the response has the shape:

```json
{
  "mode": "git",
  "clean": true,
  "workspace": { "repos": [{ "repo": "api", "classification": "clean" }] }
}
```

If one member conflicts, Fusion rolls every touched member back to its pre-call state and commits no member revert. The `granularity` field applies only to the single-repository Git path, not workspace tasks. For the complete task revert contract, see [Reverting Done/Archived tasks](./task-management.md#reverting-donearchived-tasks-git-path--ai-undo-fallback).

There is an important route/helper distinction when auto-merge is off. `revertWorkspaceTask` refuses the direct integration-branch path, but the task route uses `prepareWorkspaceRevertPrBranches` for a clean classification and opens one PR per repository, returning `mode: "pr"` with the member PR details. Under `auto` mode, a conflicting workspace Git revert can instead create an AI-undo task.

## Archiving and cleanup

Archiving a workspace task synchronously removes every recorded member worktree. Fusion holds a per-repository reservation through disposal and branch cleanup. A failed removal is quarantined so a later acquisition can reconcile the orphan; successful siblings are released. `archiveTask(..., { cleanup: false })` intentionally retains worktrees, while self-healing remains a backstop. For the task lifecycle details, see [Workspace worktree cleanup on archive](./task-management.md#workspace-worktree-cleanup-on-archive).

## Limitations and known sharp edges

- Landing is non-atomic. A later failure does not undo earlier local integration-ref advances; use task logs, per-repository history, and `landedSha` proof before retrying or manually recovering.
- A requested base can resolve in some members and not others. Inspect the per-repository Task Detail base/fallback marker and task log before manually coordinating a mixed workspace.
- Exclusivity is per sub-repository. Two workspace tasks can work in different members concurrently, but cannot acquire or land the same member at the same time.
- Detection is intentionally shallow. A Git repository nested below a non-repository direct child is not a workspace member until you restructure or configure a valid direct-child entry.

## Troubleshooting

### A sub-repository was not detected

`detectWorkspaceRepos` only scans one level. Ensure the repository is a direct child, is not named `node_modules`, `.fusion`, `.git`, or `.pi`, has a `.git` marker, and succeeds as a real Git work tree. Remove or investigate a stray `.git` at the workspace root rather than initializing it: the root should remain non-Git.

### `fn_acquire_repo_worktree` reports an unknown repository

Add the repository in **Settings → General → Workspace repositories** (or through `POST /api/git/workspace-repos`), then retry immediately. The repository must be a valid direct-child Git work tree. Tasks already in review or merging require a follow-up task.

### `fn_acquire_repo_worktree` reports busy

Another task is temporarily acquiring or landing that same member. Retry the tool shortly, or continue with a different configured member. Do not edit the shared repository checkout while waiting.

### A task is failed after partial land

A branch-gone member without landing proof requires manual intervention. Inspect every member's integration history and the task log; determine which work landed, restore or recreate any missing task branch as appropriate, and then retry only when repository state is consistent.

### Workspace mode appears to re-enable after being toggled off

Check `.fusion/config.json`: explicit `workspaceMode: false` is the guard that suppresses automatic detection. Also inspect `.fusion/workspace.json`; the setting and member configuration are separate artifacts. Re-register or update the configuration deliberately if the project was previously detected as a workspace.

## Worktree layout

When `worktreesDir` is unset, workspace members keep the existing `<member>/.worktrees/<name>` layout. When it is configured, Fusion resolves the configured root once from the workspace root and creates each native member checkout at `<configured-root>/<workspace>/<repo>/<name>`. A safe workspace directory basename is preserved verbatim; unsafe names use a sanitized segment plus a deterministic eight-character hash. Nested or unsafe member paths use the same sanitized-and-hashed rule, preventing flattened-name collisions.

Fusion writes `.fusion-workspace-root` only while acquiring an external shared root. It rejects a second, different workspace root with the same safe basename rather than sharing the group; configure another root or rename one workspace. The marker never resolves paths and is only a deletion veto. Recorded worktree paths remain authoritative, so existing checkouts are not migrated. Grouped paths are forward-derived and never converted back to a project root by parent trimming. `.ai-merge` remains at the ungrouped configured root. Workspace directory sweeps do not reclaim by walking groups; archive and workspace recovery reclaim recorded member paths addressably.

### JIRA-derived branch names

Workspace tasks retain the operator-supplied shared branch-name flow. When JIRA integration is enabled, enter an issue key and choose **Derive** to fill the editable branch field using `feature/{key}-{summary}` by default. Failed lookup or authentication leaves the existing branch untouched, so manual branch naming remains available.

## Task repository scope

Configured repositories are acquired before planning for availability, but acquisition is not task intent. Each workspace task starts with an explicit repository-scope proposal (an operator selection is already confirmed); planning confirms the final scope in `## Repository Scope`. A clean scoped repository is reported as **No changes — not reviewed** and creates no review, landing, or partial-land obligation. Reviews and landing use only scoped repositories with qualified modified-file evidence.

An executor that needs another repository before landing records a scope extension and its reason. Once a land intent or landing exists, new acquisition remains refused and should be handled by a follow-up task. A workspace task normally has no singular `task.worktree`: member worktrees are the only routing authority, so Fusion never creates a worktree at the non-Git workspace root.
