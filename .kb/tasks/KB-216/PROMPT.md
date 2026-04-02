# Task: KB-216 - Auto-load GitHub issues on import modal

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** Single component change with well-defined behavior. No security implications, localized blast radius, fully reversible.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 1

## Mission

Eliminate the manual "Load" button step in the GitHub import modal by auto-loading issues when the repository selection is ready. For single-remote repositories, issues load immediately when the modal opens. For multi-remote repositories, issues load automatically when the user selects a remote.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/GitHubImportModal.tsx` — the component to modify
- `packages/dashboard/app/components/__tests__/GitHubImportModal.test.tsx` — existing tests to update

## File Scope

- `packages/dashboard/app/components/GitHubImportModal.tsx` (modified)
- `packages/dashboard/app/components/__tests__/GitHubImportModal.test.tsx` (modified)

## Steps

### Step 1: Implement Auto-Load Behavior

- [ ] Add `useEffect` hook that triggers `handleLoad` when `owner` and `repo` are set and valid
- [ ] Track whether the load was user-initiated or auto-triggered (to avoid loading on every owner/repo change during modal lifecycle)
- [ ] For single remote: auto-load immediately after remotes are fetched
- [ ] For multiple remotes: auto-load when user selects a remote from dropdown
- [ ] Keep the Load button visible but make it a "Refresh" button that re-fetches issues
- [ ] Ensure labels filter is respected on auto-load (use current labels state)
- [ ] Prevent duplicate concurrent loads (guard with `loading` state)

**Artifacts:**
- `packages/dashboard/app/components/GitHubImportModal.tsx` (modified)

### Step 2: Update Tests for Auto-Load Behavior

- [ ] Update single remote test: verify `apiFetchGitHubIssues` is called automatically without clicking Load
- [ ] Update multiple remotes test: verify auto-load happens after selecting remote, not on button click
- [ ] Add test: changing remote selection re-fetches issues automatically
- [ ] Add test: changing labels and clicking Refresh re-fetches with new labels
- [ ] Update existing tests that expect manual Load button click to match new behavior
- [ ] Ensure all tests pass

**Artifacts:**
- `packages/dashboard/app/components/__tests__/GitHubImportModal.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all tests must pass
- [ ] Run `pnpm build` — build must succeed
- [ ] Manual verification: Open GitHub import modal with single remote → issues load automatically
- [ ] Manual verification: With multiple remotes → selecting a remote loads issues automatically
- [ ] Manual verification: Refresh button re-fetches issues

### Step 4: Documentation & Delivery

- [ ] No documentation updates required (UI behavior change is self-explanatory)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if any

## Documentation Requirements

**Must Update:** None

**Check If Affected:** None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Auto-load works for single remote (on modal open)
- [ ] Auto-load works for multiple remotes (on selection change)
- [ ] Refresh button works for manual re-fetch
- [ ] Labels filter respected in auto-load

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-216): complete Step N — description`
- **Bug fixes:** `fix(KB-216): description`
- **Tests:** `test(KB-216): description`

## Do NOT

- Change the API layer (api.ts) — use existing endpoints
- Modify the server-side GitHub import logic
- Add new dependencies
- Change the visual design/layout of the modal beyond the Load → Refresh button text change
- Remove the ability to filter by labels before loading
- Break existing import functionality
