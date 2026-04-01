# Task: FN-674 - Fix blank list view in dashboard

**Created:** 2026-04-01
**Size:** S

## Review Level: 2 (Plan and Code)

**Assessment:** The multi-project frontend changes expect backend support for filtering tasks by `projectId`, but the `/api/tasks` endpoint doesn't handle this parameter. The fix requires modifying the backend route to use CentralCore when `projectId` is provided.

**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Fix the dashboard list view showing a blank page when a project is selected. The issue is that the frontend's `fetchProjectTasks()` function sends a `projectId` query parameter, but the backend's `/api/tasks` endpoint ignores it. The endpoint needs to delegate to the appropriate project's TaskStore via CentralCore when `projectId` is provided.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/src/routes.ts` — Lines 1368-1390 contain the `/api/tasks` GET endpoint
2. `packages/dashboard/app/api.ts` — Lines 1859-1866 show `fetchProjectTasks` adding `projectId` param
3. `packages/dashboard/app/hooks/useTasks.ts` — Shows how `fetchProjectTasks` vs `fetchTasks` is selected
4. `packages/core/src/central-core.ts` — Reference for CentralCore API (already has `listProjects`, `getProject`)

## File Scope

- `packages/dashboard/src/routes.ts` — Modify `/api/tasks` GET endpoint (lines ~1368-1390)
- `packages/dashboard/src/__tests__/project-routes.test.ts` — Add test for `/api/tasks?projectId=`

## Steps

### Step 1: Add Project-Aware Task Fetching to Backend

- [ ] Import `CentralCore` dynamically (like other project routes in dist/routes.js) to avoid circular dependencies
- [ ] Modify `/api/tasks` GET handler to check for `req.query.projectId`
- [ ] When `projectId` is provided:
  - Initialize CentralCore and call `init()`
  - Call `getProject(projectId)` to get project info
  - If project not found, return 404
  - Create a TaskStore for that project's path (using the project's `path` field)
  - Call `store.listTasks({ limit, offset })` on that project's store
  - Close CentralCore after operation
- [ ] When `projectId` is not provided, use the existing `store` parameter (current behavior)
- [ ] Handle errors gracefully: if CentralCore is unavailable or project not found, return empty array with 200 (graceful degradation)

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` to ensure all existing tests pass
- [ ] Add test case in `packages/dashboard/src/__tests__/project-routes.test.ts`:
  - Mock CentralCore to return a project with a specific path
  - Verify `/api/tasks?projectId=xxx` returns tasks from that project's store
  - Verify `/api/tasks` without projectId still uses default store
- [ ] Run dashboard and verify:
  - List view shows tasks when "All Projects" (overview mode) is selected
  - List view shows tasks when a specific project is selected
  - No blank page in either case
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/dashboard/src/__tests__/project-routes.test.ts` (modified)

### Step 3: Documentation & Delivery

- [ ] Add changeset for the fix (patch level - bug fix)
- [ ] No documentation updates needed (internal API fix)
- [ ] No out-of-scope findings (this is a targeted bug fix)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Dashboard list view displays tasks correctly in both overview and project modes

## Git Commit Convention

- **Step completion:** `feat(FN-674): complete Step N — description`
- **Bug fixes:** `fix(FN-674): description`
- **Tests:** `test(FN-674): description`

## Do NOT

- Expand scope to implement full multi-project task management
- Modify frontend code (the frontend is correct, backend needs to catch up)
- Break existing single-project behavior
- Skip tests
