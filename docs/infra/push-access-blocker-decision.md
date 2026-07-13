# Push-access blocker for `ischindl` on `Runfusion/Fusion` — decision record

**Task:** AIWO-042
**Date:** 2026-07-13
**Status:** Resolved (workaround adopted, no org-admin action required)

## Symptom

Any direct push to `origin` (`https://github.com/Runfusion/Fusion.git`) from the
`ischindl` git/GitHub identity fails, including for a plain branch push (not just
`main`):

```
$ git push origin main --dry-run
remote: Permission to Runfusion/Fusion.git denied to ischindl.
fatal: unable to access 'https://github.com/Runfusion/Fusion.git/': The requested URL returned error: 403
```

This stalled AIWO-039 (integrationBranch CLI whitelist fix, commit `fa952c7b0`) and
would stall any future verify-and-land task that assumes direct push rights to this
repo.

## Investigation

1. **Credential mechanism**: `git config credential.helper` = `store`; `gh auth
   status` shows `ischindl` logged in via keyring with scopes
   `gist, read:org, repo, workflow`. The token itself is not scope-restricted for
   repo write access.
2. **Actual repo permission** (`gh api repos/Runfusion/Fusion --jq .permissions`):
   ```json
   {"admin": false, "maintain": false, "pull": true, "push": false, "triage": false}
   ```
   This confirms the block is an **account-level permission ceiling**, not a
   token-scope problem — `ischindl` is not a collaborator/member with write access
   on this repo at all.
3. **Secret vault check**: `fn_secret_get` was queried for `GITHUB_TOKEN`,
   `GH_TOKEN`, `GITHUB_PUSH_TOKEN`, and `FUSION_GITHUB_TOKEN` — none exist. No
   alternate push-capable token is provisioned for agent sessions in this
   environment.
4. **Branch-push test** (not just `main`): pushing a disposable branch directly to
   `origin` was *also* denied with the same 403. This rules out "it's just branch
   protection on `main`" — `ischindl` has **zero write access** to
   `Runfusion/Fusion` via the `origin` remote, full stop.
5. **Fork availability**: `repos/Runfusion/Fusion.allow_forking = true`, and
   `ischindl` already has an existing fork at `github.com/ischindl/Fusion`.

## Decision

**Adopted: a fork-based PR landing convention (variant of path (c)).** No
org-admin action is required and no push-capable token needs to be provisioned,
because GitHub already supports the standard "push to your own fork, open a
cross-repo PR against upstream `main`" flow for exactly this situation, and it was
proven to work end-to-end in this session:

- Pushed disposable branch `aiwo-042-pr-convention-smoke-test` to
  `github.com/ischindl/Fusion` (the fork) — succeeded.
- Opened cross-repo PR `Runfusion/Fusion#2055`
  (`base=main`, `head=ischindl:aiwo-042-pr-convention-smoke-test`) via
  `gh pr create --repo Runfusion/Fusion --head ischindl:<branch> --base main`.
  The PR rendered correctly and reported `mergeable: true`.
- Closed the PR without merging and deleted the branch from both the fork and
  locally. No artifacts were left behind in `Runfusion/Fusion` or the fork.

Paths (a) (direct access grant) and (b) (push-capable token) were investigated and
explicitly **not** pursued:

- (b) is not viable in this environment: no push-capable token exists in the
  secret vault, and the existing `gh` token's scopes don't matter because the
  *account* has no write permission on the repo — a broader-scoped token for the
  same account would not help.
- (a) is not necessary right now: the fork-based flow above is a complete,
  self-service substitute for direct push that requires no org-admin action.
  If maintainers later want `ischindl` to have direct write/push access instead of
  the fork workflow, that would still need to be requested explicitly — see
  "If direct access is later wanted" below.

## How to land a task in this repo now (recipe for future verify-and-land tasks)

Because `origin` push is denied, use the fork instead of pushing branches to
`Runfusion/Fusion` directly:

```bash
# One-time setup (already done for ischindl's fork, but shown for completeness):
#   gh repo fork Runfusion/Fusion --clone=false   # only if a fork doesn't exist yet

cd ~/git/Fusion
git remote add fork https://github.com/ischindl/Fusion.git   # if not already present
git fetch fork

# Do the work on a feature/fix branch as usual, e.g.:
git checkout -b my-fix-branch
# ... commit the change ...

# Push to the fork (NOT origin):
git push fork my-fix-branch

# Open a PR from the fork branch against upstream main:
gh pr create --repo Runfusion/Fusion \
  --head ischindl:my-fix-branch \
  --base main \
  --title "..." --body "..."

# Merging requires an account with write/merge rights on Runfusion/Fusion — either
# ask a maintainer to merge the PR via the GitHub UI, or use
#   gh pr merge <number> --repo Runfusion/Fusion --merge
# from an account that has merge permission. `ischindl` cannot merge its own PR
# into upstream `main` without such rights, even though it can open the PR.

# Clean up afterwards:
git push fork --delete my-fix-branch
git branch -D my-fix-branch
git remote remove fork   # optional, if not reused across tasks
```

Notes:
- Always push the working branch to `fork`, never attempt `git push origin
  <branch>` — it will 403 the same way `main` does.
- Keep the fork's `main` in sync periodically (`git fetch origin && git push fork
  origin/main:main`) to avoid large diverging histories, though this is not
  required for opening PRs.
- Do not leave disposable branches or PRs open after landing/testing — clean up
  as shown above.

## If direct access is later wanted instead of the fork workflow

The fork-based PR flow above fully unblocks landing work without any org-admin
action, so this is *not* a blocking ask. If a maintainer later prefers giving
`ischindl` direct push rights (e.g. to avoid the fork round-trip for high-frequency
landing tasks), the explicit ask would be:

- **Repo:** `Runfusion/Fusion`
- **Account:** `ischindl`
- **Requested permission level:** `Write` (repo collaborator role, or
  organization membership with at least `Write` default repository permission)
- **Requested by:** a `Runfusion` org/repo admin

This is optional and not required to unblock AIWO-039 or future verify-and-land
tasks — the fork/PR recipe above is the standing mechanism going forward.

## Follow-up

- AIWO-039 (currently back in Planning, 0/5 steps, re-triaged since this task's
  spec was written) should use the fork-based recipe above when it reaches its own
  landing/push step, instead of `git push origin main`. A follow-up task has been
  filed to track this (see task board).
