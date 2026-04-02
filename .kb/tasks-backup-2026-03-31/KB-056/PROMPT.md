# Task: KB-056 - Fix GET /models 404 when registry has no models

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Small focused fix to verify GET /models returns 200 with empty array instead of 404 when registry has no available models. Limited blast radius to a single route handler.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Ensure the dashboard API endpoint `GET /api/models` correctly returns HTTP 200 with an empty JSON array when the model registry has no available models, rather than returning 404. The tests in `routes.test.ts` already expect this behavior, and the implementation in `routes.ts` should be verified to match.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/routes.ts` — Read the `registerModelsRoute` function (lines ~1596-1620)
- `packages/dashboard/src/routes.test.ts` — Read the "GET /models" describe block with all model-related tests
- `packages/dashboard/app/api.ts` — Read the `fetchModels()` function to understand frontend expectations

## File Scope

- `packages/dashboard/src/routes.ts` (verify only — implementation should already be correct)
- `packages/dashboard/src/routes.test.ts` (verify test coverage)

## Steps

### Step 1: Verify Implementation

- [ ] Read `registerModelsRoute` function in `routes.ts`
- [ ] Confirm it returns `res.json([])` with status 200 (implicit) when `modelRegistry.getAvailable()` returns empty array
- [ ] Confirm it returns `res.json([])` with status 200 when `modelRegistry` is undefined
- [ ] Verify there is NO code path that returns 404 for empty models

**Artifacts:**
- `packages/dashboard/src/routes.ts` (verified)

### Step 2: Verify Test Coverage

- [ ] Read the "GET /models" test suite in `routes.test.ts`
- [ ] Verify test "returns empty array when registry has no available models" exists and passes
- [ ] Verify test "returns empty array when no model registry is provided" exists and passes
- [ ] Verify test "returns 500 when registry throws" exists and passes

**Artifacts:**
- `packages/dashboard/src/routes.test.ts` (verified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run the specific model tests: `pnpm test -- --run -t "GET /models"`
- [ ] Run all dashboard API tests: `pnpm test -- --run routes.test.ts`
- [ ] Run full dashboard test suite: `pnpm test`
- [ ] Verify all 764 tests pass

### Step 4: Documentation & Delivery

- [ ] Add inline comment in `registerModelsRoute` explaining the empty array behavior
- [ ] Verify no changeset needed (this is a test/verification task, not a behavior change)

## Documentation Requirements

**Check If Affected:**
- `packages/dashboard/README.md` — Check if API documentation mentions the models endpoint behavior; update if needed

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (764/764)
- [ ] GET /models returns 200 with `[]` when registry has no models
- [ ] No 404 response for empty model scenarios

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-056): complete Step N — description`
- **Documentation:** `docs(KB-056): description`
- **Tests:** `test(KB-056): description`

## Do NOT

- Change the behavior to return 404 (tests expect 200 with empty array)
- Modify the test expectations (they are correct)
- Add unnecessary complexity to the route handler
- Skip test verification steps
