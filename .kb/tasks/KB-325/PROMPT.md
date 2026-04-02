# Task: KB-325 - Fix git diff loading by ensuring commands run from project root

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a localized bug fix with clear scope - the git helper functions need to accept and use a `cwd` parameter. The fix is straightforward and well-understood.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Fix the "Diffs fail to load in git editor" issue by ensuring all git commands in the dashboard API run from the project root directory. Currently, git helper functions use `execSync` without specifying a `cwd` option, causing them to fail when the dashboard server is started from a different working directory than the project root.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/routes.ts` — Git helper functions section (~lines 195-1000) containing all git utility functions
- `packages/dashboard/src/routes.ts` — Git API route handlers (~lines 1750-2300) that call these functions
- `packages/dashboard/src/server.ts` — Lines 45-50 (how terminal service correctly uses rootDir as reference pattern)
- `packages/dashboard/app/api.ts` — Client-side git API functions for understanding the full flow

## File Scope

- `packages/dashboard/src/routes.ts` — Modify git helper functions and their callers
- `packages/dashboard/src/routes.test.ts` — Add/update tests for git commands with cwd

## Steps

### Step 1: Modify Git Helper Functions to Accept cwd Parameter

Update ALL git helper functions to accept an optional `cwd` parameter and pass it to `execSync`:

- [ ] Modify `isGitRepo(cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `getGitStatus(cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `getCommitDiff(hash, cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `getGitCommits(limit, cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `getGitBranches(cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `getGitWorktrees(cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `getGitStashList(cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `createGitStash(message?, cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `applyGitStash(index, drop?, cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `dropGitStash(index, cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `getGitWorkingDiff(cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `getGitFileChanges(cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `stageGitFiles(files, cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `unstageGitFiles(files, cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `createGitCommit(message, cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `discardGitChanges(files, cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `getGitHubRemotes(cwd?)` — Add `cwd` parameter, pass to `execSync` (used by `/git/remotes` endpoint)
- [ ] Modify `listGitRemotes(cwd?)` — Add `cwd` parameter, pass to `execSync` (used by `/git/remotes/detailed`)
- [ ] Modify `addGitRemote(name, url, cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `removeGitRemote(name, cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `renameGitRemote(oldName, newName, cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `setGitRemoteUrl(name, url, cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `fetchGitRemote(remote?, cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `pullGitBranch(cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `pushGitBranch(cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `createGitBranch(name, base?, cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `checkoutGitBranch(name, cwd?)` — Add `cwd` parameter, pass to `execSync`
- [ ] Modify `deleteGitBranch(name, force?, cwd?)` — Add `cwd` parameter, pass to `execSync`

**Pattern to follow:**
```typescript
function getGitWorkingDiff(cwd?: string): { stat: string; patch: string } {
  try {
    const execOptions = { encoding: "utf-8" as const, timeout: 10000, cwd };
    const stat = execSync("git diff --stat", execOptions).trim();
    const patch = execSync("git diff", execOptions);
    return { stat, patch };
  } catch {
    return { stat: "", patch: "" };
  }
}
```

**Note:** The `cwd` option should only be passed to `execSync` when provided. If `cwd` is undefined, `execSync` will use the current process working directory (maintaining backward compatibility).

**Note on `getGitHubRemotes` vs `listGitRemotes`:** These are two distinct functions - `getGitHubRemotes` parses GitHub-specific remotes (used by `/git/remotes`) while `listGitRemotes` returns detailed remote info (used by `/git/remotes/detailed`). Both must be updated.

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 2: Update Route Handlers to Pass store.getRootDir()

Update ALL git API route handlers to get the project root from `store.getRootDir()` and pass it to the git helper functions:

- [ ] GET `/git/status` — Pass `store.getRootDir()` to `isGitRepo` and `getGitStatus`
- [ ] GET `/git/commits/:hash/diff` — Pass `store.getRootDir()` to `isGitRepo` and `getCommitDiff`
- [ ] GET `/git/commits` — Pass `store.getRootDir()` to `isGitRepo` and `getGitCommits`
- [ ] GET `/git/branches` — Pass `store.getRootDir()` to `isGitRepo` and `getGitBranches`
- [ ] GET `/git/worktrees` — Pass `store.getRootDir()` to `isGitRepo` and `getGitWorktrees`
- [ ] GET `/git/stashes` — Pass `store.getRootDir()` to `isGitRepo` and `getGitStashList`
- [ ] POST `/git/stashes` — Pass `store.getRootDir()` to `isGitRepo` and `createGitStash`
- [ ] POST `/git/stashes/:index/apply` — Pass `store.getRootDir()` to `isGitRepo` and `applyGitStash`
- [ ] DELETE `/git/stashes/:index` — Pass `store.getRootDir()` to `isGitRepo` and `dropGitStash`
- [ ] GET `/git/diff` — Pass `store.getRootDir()` to `isGitRepo` and `getGitWorkingDiff`
- [ ] GET `/git/changes` — Pass `store.getRootDir()` to `isGitRepo` and `getGitFileChanges`
- [ ] POST `/git/stage` — Pass `store.getRootDir()` to `isGitRepo` and `stageGitFiles`
- [ ] POST `/git/unstage` — Pass `store.getRootDir()` to `isGitRepo` and `unstageGitFiles`
- [ ] POST `/git/commit` — Pass `store.getRootDir()` to `isGitRepo` and `createGitCommit`
- [ ] POST `/git/discard` — Pass `store.getRootDir()` to `isGitRepo` and `discardGitChanges`
- [ ] GET `/git/remotes` — Pass `store.getRootDir()` to `getGitHubRemotes` (this route does not call `isGitRepo`)
- [ ] GET `/git/remotes/detailed` — Pass `store.getRootDir()` to `isGitRepo` and `listGitRemotes`
- [ ] POST `/git/remotes` — Pass `store.getRootDir()` to `isGitRepo` and `addGitRemote`
- [ ] DELETE `/git/remotes/:name` — Pass `store.getRootDir()` to `isGitRepo` and `removeGitRemote`
- [ ] PATCH `/git/remotes/:name` — Pass `store.getRootDir()` to `isGitRepo` and `renameGitRemote`
- [ ] PUT `/git/remotes/:name/url` — Pass `store.getRootDir()` to `isGitRepo` and `setGitRemoteUrl`
- [ ] POST `/git/fetch` — Pass `store.getRootDir()` to `isGitRepo` and `fetchGitRemote`
- [ ] POST `/git/pull` — Pass `store.getRootDir()` to `isGitRepo` and `pullGitBranch`
- [ ] POST `/git/push` — Pass `store.getRootDir()` to `isGitRepo` and `pushGitBranch`
- [ ] POST `/git/branches` — Pass `store.getRootDir()` to `isGitRepo` and `createGitBranch`
- [ ] POST `/git/branches/:name/checkout` — Pass `store.getRootDir()` to `isGitRepo` and `checkoutGitBranch`
- [ ] DELETE `/git/branches/:name` — Pass `store.getRootDir()` to `isGitRepo` and `deleteGitBranch`

**Pattern to follow:**
```typescript
router.get("/git/diff", (_req, res) => {
  try {
    const rootDir = store.getRootDir();
    if (!isGitRepo(rootDir)) {
      res.status(400).json({ error: "Not a git repository" });
      return;
    }
    const diff = getGitWorkingDiff(rootDir);
    res.json(diff);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
```

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in `packages/dashboard` — all tests must pass
- [ ] Verify existing git API tests still pass (they may mock execSync which should continue to work)
- [ ] Run `pnpm build` — must complete without errors

### Step 4: Documentation & Delivery

- [ ] No documentation updates needed (internal fix)
- [ ] Out-of-scope findings: Create new tasks if any other execSync calls without cwd are discovered

## Completion Criteria

- [ ] All git helper functions accept optional `cwd` parameter and pass it to execSync
- [ ] All git API routes pass `store.getRootDir()` to git functions
- [ ] All tests passing
- [ ] Build passes
- [ ] Manually verified that `GET /git/remotes` returns correct data when dashboard server is started from a subdirectory

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step 1:** `fix(KB-325): add cwd parameter to all git helper functions`
- **Step 2:** `fix(KB-325): pass rootDir to all git commands in route handlers`
- **Step 3:** `test(KB-325): verify git commands use correct working directory`

## Do NOT

- Change the API response format or types
- Modify client-side code (the fix is server-side only)
- Add new dependencies
- Change how the dashboard server is started
- Modify the `isGitRepo` check logic (just add cwd support)
- Skip any git helper functions or routes - ALL must be updated
