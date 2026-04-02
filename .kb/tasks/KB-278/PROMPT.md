# Task: KB-278 - Remove 500 Character Limit on Initial Plan Input

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Simple constraint removal from backend validation - only affects two route handlers and their tests. No architectural changes.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Remove the 500 character limit restriction on the `initialPlan` field when users input a task plan through the Planning Mode feature. The limit is enforced on both `/api/planning/start` and `/api/planning/start-streaming` endpoints. This allows users to provide more detailed initial descriptions for AI-assisted task planning.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/routes.ts` — Lines 4199-4275 contain the two planning route handlers with 500 character validation
- `packages/dashboard/src/routes.test.ts` — Contains tests validating the 500 character limit
- `packages/dashboard/app/api.test.ts` — Contains frontend API tests for planning

## File Scope

- `packages/dashboard/src/routes.ts` — Remove validation from two routes
- `packages/dashboard/src/routes.test.ts` — Remove test for 500 character limit
- `packages/dashboard/app/api.test.ts` — Remove test for 500 character validation error

## Steps

### Step 1: Remove Backend Validation

- [ ] Remove the 500 character validation block from `POST /api/planning/start` route (around line 4211-4214)
- [ ] Remove the 500 character validation block from `POST /api/planning/start-streaming` route (around line 4248-4251)
- [ ] Keep the required field validation (`!initialPlan || typeof initialPlan !== "string"`)
- [ ] Run `pnpm build` to verify TypeScript compiles

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified) — Two validation blocks removed

### Step 2: Update Backend Tests

- [ ] Remove the test "rejects initialPlan longer than 500 chars" from `packages/dashboard/src/routes.test.ts` (around lines 3928-3939)
- [ ] Run `pnpm test -- packages/dashboard/src/routes.test.ts` to verify tests pass

**Artifacts:**
- `packages/dashboard/src/routes.test.ts` (modified) — Obsolete test removed

### Step 3: Update Frontend API Tests

- [ ] Remove the test "throws on validation error" in the `startPlanning` describe block from `packages/dashboard/app/api.test.ts` (around lines 1117-1122)
- [ ] Run `pnpm test -- packages/dashboard/app/api.test.ts` to verify tests pass

**Artifacts:**
- `packages/dashboard/app/api.test.ts` (modified) — Obsolete test removed

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Run build: `pnpm build`
- [ ] All tests must pass

### Step 5: Documentation & Delivery

- [ ] No documentation updates required (this is removing a constraint, not adding a feature)
- [ ] Create changeset for the dashboard package: `.changeset/remove-plan-char-limit.md`

## Documentation Requirements

**Must Update:**
- None

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] No new tests needed (removing validation, not adding)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-278): complete Step N — description`
- **Bug fixes:** `fix(KB-278): description`
- **Tests:** `test(KB-278): description`

**Example commits:**
```
feat(KB-278): complete Step 1 — remove 500 char limit from planning routes
test(KB-278): remove obsolete 500 char validation tests
```

## Do NOT

- Add new validation logic to replace the removed limit
- Modify any frontend UI components (they don't have the limit)
- Change the planning session logic or AI behavior
- Skip the build verification step
- Leave failing tests behind

## Exact Changes Required

### In `packages/dashboard/src/routes.ts`:

Remove these two blocks (around line 4211-4214 and 4248-4251):

```typescript
// REMOVE THIS BLOCK (appears in both routes):
if (initialPlan.length > 500) {
  res.status(400).json({ error: "initialPlan must be 500 characters or less" });
  return;
}
```

Keep these validations:
```typescript
// KEEP THIS - still required
if (!initialPlan || typeof initialPlan !== "string") {
  res.status(400).json({ error: "initialPlan is required and must be a string" });
  return;
}
```

### In `packages/dashboard/src/routes.test.ts`:

Remove this test (around line 3928-3939):
```typescript
it("rejects initialPlan longer than 500 chars", async () => {
  const longPlan = "a".repeat(501);
  const res = await REQUEST(
    buildApp(),
    "POST",
    "/api/planning/start",
    JSON.stringify({ initialPlan: longPlan }),
    { "Content-Type": "application/json" }
  );

  expect(res.status).toBe(400);
  expect(res.body.error).toContain("500 characters");
});
```

### In `packages/dashboard/app/api.test.ts`:

Remove this test (around line 1117-1122):
```typescript
it("throws on validation error", async () => {
  globalThis.fetch = vi.fn().mockReturnValue(
    mockFetchResponse(false, { error: "initialPlan must be 500 characters or less" }, 400)
  );

  await expect(startPlanning("a".repeat(600))).rejects.toThrow("500 characters");
});
```
