# Task: KB-130 - Fix dashboard Settings modal stuck on loading

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is a user-facing regression in the dashboard’s settings flow that likely spans the React modal, the dashboard API client, and the `/api/settings` server contract. The blast radius is still contained to the settings path, but the executor should get both the plan and code reviewed because the fix needs regression coverage on both sides of the boundary.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 2

## Mission

Restore the dashboard Settings experience so clicking the gear reliably loads project settings instead of leaving the modal stuck on `Loading…`. The fix must cover the full data path from `packages/dashboard/app/components/SettingsModal.tsx` through `packages/dashboard/app/api.ts` and `packages/dashboard/src/routes.ts`, ensure server-owned fields are not persisted back into `.fusion/config.json`, and add regression tests that prevent future settings/schema changes from stranding the modal in its top-level loading state.

## Dependencies

- **None**

## Context to Read First

- `package.json` — workspace-wide test/build commands (`pnpm test`, `pnpm build`)
- `packages/dashboard/package.json` — dashboard-local scripts and Vitest setup
- `packages/dashboard/app/components/SettingsModal.tsx` — initial `fetchSettings()` load effect, save payload construction, and top-level loading UI
- `packages/dashboard/app/api.ts` — shared `api()` helper plus `fetchSettings()` / `updateSettings()`
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` — existing component test harness and mocked API patterns
- `packages/dashboard/src/routes.ts` — `GET /api/settings` and `PUT /api/settings` handlers
- `packages/dashboard/src/routes.test.ts` — API route test helpers/patterns
- `packages/core/src/types.ts` — `Settings` contract, `DEFAULT_SETTINGS`, and the read-only `githubTokenConfigured` comment
- `packages/core/src/store.ts` — `getSettings()` / `updateSettings()` persistence behavior
- `packages/core/src/store.test.ts` — existing settings persistence coverage to extend if sanitization belongs in the store layer
- `packages/dashboard/app/App.tsx` — secondary `fetchSettings()` consumer that reads `githubTokenConfigured`
- `packages/dashboard/README.md` — dashboard configuration/settings documentation

## File Scope

- `packages/dashboard/app/components/SettingsModal.tsx`
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx`
- `packages/dashboard/app/api.ts`
- `packages/dashboard/app/api.test.ts`
- `packages/dashboard/src/routes.ts`
- `packages/dashboard/src/routes.test.ts`
- `packages/core/src/store.ts`
- `packages/core/src/store.test.ts`
- `packages/core/src/types.ts`
- `packages/dashboard/app/App.tsx`
- `packages/dashboard/README.md`

## Steps

### Step 0: Preflight

- [ ] Required files and paths exist
- [ ] Current verification baseline understood before implementation (including whether any pre-existing `pnpm test` failures still remain)

### Step 1: Repair the settings API/load contract

- [ ] Reproduce the regression by tracing the initial settings request through `fetchSettings()`, `GET /api/settings`, and `TaskStore.getSettings()` before changing behavior
- [ ] Enforce the contract explicitly: `GET /api/settings` includes merged persisted settings plus read-only server fields like `githubTokenConfigured`, while `PUT /api/settings` ignores those read-only fields and does not persist them back into `.fusion/config.json`
- [ ] Keep `fetchSettings()` / `updateSettings()` aligned with that contract so the modal’s initial request settles cleanly instead of hanging on a mismatched payload or unresolved request path
- [ ] Add or update real automated tests in `packages/dashboard/src/routes.test.ts` and `packages/dashboard/app/api.test.ts` that cover the fixed contract and the regression case
- [ ] If persistence sanitization is implemented in `TaskStore.updateSettings()`, add assertion-level coverage in `packages/core/src/store.test.ts` proving server-owned fields such as `githubTokenConfigured` are ignored and never written back to persisted settings
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified)
- `packages/dashboard/app/api.ts` (modified)
- `packages/dashboard/app/api.test.ts` (modified)
- `packages/core/src/store.ts` (modified, if persistence sanitization belongs there)
- `packages/core/src/store.test.ts` (modified, if persistence sanitization belongs there)
- `packages/core/src/types.ts` (modified, if the settings contract needs tightening)
- `packages/dashboard/app/App.tsx` (modified, if the shared settings response shape changes)

### Step 2: Fix the SettingsModal loading lifecycle and recovery UX

- [ ] Refactor the initial load in `SettingsModal` so the modal always leaves the top-level `loading` state after the request settles and renders the General section when settings are available
- [ ] Replace the permanent `Loading…` dead-end with actionable failure handling inside the modal body (for example, an inline error message plus retry path) while preserving the existing toast behavior
- [ ] Preserve existing lazy-loading behavior for the Model and Authentication sections after the initial-load fix
- [ ] Add or update real automated tests in `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` for initial success, initial failure, and successful recovery after retry
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test`
- [ ] Fix all failures required to restore a clean verification baseline for this task’s changes, and create follow-up tasks for any broader cleanup discovered along the way
- [ ] Run `pnpm build`
- [ ] Build passes

### Step 4: Documentation & Delivery

- [ ] Update relevant documentation
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- `packages/dashboard/README.md` — document the user-visible settings-loading fix, including any new inline error/retry behavior or clarified handling of server-owned settings fields

**Check If Affected:**
- `AGENTS.md` — update only if this work changes repository-level workflow guidance (it likely should not)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `fix(KB-130): complete Step N — description`
- **Bug fixes:** `fix(KB-130): description`
- **Tests:** `test(KB-130): description`

## Do NOT

- Expand task scope beyond the dashboard settings loading regression and its direct client/server contract fixes
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Persist server-owned settings fields such as `githubTokenConfigured` back into `.fusion/config.json`
- Create a changeset unless the work unexpectedly affects the published `@dustinbyrne/kb` package (this dashboard-only fix should not)
