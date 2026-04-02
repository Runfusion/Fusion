# Task: KB-055 - Merge feat-github-int to main and switch to main

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward git merge and branch switch. The working tree is clean with no conflicts. Scope is narrow and fully reversible via git commands. No security implications.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Merge the `feat-github-int` branch into `main` and switch the working directory to `main`. This is a cleanup task to finalize work done on the feature branch and return the repository to a clean state on the main branch. The feature branch contains commits for KB-046 (InlineCreateCard), KB-026 (ntfy.sh notifications), KB-049 (hide done tasks toggle), KB-044 (test coverage), KB-038 (steps toggle), and KB-047 (column filters).

## Dependencies

- **None**

## Context to Read First

- `git log --oneline -5 feat-github-int` — Review commits to be merged
- `git log --oneline -3 main` — Review current main state
- `git merge-base feat-github-int main` — Confirm merge base (should be current main HEAD)

## File Scope

- No local file modifications — merge is clean with no conflicts
- `main` branch will receive all commits from `feat-github-int`

## Steps

### Step 0: Preflight

- [ ] Verify current branch is `feat-github-int`
- [ ] Confirm working tree is clean: `git status` shows "nothing to commit, working tree clean"
- [ ] Confirm no merge in progress: `test ! -f .git/MERGE_HEAD`
- [ ] Verify `main` branch exists locally: `git show-ref --verify --quiet refs/heads/main`
- [ ] Review commits to be merged: `git log main..feat-github-int --oneline`

### Step 1: Push Feature Branch and Prepare Main

- [ ] Push current branch to origin: `git push origin feat-github-int`
- [ ] Fetch latest main from origin: `git fetch origin main`
- [ ] Switch to main branch: `git checkout main`
- [ ] Fast-forward main if needed: `git merge --ff-only origin/main` (or confirm up-to-date)

**Artifacts:**
- `feat-github-int` pushed to origin
- Local `main` branch checked out and up-to-date

### Step 2: Merge Feature Branch into Main

- [ ] Merge `feat-github-int` into `main`: `git merge feat-github-int --no-ff -m "feat(KB-055): merge feat-github-int into main"`
- [ ] Verify merge commit created with all feature commits as parents
- [ ] Push main to origin: `git push origin main`

**Artifacts:**
- Merge commit on `main` branch containing all `feat-github-int` commits

### Step 3: Verification & Testing

- [ ] Verify `main` contains the merge: `git log --oneline -5 main`
- [ ] Verify working directory is on `main`: `git branch --show-current` outputs "main"
- [ ] Run `pnpm build` to ensure no TypeScript errors from merge
- [ ] Run `pnpm test` to ensure no test failures from merge
- [ ] Confirm all tests pass with zero failures

**Artifacts:**
- Clean working state on `main` branch with verified build and tests

### Step 4: Cleanup & Documentation

- [ ] Delete local `feat-github-int` branch: `git branch -d feat-github-int`
- [ ] Delete remote `feat-github-int` branch (optional): `git push origin --delete feat-github-int`
- [ ] Confirm repository is in clean state on `main`

**Artifacts:**
- Repository on `main` with feature branch cleaned up

### Step 5: Documentation & Delivery

- [ ] Confirm all changes are pushed to origin/main
- [ ] If any issues found during testing, create follow-up tasks via `task_create`

## Documentation Requirements

**Must Update:**
- None (this is a cleanup task)

**Check If Affected:**
- If build/test failures reveal bugs, document them as new tasks

## Completion Criteria

- [ ] `feat-github-int` successfully merged into `main`
- [ ] Working branch switched to `main`
- [ ] All tests passing
- [ ] Build passes
- [ ] Repository in clean state (no uncommitted changes)
- [ ] Feature branch cleaned up locally

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-055): complete Step N — description`
- **Merge commit:** `feat(KB-055): merge feat-github-int into main`

## Do NOT

- Force push to main
- Skip running tests after merge
- Delete branches without confirming merge was successful
- Use `git merge --squash` (preserve individual commit history)
