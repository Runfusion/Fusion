# Task: KB-261 - Integrate Git Manager Modal into Dashboard UI

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Straightforward integration task. The GitManagerModal component is fully implemented with all requested features (commits, diffs, worktrees, branches, remotes with fetch/pull/push). Only needs UI wiring: state management in App.tsx, trigger button in Header.tsx, and proper mobile/desktop placement.
**Score:** 2/8 — Blast radius: 0 (isolated feature), Pattern novelty: 0 (follows existing modal patterns), Security: 1 (standard UI, no new auth), Reversibility: 1 (easy to remove button/state)

## Mission

Wire up the existing `GitManagerModal` component into the dashboard UI so users can access git management features. The modal already supports viewing commits with diffs, managing branches (create/checkout/delete), viewing worktrees with task associations, and remote operations (fetch/pull/push). This task adds the entry point: a git icon button in the Header that opens the modal on both desktop and mobile.

## Dependencies

- **None**

## Context to Read First

- `/Users/eclipxe/Projects/kb/packages/dashboard/app/App.tsx` — Understand existing modal state patterns (terminalOpen, filesOpen, etc.)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/Header.tsx` — See header button patterns and mobile overflow menu
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/GitManagerModal.tsx` — Verify existing props interface
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/__tests__/GitManagerModal.test.tsx` — Confirm existing test coverage

## File Scope

- `/Users/eclipxe/Projects/kb/packages/dashboard/app/App.tsx` — Add state, handlers, and render GitManagerModal
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/Header.tsx` — Add git button (desktop inline + mobile overflow)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/__tests__/GitManagerModal.test.tsx` — Verify existing tests still pass

## Steps

### Step 1: Add Git Button to Header

- [ ] Add `onOpenGitManager?: () => void` prop to HeaderProps interface
- [ ] Add git branch icon button in desktop header (next to Files button, inline)
- [ ] Add git button to mobile overflow menu
- [ ] Use `GitBranch` icon from lucide-react (already imported in GitManagerModal)
- [ ] Add `data-testid="git-manager-btn"` for desktop button
- [ ] Add `data-testid="overflow-git-btn"` for mobile overflow button

**Artifacts:**
- `packages/dashboard/app/components/Header.tsx` (modified)

### Step 2: Wire Up Git Manager in App.tsx

- [ ] Add `gitManagerOpen` state with `useState(false)`
- [ ] Add `handleOpenGitManager` callback (opens modal)
- [ ] Add `handleCloseGitManager` callback (closes modal)
- [ ] Pass `onOpenGitManager={handleOpenGitManager}` to Header component
- [ ] Add `<GitManagerModal>` to render tree with props:
  - `isOpen={gitManagerOpen}`
  - `onClose={handleCloseGitManager}`
  - `tasks={tasks}`
  - `addToast={addToast}`
- [ ] Position modal rendering near other modals (after ActivityLogModal, before ToastContainer)

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix any failures
- [ ] Verify existing GitManagerModal tests still pass
- [ ] Build passes: `pnpm build`
- [ ] Manual verification: Dashboard loads, git button appears, modal opens with all 5 sections working

### Step 4: Documentation & Delivery

- [ ] Update `packages/dashboard/README.md` — Add "Git Manager" to the features list in the dashboard section if there's a feature list
- [ ] Out-of-scope findings created as new tasks via `task_create` tool (if any)

## Documentation Requirements

**Check If Affected:**
- `packages/dashboard/README.md` — Add Git Manager to features list if applicable

## Completion Criteria

- [ ] Git icon button appears in desktop header (inline with other utility buttons)
- [ ] Git button appears in mobile overflow menu
- [ ] Clicking button opens GitManagerModal with 5 sections: Status, Commits, Branches, Worktrees, Remotes
- [ ] Modal shows real git data from the repository
- [ ] All sections functional: commits load, branches can be created/deleted, remotes can fetch/pull/push
- [ ] Modal closes on Escape key and clicking overlay
- [ ] All tests passing
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-261): complete Step N — description`
- **Bug fixes:** `fix(KB-261): description`
- **Tests:** `test(KB-261): description`

## Do NOT

- Modify GitManagerModal.tsx — the component is already complete
- Add new API endpoints — all git APIs already exist in api.ts
- Create new styles/CSS — use existing modal and layout patterns
- Expand scope to add new git features (stash, tags, etc.) — out of scope for this integration task
- Skip mobile overflow menu placement — must work on all screen sizes
