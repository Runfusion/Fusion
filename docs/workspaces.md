# Workspaces (Multi-Repository Projects)

## Overview

A workspace is one Fusion project whose root is **not** a Git repository and whose direct child directories are Git repositories. Use it when one task regularly changes several repositories that must be reviewed and landed together. Use separate Fusion projects when the repositories have independent task queues, settings, or lifecycle ownership.

| Concern | Single-repository project | Workspace project |
| --- | --- | --- |
| Project root | Git repository | Browse-only non-Git parent directory |
| Task checkout | One task-ID worktree | One task-ID worktree per configured sub-repository |
| Landing | One merge | Per-repository, non-atomic land loop |
| Recovery | Single merge recovery | Per-repository landing proof and partial-land recovery |

## Setup and detection

You can register a workspace from three surfaces:

- In the **Setup Wizard**, choose **Use Existing Directory**. Fusion calls `POST /api/projects/detect-workspace` while you select the directory and pre-checks **Workspace mode (multi-repo)** when it finds candidates. The checkbox applies only to an existing directory.
- The project registration API accepts `workspaceMode`. An explicit `true` requests detection; an omitted value also permits automatic detection. The detection endpoint returns `{ repos, isWorkspace }`.
- The interactive CLI project resolver detects candidates, asks you to confirm workspace mode, initializes the store, then writes the workspace configuration.

`detectWorkspaceRepos` scans only direct children of the selected root. It excludes `node_modules`, `.fusion`, `.git`, and `.pi`; a child must have a `.git` marker and pass a real Git work-tree probe. Nested repositories are not discovered. Registration then prepares every configured or detected member: each member must have a verifiable `HEAD` and the managed `.gitignore` rules (`.fusion/`, `.pi/`, `.worktrees/`, `fusion.db`, `fusion.db-wal`, and `fusion.db-shm`). Each member independently reconciles its own local integration ref from its own settings and Git refs; a workspace root never supplies one shared default branch. If a member is non-Git or unborn, Fusion initializes it and creates a baseline; if preparation fails, no workspace project row is registered or activated. When workspace configuration is present, `ensureGitRepositoryForProjectPath` intentionally skips `git init` at the root: do not create a root repository just to make workspace mode work.

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

Workspace membership is captured when a task begins. Fusion acquires every configured member for that task, so adding or removing a repository affects later tasks rather than changing a running task's checkout set. Create a follow-up task when newly configured repository work is needed.

## The workspaceMode setting

`workspaceMode` is a project-scoped boolean. Its default is unset, which is disabled: when enabled, the project root is treated as a workspace containing multiple Git sub-repositories; tasks run per sub-repository and Fusion does not create a root Git repository. You can set it during existing-directory registration through the Setup Wizard.

An explicit `workspaceMode: false` in `.fusion/config.json` prevents `ensureGitRepositoryForProjectPath` from automatically detecting and re-enabling workspace mode. The setting is not itself the member list: the workspace-config writers are registration, repository initialization, and the interactive CLI flow. If you change the setting and need to create, remove, or refresh `.fusion/workspace.json`, re-register the project or manage that file deliberately; toggling alone may not create or remove it.

## How a workspace task executes

A workspace task owns one task directory containing a child Git worktree for **every repository configured in** `.fusion/workspace.json`. Fusion acquires that complete set when the task starts, using the task ID for each checkout name, and keeps the set stable for the task lifetime. That directory is the session cwd, the single isolation-boundary root, and (when enabled) the sandbox writable root; there is no positional coordinator repository. Repository-relative paths such as `api/src/server.ts` therefore work naturally in one session. The singular `task.worktree` field remains unset for workspace tasks.

Planning, prompt-based Plan Review, implementation, and read-only graph gates run from that task directory under a `workspace-task-dir` boundary. The boundary declares every configured child repository and never permits a session to fall back to the operator checkout. Workspace Plan Review scripts remain unsupported because the script runner cannot yet receive this multi-root boundary.

Agents do not choose, acquire, or extend individual repository checkouts. `.fusion/workspace.json` is the single source of membership; the durable repository scope is a confirmed snapshot for review evidence and landing, not a planner heading or an operator selection.

### Dispatch-time base refresh

At implementation dispatch, Fusion refreshes each configured repository checkout onto that repository's recorded base branch. This also runs after a task is released from a file-overlap hold, so work resumes from the latest landed base rather than the one captured when its checkout was first acquired. A dirty checkout, rebase conflict, or unresolvable base keeps its local base unchanged and defers rebase/conflict handling to the merge lane; these refresh outcomes do not block execution. Worktrunk-backed checkouts are not refreshed.

### File overlap in workspace mode

A workspace task retains its file-scope claim while any per-repository checkout exists, including while it waits in a review or hold lane. Prefer repository-qualified `## File Scope` entries such as `api/src/server.ts`. An unprefixed entry such as `src/server.ts` is conservatively interpreted as applying inside every configured repository, so it still serializes work against a repository-qualified peer.

### Dependency readiness before Plan Review

Every fresh member worktree performs a bounded root-level dependency bootstrap. Fusion recognizes Node (`pnpm`, npm, Yarn, Bun), Python (`uv`, Poetry, Pipenv, pip), Rust, Go, PHP, Ruby, .NET, Maven, Gradle, Elixir, Dart/Flutter, and Swift manifests. A row runs only when its required binary is available on `PATH`; a plain static repository with no manifest or lock evidence starts no command and is `not-needed`.

Fusion records readiness in `<private-git-dir>/fusion-dependency-install.json`, so it never appears in Git status. A configured `worktreeInitCommand` is authoritative and replaces inferred rows. Unknown package-manager evidence (named manifests such as `flake.nix` and a bounded root-level lockfile/declaration shape rule) is `unrecognized`, not dependency-free. The planner receives the affected repository and evidence, then uses the planning-only `fn_install_worktree_dependencies` tool to run an engine-observed install or record a reasoned `none` decision.

Before prompt Plan Review dispatches, Fusion retries deterministic rows once. Any `unresolved` or `unrecognized` member returns the ordinary Plan Review `REVISE` beginning `Dependencies are not installed.`; the existing revision budget and `planReviewReplanCap` replan the task, then park it at `awaiting-approval` with `awaitingApprovalReason: "plan-review-replan-cap"` if exhausted. A missing or unreadable probe is `not-determined`, logged, and does not block review.

### Custom working branches

In the task form's **Advanced** branch controls, an operator can enter one branch name for a workspace task. Fusion validates the name as a safe Git branch/ref name: it rejects empty or whitespace-padded names, spaces or control characters, `..`, `@{`, a leading `-`, empty path segments, dot-prefixed segments, and trailing `.` or `.lock` segments. Fusion applies the exact valid name in every acquired sub-repository. If the branch already exists in a member repository, Fusion attaches to it without recreating it; it still refuses a branch that is checked out by another live worktree.

Fusion records whether a branch was written by an operator or by Fusion. An operator-supplied branch is retained after merge, teardown, and recovery, including a name under the `fusion/` namespace, and PR creation uses it as the head branch. Fusion continues to clean up branches it created itself, including canonical `fusion/<task-id>` branches and entry-point-derived branch-group branches. Ownership follows recorded write provenance, not a branch-name prefix: editing a branch-group task transfers the selected branch to the operator; a later Fusion group reassignment takes ownership back. Shared-group members still work on their canonical task branch. Older tasks without a provenance marker retain their existing behavior.

## Choosing the base branch

Set a task's `baseBranch` in the New Task form or Task Detail to choose the base for a workspace task. At acquisition, Fusion verifies that ref independently in every sub-repository. Where it resolves, it is that worktree's start point, base-SHA anchor, land target, and revert target. Where it does not resolve, Fusion safely falls back to that repository's own integration branch rather than failing acquisition; the requested and selected refs are recorded in the task log and Task Detail, while run audit stores only the task/repository identifiers and fixed decision outcome.

The choice is pinned per repository at acquisition. The recorded `WorkspaceWorktreeEntry.baseBranch` wins for land, self-healing, and revert even if `task.baseBranch` is later edited. If a recorded ref disappears, those operations fall back to that repository's integration branch and leave a breadcrumb. Legacy entries without a recorded base (including worktrees acquired before this feature or a restored task) continue to target their own integration branch and ignore `task.baseBranch`; Fusion does not backfill them, and mixed legacy/recorded workspaces are valid. Checking out a desired branch first is not required: the task field is authoritative when it verifies in that member repository.

## Review and verification

Fusion captures changes per acquired sub-repository, not from the non-Git root. Modified file paths are repository-prefixed, such as `api/src/server.ts`, and each member is diffed against its own base. Per-repository branch attribution, contamination, and worktree-invariant checks apply to those member worktrees. A workspace Code Review evaluates every modified in-scope repository before returning one aggregate verdict, with repository-qualified findings and an outcome for each reviewed member. `fn_run_verification` can select a repository explicitly and records the selected repository with its command result.

## Merging: the per-repo land loop

`landWorkspaceTask` processes configured/acquired repositories in a deterministic per-repository loop. Each repository lands on **its own local integration ref**; a shared workspace integration branch is not used. This means the operation is non-atomic: an earlier repository can land before a later repository fails.

Each repository uses the same `landOneRepo` / `landSquash` mechanic as a single-repository project, with that repository's main checkout as `projectRootDir`. When the integration branch is checked out with local edits, `merger.allowDirtyLocalCheckoutSync` applies identically: enabled stashes tracked and untracked edits, fast-forwards, then restores them; disabled refuses the land before the ref advances.

`pushAfterMerge` also governs workspace publication. When it is off, every member lands only on its local integration ref: Fusion does not create fence refs, land intents, or remote branch writes. When it is on, each member resolves and publishes to its own selected remote under the normal workspace fence contract; `pushRemote` remains a direct-merge setting and does not select a workspace member remote.

The CLI command `fn task merge` reports each repository as `landed`, `empty`, or `failed`, and exits non-zero for a partial land. Fusion finalizes the task to `done` only after every member has either landed or has no changes to land. A partial result remains recoverable and must be treated as an operator-visible state, not as one atomic merge.

## landedSha idempotency

After a repository's integration ref advances, Fusion persists that repository's `landedSha`. `isRepoLanded` first proves that recorded SHA is an ancestor of the repository integration ref. If the ref advanced but persistence was lost in that narrow window, `findProvenLandedCommit` can instead prove the task's `Fusion-Task-Id` trailer on the integration history.

On a re-run, a proven landed repository is skipped and its exact proven SHA is retained. This prevents a partial-land retry from creating a second squash commit for a repository that already landed.

## Partial-land recovery and self-healing

The non-atomic land loop has a partial-land window. The `task:reconcile-workspace-partial-land` self-healing sweep re-enqueues an eligible task so it can retry unlanded repositories while skipping proven ones. It takes no action when auto-merge is off, the user paused the task, or a live member worktree/merge owner proves work is still active.

If a member task branch is gone and Fusion has no recorded or otherwise proven `landedSha`, the sweep parks the task as failed with a manual-intervention-required error. Inspect the per-repository integration history and task logs, establish whether the missing work landed or must be recovered, then repair/retry the task only after the workspace is safe. Do not assume a partial land rolled back repositories that already landed.

Additional sweeps emit `task:reconcile-orphaned-workspace-worktree` when they remove a recorded dead member worktree and `task:reclaim-phantom-workspace-land-lease` when they reclaim a leaked member landing lease. Acquisition exclusivity is decided by a renewable durable lease; owner deletion or an execution-lane exit releases its acquire claim, while `task:reclaim-phantom-workspace-acquire-lease` and `worktree:workspace-repo-acquire-reclaimed` diagnose defensive leaked-entry recovery. Search run-audit records for these event IDs and `task:reconcile-workspace-partial-land` when diagnosing recovery.

## Reverting a workspace task

Workspace Git revert is all-or-nothing across member repositories: Fusion classifies every repository before committing. If every repository is clean or already reverted, the response has the shape:

```json
{
  "mode": "git",
  "clean": true,
  "workspace": { "repos": [{ "repo": "api", "classification": "clean" }] }
}
```

If one member conflicts, Fusion rolls every touched member back to its pre-call state and commits no member revert. The `granularity` field applies only to the single-repository Git path, not workspace tasks. For the complete task revert contract, see [Reverting completed tasks](./task-management.md#reverting-completed-tasks-git-path--ai-undo-fallback).

There is an important route/helper distinction when auto-merge is off. `revertWorkspaceTask` refuses the direct integration-branch path, but the task route uses `prepareWorkspaceRevertPrBranches` for a clean classification and opens one PR per repository, returning `mode: "pr"` with the member PR details. Under `auto` mode, a conflicting workspace Git revert can instead create an AI-undo task.

## Completion cleanup

A successful workspace merge cleans up after itself. When every acquired sub-repository lands, finalization removes each recorded member worktree under the same landing proof the single-repository lane uses, then removes the emptied workspace task directory (and emptied intermediate parents for nested repository keys), so a merged, done task leaves no orphan folder under `.fusion/worktrees/<task-id>/`. The gate is conservative in the direction that protects work: a member holding uncommitted or unverifiable content is preserved with its reason written to the task log, and a preserved member keeps the parent directory. A partial land removes nothing, because the retry still needs those checkouts. Cleanup failures are recorded and never turn a proven landing into a merge failure; the periodic sweep converges anything left behind, including tasks that completed before this behavior shipped. Deleting a task uses the same safety-first worktree disposal rules; there is no separate archive lifecycle.

## Task Reset

Reset returns a workspace task to fresh planning. It fences active task runtime owners, removes every recorded per-repository worktree, removes the empty workspace task directory when possible, replaces the current plan with a bootstrap prompt containing the confirmed original request, and clears the task's workspace coordination leases and land intents. It then publishes the same task with no steps or lifecycle status into the lane where a new idea starts: the Planning/hold lane for a manual-intake workflow, or the intake lane otherwise.

Reset retains the task ID, title, confirmed description, dependencies, workflow selection, comments, attachments, operator-authored documents, and logs. It deletes task-owned local branches in each repository while preserving operator-supplied and shared-group branches, and clears discarded-run presentation state such as size, pull-request information, token spend, step reports, and transition markers. A live, foreign, unsafe, or unprovable repository is reported as an actionable per-repository conflict, and the same live and foreign-holder checks cover the workspace task directory itself. If a holder appears at that directory during repository cleanup, Fusion retains the directory and current plan, reports incomplete cleanup, and does not publish fresh Planning state.

## Limitations and known sharp edges

- Landing is non-atomic. A later failure does not undo earlier local integration-ref advances; use task logs, per-repository history, and `landedSha` proof before retrying or manually recovering.
- A requested base can resolve in some members and not others. Inspect the per-repository Task Detail base/fallback marker and task log before manually coordinating a mixed workspace.
- Acquisition exclusivity is per sub-repository and short-lived. The durable lease covers only the `git worktree add` critical section, then releases, so tasks may work concurrently in their own member worktrees after startup.
- With `pushAfterMerge` off, cross-node land exclusivity rests on the durable per-repository lease and local ref compare-and-swap because no shared remote write occurs.
- Detection is intentionally shallow. A Git repository nested below a non-repository direct child is not a workspace member until you restructure or configure a valid direct-child entry.

## Troubleshooting

### A sub-repository was not detected

`detectWorkspaceRepos` only scans one level. Ensure the repository is a direct child, is not named `node_modules`, `.fusion`, `.git`, or `.pi`, has a `.git` marker, and succeeds as a real Git work tree. Remove or investigate a stray `.git` at the workspace root rather than initializing it: the root should remain non-Git.

### A configured repository is unavailable or busy

Fusion acquires the complete configured member set when the task starts. If a member is unknown, invalid, or leased by another task, startup waits or fails visibly without silently dropping that repository. Repair workspace configuration or wait for the holder to release the member, then retry the task; do not edit the shared repository checkout.

### A task is failed after partial land

A branch-gone member without landing proof requires manual intervention. Inspect every member's integration history and the task log; determine which work landed, restore or recreate any missing task branch as appropriate, and then retry only when repository state is consistent.

### Workspace mode appears to re-enable after being toggled off

Check `.fusion/config.json`: explicit `workspaceMode: false` is the guard that suppresses automatic detection. Also inspect `.fusion/workspace.json`; the setting and member configuration are separate artifacts. Re-register or update the configuration deliberately if the project was previously detected as a workspace.

## Worktree layout

When `worktreesDir` is unset, workspace tasks use `<workspace>/.fusion/worktrees/<lowercased-task-id>/<repo>` for every member checkout. A pre-existing member `.worktrees/` root remains honored by containment and cleanup sweeps while the setting stays unset, and recorded paths are never migrated. When it is configured, Fusion resolves the configured root once from the workspace root and creates each native member checkout at `<configured-root>/<workspace>/<repo>/<lowercased-task-id>`. A safe workspace directory basename is preserved verbatim; unsafe names use a sanitized segment plus a deterministic eight-character hash. Nested or unsafe member paths use the same sanitized-and-hashed rule, preventing flattened-name collisions.

Fusion writes `.fusion-workspace-root` only while acquiring an external shared root. It rejects a second, different workspace root with the same safe basename rather than sharing the group; configure another root or rename one workspace. The marker never resolves paths and is only a deletion veto. Recorded worktree paths remain authoritative, so existing checkouts are not migrated. Grouped paths are forward-derived and never converted back to a project root by parent trimming. `.ai-merge` remains at the ungrouped configured root. Workspace directory sweeps do not reclaim by walking groups; archive and workspace recovery reclaim recorded member paths addressably.

### JIRA-derived branch names

Workspace tasks retain the operator-supplied shared branch-name flow. When JIRA integration is enabled, enter an issue key and choose **Derive** to fill the editable branch field using `feature/{key}-{summary}` by default. Failed lookup or authentication leaves the existing branch untouched, so manual branch naming remains available.

## Task repository scope

Every configured repository is acquired for the task; checkout acquisition is not task intent. Planning proposes and Plan Review confirms the final repository scope in `## Repository Scope`, including the dependency assessment required before execution. A clean scoped repository is reported as **No changes — not reviewed** and creates no review, landing, or partial-land obligation. Reviews and landing use only scoped repositories with qualified modified-file evidence.

A task that needs work in a repository added after it started requires a follow-up task. A workspace task normally has no singular `task.worktree`: member worktrees are the only routing authority, so Fusion never creates a worktree at the non-Git workspace root.

## Workspace review evidence and landing

Code Review captures the complete binary diff from each repository's recorded base to its task branch. One episode reviews every modified in-scope repository and reports one verdict covering all per-repository outcomes and findings; clean acquired repositories are recorded as `NOT_REVIEWED`. An ordinary repository reviewer failure is named as not covered by a verdict while other repository findings remain visible. An approval carrying non-blocking notes still approves without another remediation round. An approving workspace Code Review publishes durable per-repository evidence through the dedicated store writer together with its qualified modified-file capture; if that publication cannot be persisted, Fusion reports the review as unavailable rather than approved. A reviewer provider failure, such as a rate limit or transient outage, ends the episode as unavailable and the bounded retry reruns the whole episode rather than publishing a rejection assembled from only part of the workspace. Landing consumes that same repository-qualified file list and fingerprint. Acquiring a checkout alone never creates a landing or approval obligation.

If a modified repository lacks approval, Fusion reports `approval-missing`; if its approved diff no longer matches, it reports `content-changed`. Both diagnostics identify the repository and files, preserve completed work, and automatically route the task back through Code Review rather than exhausting merge retries. Repository/base-ref preparation errors are environment failures: Fusion keeps the Git cause, retries the environment lane only, and Retry resumes that lane without charging a reviewer provider.
