# Task: KB-018 - Simplify GitHub Import Modal Remote Selection

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Small UI-only change removing redundant owner/repo input fields when remotes are available. Low blast radius, no security implications, easily reversible.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Simplify the GitHub import modal by removing the owner/repo input fields and relying solely on the git remote dropdown. When only one remote exists, automatically use it without showing a dropdown. When multiple remotes exist, show a clean dropdown to select the repository. This reduces UI clutter and prevents user confusion between manual entry and remote selection.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/GitHubImportModal.tsx` — Current modal implementation
- `packages/dashboard/app/components/__tests__/GitHubImportModal.test.tsx` — Existing tests
- `packages/dashboard/app/api.ts` — API types including `GitRemote` interface
- `packages/dashboard/app/styles.css` — Modal and form styling (lines 620-728, 1761-1776)

## File Scope

- `packages/dashboard/app/components/GitHubImportModal.tsx` (modify)
- `packages/dashboard/app/components/__tests__/GitHubImportModal.test.tsx` (modify)

## Steps

### Step 1: Update GitHubImportModal Component

- [ ] Remove owner/repo input fields from the UI (keep the state variables for internal use)
- [ ] When `remotes.length === 1`: Show the remote name as read-only text (no dropdown), auto-populate owner/repo state
- [ ] When `remotes.length > 1`: Show a dropdown with remote names (format: `remote-name (owner/repo)`)
- [ ] When `remotes.length === 0`: Show "No GitHub remotes detected" message with instructions to add a remote
- [ ] Keep labels input and Load button in the same position
- [ ] Ensure owner/repo state is always set correctly based on selected remote
- [ ] Handle edge case: when switching remotes, update owner/repo state accordingly

**Artifacts:**
- `packages/dashboard/app/components/GitHubImportModal.tsx` (modified)

### Step 2: Update Tests

- [ ] Update test mocks to include `fetchGitRemotes` return values
- [ ] Add test: when single remote exists, owner/repo inputs are not shown, remote is auto-selected
- [ ] Add test: when multiple remotes exist, dropdown is shown with all remotes
- [ ] Add test: when no remotes exist, shows appropriate message
- [ ] Update existing tests that currently interact with owner/repo inputs to work with remote selection
- [ ] Ensure all existing test scenarios still work (load issues, import, error handling)

**Artifacts:**
- `packages/dashboard/app/components/__tests__/GitHubImportModal.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` to verify all tests pass
- [ ] Run `pnpm build` to ensure no TypeScript errors
- [ ] Manually verify modal behavior:
  - Single remote: auto-selected, no dropdown, inputs hidden
  - Multiple remotes: dropdown shown, selection works
  - No remotes: helpful message shown

### Step 4: Documentation & Delivery

- [ ] Create changeset file for this UI improvement (patch level)

## Documentation Requirements

**Must Update:**
- None (UI change is self-documenting)

**Check If Affected:**
- `packages/dashboard/README.md` — Update screenshots if it shows the GitHub import modal

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] No owner/repo input fields visible in the modal
- [ ] Single remote: automatically selected, shown as text
- [ ] Multiple remotes: dropdown shown for selection
- [ ] Load button works correctly with selected remote
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-018): complete Step N — description`
- **Bug fixes:** `fix(KB-018): description`
- **Tests:** `test(KB-018): description`

## Do NOT

- Remove the owner/repo state variables (still needed for API calls)
- Change the API endpoints or backend behavior
- Modify styling beyond what's necessary for the new layout
- Skip updating tests for the new UI flow
- Break existing functionality (labels filter, issue loading, importing)
