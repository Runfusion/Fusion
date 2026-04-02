# Task: KB-090 - Fix missing API route for task refinement

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Straightforward bug fix - adding a missing Express route that already has store method and frontend API support. Low blast radius, follows established patterns.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

The "Request Refinement" feature in the dashboard fails with "Unexpected token '<', "<!DOCTYPE "... is not valid JSON" because the API endpoint `POST /api/tasks/:id/refine` is not implemented in the dashboard server routes. This error occurs because Express returns an HTML 404 page instead of JSON when the route is missing.

Add the missing route handler to enable users to create refinement tasks from completed or in-review tasks.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/routes.ts` — Existing route patterns (see `POST /tasks/:id/duplicate` and `POST /tasks/:id/retry` for similar route structure)
- `packages/core/src/store.ts` — The `refineTask(id: string, feedback: string)` method already exists (lines 319-379)
- `packages/dashboard/app/api.ts` — Frontend `refineTask()` function that calls the missing endpoint
- `packages/dashboard/app/components/TaskDetailModal.tsx` — UI that triggers refinement (lines 48, 291-320, 701-703, 740-780)

## File Scope

- `packages/dashboard/src/routes.ts` — Add `POST /tasks/:id/refine` route handler
- `packages/dashboard/src/routes.test.ts` — Add tests for the new route

## Steps

### Step 1: Add the Refinement Route

- [ ] Add `POST /tasks/:id/refine` route handler in `packages/dashboard/src/routes.ts`
- [ ] Validate request body has `feedback` string between 1-2000 characters (return 400 if invalid)
- [ ] Get source task and validate it exists (return 404 if not found)
- [ ] Validate source task is in 'done' or 'in-review' column (return 400 if not)
- [ ] Call `store.refineTask(id, feedback)` to create the refinement task
- [ ] Return 201 with the newly created task as JSON
- [ ] Handle errors: ENOENT → 404, validation errors → 400, other errors → 500

**Route Implementation Pattern:**
Follow the existing pattern from `POST /tasks/:id/duplicate` and `POST /tasks/:id/retry`:
```typescript
router.post("/tasks/:id/refine", async (req, res) => {
  try {
    // Validate feedback
    const { feedback } = req.body;
    if (!feedback || typeof feedback !== "string") {
      res.status(400).json({ error: "feedback is required and must be a string" });
      return;
    }
    if (feedback.length === 0 || feedback.length > 2000) {
      res.status(400).json({ error: "feedback must be between 1 and 2000 characters" });
      return;
    }

    // Get and validate source task
    const sourceTask = await store.getTask(req.params.id);
    if (sourceTask.column !== "done" && sourceTask.column !== "in-review") {
      res.status(400).json({ 
        error: `Cannot refine ${req.params.id}: task is in '${sourceTask.column}', must be in 'done' or 'in-review'` 
      });
      return;
    }

    // Create refinement task
    const newTask = await store.refineTask(req.params.id, feedback.trim());
    res.status(201).json(newTask);
  } catch (err: any) {
    const status = err.code === "ENOENT" ? 404
      : err.message?.includes("must be in") ? 400
      : 500;
    res.status(status).json({ error: err.message });
  }
});
```

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` to ensure all existing tests pass
- [ ] Verify the new route works with a manual API test (or use the dashboard UI)

**Artifacts:**
- Test output showing all tests pass

### Step 3: Documentation & Delivery

- [ ] No documentation updates required (this is a bug fix for an existing feature)
- [ ] If any edge cases or related issues are discovered, create follow-up tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None (bug fix)

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-090): complete Step N — description`
- **Bug fixes:** `fix(KB-090): description`
- **Tests:** `test(KB-090): description`

## Do NOT

- Expand task scope beyond fixing the missing route
- Skip running the full test suite
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Add unnecessary abstractions — keep it consistent with existing routes
