---
title: Project registration must initialize Git before persisting the project
date: 2026-06-06
category: integration-issues
module: project-registration
problem_type: integration_issue
component: tooling
symptoms:
  - Adding a project from a plain directory succeeds even though the directory is not a Git repository
  - The first task later fails when the executor tries to create a worktree from a non-Git project path
  - CLI and dashboard registration paths can drift if Git setup is handled only at one surface
root_cause: incomplete_setup
resolution_type: code_fix
severity: high
tags: [project-registration, git-init, central-core, worktrees, cli, dashboard]
---

# Project registration must initialize Git before persisting the project

## Problem

Fusion let users register a new project directory that was not a Git repository. The project appeared usable, but the first task failed later because task execution depends on Git worktree creation.

The failure was reported in issue #1455: project creation succeeded, but execution eventually hit the executor's "not a Git repository" backstop. That made the real setup failure show up after the user had already completed project registration.

## Symptoms

- `fn project add`, dashboard project add, setup flows, or cwd auto-registration could persist a project for a directory with no `.git` metadata.
- The first task for that project failed at execution time because the executor could not create a worktree from the registered path.
- Fixing only `fn init` or only the dashboard route would leave other registration surfaces exposed.

## What Didn't Work

- Treating this as a dashboard-only issue would not cover CLI project add, `fn init`, setup/migration registration, or cwd auto-registration.
- Reusing the explicit `fn init --git` path would have been too invasive for automatic registration: that path can configure Git identity, create `.gitkeep`, create a branch, and make an initial commit.
- Checking only for a `.git` directory would miss valid linked worktrees, where `.git` is a file that points to the real metadata.
- Letting central registration continue after `git init` failed would persist a project that was still guaranteed to fail on its first task.

## Solution

Move the minimal Git readiness check to the shared project registration boundary.

`CentralCore.ensureProjectForPath(...)` now calls a core helper before inserting or reattaching a central project row. The helper asks Git whether the path is already inside a work tree; if not, it runs a minimal `git init`.

```ts
export async function ensureGitRepositoryForProjectPath(
  projectPath: string,
  options: EnsureGitRepositoryOptions = {},
): Promise<GitRepositoryEnsureOutcome> {
  const insideWorkTree = await runGit(["-C", projectPath, "rev-parse", "--is-inside-work-tree"]);

  if (insideWorkTree.ok && insideWorkTree.stdout.trim() === "true") {
    return "existing";
  }

  const init = await runGit(["-C", projectPath, "init"]);
  if (!init.ok) {
    throw new GitRepositoryInitializationError(projectPath, init.stderr || init.error?.message);
  }

  return "initialized";
}
```

The registration layer applies that helper only when a project row is being created or an existing local project identity is being reattached:

```ts
const gitRepository = await this.ensureGitRepositoryForProjectPath(canonicalPath);
return this.registerProject({
  id: identity?.projectId,
  name,
  path: canonicalPath,
  setupMode,
  // ...
});
```

The automatic path deliberately does not create a commit, branch, remote, Git author config, or `.gitkeep`. Those remain part of the explicit `fn init --git` workflow.

CLI `fn init` also treats `GitRepositoryInitializationError` as a blocking central-registration failure instead of falling back to "project initialized locally" messaging. That keeps the failure actionable and prevents a partially registered central row.

## Why This Works

The executor's worktree requirement is a project invariant, not a property of one UI surface. Enforcing it at central registration means every caller that creates or reattaches a project receives the same behavior:

- dashboard project add
- setup wizard and first-run registration
- migration registration
- `fn project add`
- `fn init`
- cwd auto-registration

Using `git rev-parse --is-inside-work-tree` also matches Git's own repository model, including linked worktrees, instead of relying on filesystem shape.

Blocking registration on initialization failure moves the error to the earliest recoverable point. The user sees that Git could not initialize while registering the project, rather than discovering the problem only after task execution starts.

## Follow-on: Integration-branch readiness

Git repository readiness alone was insufficient: a project could have a valid `HEAD` while the merge target was an inferred `main` ref that did not exist locally. The later AI merge then failed with `target branch "main" has no local ref`, even when the repository's only branch was `master` or an unambiguous `refs/remotes/origin/develop` ref was already available.

The shared readiness seam now selects an integration branch with one ordered ladder:

1. configured `integrationBranch`, then legacy `baseBranch`;
2. `origin/HEAD`;
3. well-known local branches in `main`, `master`, `trunk`, `develop` order;
4. the current local HEAD branch, then one remaining non-Fusion local branch;
5. a well-known `origin` remote-tracking branch, then one remaining non-Fusion remote-tracking branch;
6. `main` only when no candidate is available.

A `fusion/*` sibling task branch is never inferred as the project integration branch. Local candidates always win before remote-tracking candidates, so registration cannot retarget an already usable local repository at a remote name.

After baseline creation, registration ensures the selected branch has a local ref. It adopts an existing ref, creates a remote-only ref with plain `git branch <branch> refs/remotes/origin/<branch>`, or creates the fallback/configured ref at `HEAD`. Do **not** replace plain `git branch` with `--track`: an extant remote-tracking ref can lack a configured fetch refspec, where `--track` fails despite safe local materialization. Reconciliation never checks out, switches, resets, or changes the operator's `HEAD`, and never fetches, lists remotes, or contacts the network.

A failed ref materialization is returned as an `unavailable` reconciliation result rather than failing project registration. This keeps registration usable and lets dashboard/CLI surfaces show the action, while downstream merge still retains a loud error for a target that exists nowhere. The merge lane has one narrower recovery: when its target exists under `refs/remotes/origin/<branch>`, it materializes that local ref before merging; it never invents a merge target from `HEAD`.

The ordering is deliberate for an unborn repository with fetched remote refs. The readiness seam creates the baseline first, which creates its symbolic local branch, then reports that branch as existing. Adopting fetched upstream history into a new baseline would change repository history and remains out of scope for this readiness contract.

## Prevention

- Put project-readiness invariants at `CentralCore.ensureProjectForPath(...)` when every project creation surface must share them.
- Keep automatic project registration side effects minimal. If a richer setup path creates commits, branches, or config, leave that behavior behind an explicit flag.
- Regression tests should cover all known registration surfaces, not just the reported reproduction: CLI init, CLI project add, cwd auto-registration, dashboard route registration, setup/first-run paths, fresh registration, existing Git repos, linked worktrees, and reattach from local project identity.
- Test Git initialization failure as a persistence invariant: a failed `git init` must not insert or update the central project row.

## Related Issues

- Issue #1455 - project registration succeeded for non-Git directories, then first task execution failed.
- PR #1463 - shared project-registration Git initialization fix.
