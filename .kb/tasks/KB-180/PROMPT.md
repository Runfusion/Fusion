# Task: KB-180 - Fix Planning Mode API returning HTML instead of JSON

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** The planning mode feature exists and has passing tests, but fails in production with HTML being returned instead of JSON from `/api/planning/*` endpoints. This requires both debugging the root cause and implementing defensive fixes to ensure robust error handling.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Fix the planning mode feature so that API endpoints return proper JSON responses instead of falling through to the SPA fallback and returning HTML. The user sees "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON" when submitting a plan from the dashboard header. The routes exist and tests pass, so the issue is in production runtime behavior.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/server.ts` — Server setup, route mounting order, SPA fallback
- `packages/dashboard/src/routes.ts` — API route definitions (planning routes around line 2320-2590)
- `packages/dashboard/src/routes.test.ts` — Existing planning route tests (lines 3250+)
- `packages/dashboard/app/api.ts` — Frontend API client, especially the `api()` helper function
- `packages/dashboard/app/components/PlanningModeModal.tsx` — Modal that calls planning APIs

## File Scope

- `packages/dashboard/src/server.ts` — Review route mounting, add debug logging, ensure planning routes are accessible
- `packages/dashboard/app/api.ts` — Improve error handling for non-JSON responses
- `packages/dashboard/src/routes.ts` — Verify planning routes are properly exported (lines 2320-2590)

## Steps

### Step 1: Diagnose Route Registration

- [ ] Add startup logging in `createApiRoutes` to list all registered routes including planning routes
- [ ] Add request logging middleware for `/api/planning/*` paths to see if requests reach the router
- [ ] Run the dashboard locally and verify planning mode works in development
- [ ] Compare development vs production behavior to identify environment differences

**Key investigation points:**
- Verify `router.post("/planning/start-streaming", ...)` is called during route registration
- Check if requests to `/api/planning/start-streaming` reach the route handler
- Examine if the SPA fallback (`app.get("/{*splat}", ...)`) is intercepting API requests

**Artifacts:**
- `packages/dashboard/src/server.ts` (modified - with debug logging)
- `packages/dashboard/src/routes.ts` (modified - with debug logging)

### Step 2: Fix Route Matching Issue

- [ ] Identify why `/api/planning/*` routes aren't matching in production
- [ ] Fix the root cause (possible causes below)

**Common causes to check:**
1. **Trailing slashes** — Request goes to `/api/planning/start-streaming/` instead of `/api/planning/start-streaming`
2. **Case sensitivity** — URL case mismatch
3. **Request method** — POST request being converted to GET by proxy/middleware
4. **Body parsing** — Request body not being parsed correctly, causing early error
5. **Route ordering** — SPA fallback being registered before API routes in some build configurations

**Fix implementation:**
- If body parsing issue: Ensure `express.json()` middleware is applied before planning routes
- If route ordering: Move SPA fallback to absolute last position or use more specific pattern
- If path issue: Add flexible route matching or normalize paths

**Artifacts:**
- `packages/dashboard/src/server.ts` (modified - fixed route ordering or middleware)
- `packages/dashboard/src/routes.ts` (modified - if route pattern fixes needed)

### Step 3: Improve API Client Error Handling

The current `api()` function calls `res.json()` before checking `res.ok`, which causes confusing error messages when HTML is returned.

- [ ] Update `api()` function to check content-type before parsing JSON
- [ ] Add specific error message when HTML is received instead of JSON
- [ ] Include the actual URL in error messages for easier debugging

**Current code (api.ts lines 6-15):**
```typescript
async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json();  // This throws on HTML
  if (!res.ok) throw new Error((data as { error?: string }).error || "Request failed");
  return data as T;
}
```

**Improved version should:**
1. Check `content-type` header
2. If HTML received, throw descriptive error: "API returned HTML instead of JSON. The endpoint /api/planning/start-streaming may not be properly configured."
3. Include response status and statusText in error
4. Then parse JSON and check `res.ok`

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified - better error handling)

### Step 4: Add Route Existence Verification Test

- [ ] Create integration test that verifies all planning routes return JSON (not HTML)
- [ ] Test `/api/planning/start`, `/api/planning/start-streaming`, `/api/planning/respond`, `/api/planning/cancel`, `/api/planning/create-task`
- [ ] Ensure test fails if any route returns HTML content-type

**Test pattern to add in `routes.test.ts`:**
```typescript
describe("Planning routes content-type verification", () => {
  it("all planning endpoints return JSON not HTML", async () => {
    // POST /planning/start-streaming
    const res = await REQUEST(...);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).not.toContain("<!DOCTYPE");
  });
});
```

**Artifacts:**
- `packages/dashboard/src/routes.test.ts` (modified - new test)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Start dashboard in production mode: `pnpm build && node dist/server.js`
- [ ] Test planning mode from header lightbulb icon
- [ ] Verify `/api/planning/start-streaming` returns JSON: `curl -X POST /api/planning/start-streaming -H "Content-Type: application/json" -d '{"initialPlan":"test"}'`
- [ ] Remove debug logging before final commit (or convert to `console.debug`)

### Step 6: Documentation & Delivery

- [ ] Update any relevant documentation if API behavior changed
- [ ] If root cause reveals systemic issue, create follow-up task for broader route audit
- [ ] Document the fix in commit message for future reference

## Documentation Requirements

**Must Update:**
- None (bug fix)

**Check If Affected:**
- `AGENTS.md` — If route debugging reveals pattern issues worth documenting

## Completion Criteria

- [ ] Planning mode works end-to-end in production build
- [ ] Submitting a plan returns JSON and proceeds to question view (not error)
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] API client provides clear error messages if JSON parsing fails

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-180): complete Step N — description`
- **Bug fixes:** `fix(KB-180): description`
- **Tests:** `test(KB-180): description`

## Do NOT

- Remove the planning feature entirely
- Skip tests for the planning routes
- Change the planning API contract (keep same request/response format)
- Add unnecessary complexity to route definitions
- Modify files outside the File Scope without good reason
- Leave debug logging in production code (use console.debug or remove)

## Notes for Implementer

The error "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON" means the fetch response is HTML (the SPA's index.html) not JSON. This happens when:

1. Express route isn't matched (falls through to SPA fallback)
2. Request URL doesn't match the route pattern
3. Request method doesn't match (GET vs POST)
4. A proxy/middleware transforms the request

The routes ARE correctly defined (verified in tests). The issue is runtime request handling. Focus on:
- Verifying the route mounting order in server.ts
- Checking if body parsing middleware is working
- Ensuring the SPA fallback doesn't catch API routes

Route patterns to verify:
- `POST /api/planning/start` → router.post("/planning/start", ...)
- `POST /api/planning/start-streaming` → router.post("/planning/start-streaming", ...)
- `POST /api/planning/respond` → router.post("/planning/respond", ...)
- `POST /api/planning/cancel` → router.post("/planning/cancel", ...)
- `POST /api/planning/create-task` → router.post("/planning/create-task", ...)
