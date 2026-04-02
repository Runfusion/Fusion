# Task: KB-102 - Pull from Remote, Resolve Conflicts, and Push Changes

**Created:** 2026-03-30
**Size:** S

## Review Level: 0 (None)

**Assessment:** This is a one-time git synchronization task. No code changes to review - just fetch, merge, conflict resolution, and push operations.
**Score:** 0/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 0

## Mission

Synchronize the current repository with its upstream remote by fetching changes, merging them into the current branch, resolving any merge conflicts using the project's established auto-resolution patterns, and pushing the result to origin.

The repository has two remotes configured:
- `origin`: https://github.com/gsxdsm/kb.git (the fork)
- `upstream`: https://github.com/dustinbyrne/kb.git (the source)

This task pulls from upstream, applies any changes to the current branch, handles conflicts if they arise, and pushes the synchronized state to origin.

## Dependencies

- **None**

## Context to Read First

- `.fusion/config.json` — review `autoResolveConflicts` and `smartConflictResolution` settings to understand conflict resolution preferences
- `packages/engine/src/merger.ts` — understand the conflict classification and resolution patterns (LOCKFILE_PATTERNS, GENERATED_PATTERNS, trivial whitespace detection)

## File Scope

This task modifies no project source files. It only affects:
- Git repository state (branches, refs)
- Working directory files (during merge conflict resolution)

## Steps

### Step 1: Fetch from Upstream

- [ ] Fetch latest changes from `upstream` remote
- [ ] Identify the default branch on upstream (likely `main` or `master`)
- [ ] Check if there are any incoming changes

**Artifacts:**
- Updated remote refs in `.git/refs/remotes/upstream/`

### Step 2: Merge Upstream Changes

- [ ] Determine current local branch
- [ ] Merge `upstream/main` (or `upstream/master`) into current branch
- [ ] If merge succeeds with no conflicts, verify with `git status`
- [ ] If conflicts exist, proceed to Step 3

**Artifacts:**
- Merged commit history in current branch
- Staged changes from upstream

### Step 3: Resolve Merge Conflicts (if any)

Use the project's established conflict resolution patterns:

- [ ] Run `git diff --name-only --diff-filter=U` to identify conflicted files
- [ ] For each conflicted file, classify using patterns from `merger.ts`:
  - **Lock files** (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, etc.) → resolve with `--ours` (keep current branch's version)
  - **Generated files** (`*.gen.ts`, `dist/*`, `coverage/*`, etc.) → resolve with `--theirs` (take upstream's fresh generation)
  - **Trivial whitespace conflicts** → resolve by staging (`git add` after verifying only whitespace differs)
  - **Complex conflicts** → manually examine conflict markers and produce correct merged result
- [ ] Verify all conflict markers removed: `grep -r "<<<<<<<" . --include="*.ts" --include="*.js" --include="*.json" --include="*.md" 2>/dev/null | grep -v node_modules | grep -v ".git" || echo "No conflict markers found"`
- [ ] Stage all resolved files with `git add`
- [ ] Commit the merge with an appropriate message describing the sync

**Artifacts:**
- Resolved conflicted files (no conflict markers remaining)
- Merge commit completing the upstream sync

### Step 4: Push to Origin

- [ ] Push current branch to `origin`
- [ ] Verify push succeeded with `git status` showing "Your branch is up to date with 'origin/...'"

**Artifacts:**
- Updated branch on origin remote

### Step 5: Verification

- [ ] Run `git log --oneline --graph -10` to verify merge history
- [ ] Run `git status` to confirm working directory is clean
- [ ] Run full test suite: `pnpm test` — all tests must pass
- [ ] Run build: `pnpm build` — must complete successfully

## Documentation Requirements

**Must Update:**
- None — this is a git sync operation with no code changes requiring documentation

**Check If Affected:**
- `README.md` — verify no changes needed (upstream shouldn't have diverged in ways requiring README updates)

## Completion Criteria

- [ ] Successfully fetched from `upstream`
- [ ] Merged upstream changes into current branch
- [ ] All conflicts resolved (or no conflicts existed)
- [ ] Working directory is clean with no uncommitted changes
- [ ] Successfully pushed to `origin`
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)

## Git Commit Convention

Since this task may create merge commits:

- **Merge commit:** `Merge remote-tracking branch 'upstream/main'` (git default) OR `chore: sync with upstream`
- **Conflict fixes:** If manual resolution required for complex conflicts, commit as `fix(KB-102): resolve merge conflicts with upstream`

## Do NOT

- Force push to origin (use normal push)
- Modify source files beyond conflict resolution
- Change project settings or configurations
- Delete the local repository or worktrees
- Use `git rebase` for this sync (use merge to preserve upstream commit history)
- Skip tests after resolving conflicts
