# Task: KB-059 - Lock Mobile Viewport to Prevent Zoom

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Small, focused change to HTML meta tags and CSS. No logic changes, minimal blast radius. Reversible by reverting the viewport meta tag.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Prevent mobile browsers from zooming in/out on the dashboard to create an app-like experience where the view stays locked at a consistent scale. Update the viewport meta tag and add necessary CSS to disable pinch-to-zoom and double-tap zoom behaviors while maintaining accessibility for form inputs.

## Dependencies

- **None** — This task is independent and can be completed before or alongside KB-035

## Context to Read First

1. `packages/dashboard/app/index.html` — HTML template containing the current viewport meta tag
2. `packages/dashboard/app/styles.css` — Global styles including mobile responsive `@media` queries
3. `packages/dashboard/app/App.tsx` — Root component to understand layout structure

## File Scope

- `packages/dashboard/app/index.html` — modify viewport meta tag
- `packages/dashboard/app/styles.css` — add CSS to prevent zoom gestures (optional, if needed beyond meta tag)

## Steps

### Step 0: Preflight

- [ ] Required files exist at `packages/dashboard/app/index.html` and `packages/dashboard/app/styles.css`
- [ ] No dependencies blocking this task

### Step 1: Update Viewport Meta Tag

- [ ] Read current `index.html` and locate the viewport meta tag
- [ ] Update the viewport meta tag to prevent zoom:
  - Change from: `content="width=device-width, initial-scale=1.0"`
  - Change to: `content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover"`
- [ ] Ensure the meta tag includes `viewport-fit=cover` for proper handling of notches/safe areas on modern mobile devices
- [ ] Verify the tag remains valid HTML5

**Artifacts:**
- `packages/dashboard/app/index.html` (modified)

### Step 2: Add Touch-Action CSS (if needed)

- [ ] Check if additional CSS is needed to prevent zoom gestures that bypass the meta tag (iOS Safari sometimes ignores user-scalable)
- [ ] If needed, add to the `html, body` selector in `styles.css`:
  - `touch-action: pan-x pan-y;` — allows horizontal/vertical panning but not pinch zoom
  - `-webkit-touch-callout: none;` — prevents iOS callout menu on long press (optional, assess if it affects UX)
- [ ] Ensure form inputs still work correctly (inputs should not be blocked from receiving focus)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified if needed)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Create test file `packages/dashboard/app/__tests__/mobile-viewport.test.ts` that validates:
  - Viewport meta tag exists in index.html
  - Viewport meta tag contains `maximum-scale=1.0`
  - Viewport meta tag contains `user-scalable=no`
  - Viewport meta tag contains `viewport-fit=cover`
- [ ] Run full test suite: `pnpm test packages/dashboard`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Verify no console warnings or errors

**Artifacts:**
- `packages/dashboard/app/__tests__/mobile-viewport.test.ts` (new)

### Step 4: Documentation & Delivery

- [ ] Check `packages/dashboard/README.md` — add a brief note about mobile app-like experience if a "Mobile Support" section exists
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None required — the viewport change is self-documenting

**Check If Affected:**
- `packages/dashboard/README.md` — add mobile behavior note if a mobile section exists

## Completion Criteria

- [ ] All steps complete
- [ ] Viewport meta tag prevents zoom (`user-scalable=no`, `maximum-scale=1.0`)
- [ ] `viewport-fit=cover` included for safe area support
- [ ] All tests passing (including new `mobile-viewport.test.ts`)
- [ ] Build passes
- [ ] Mobile browsers cannot zoom the dashboard view (feels like a native app)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-059): complete Step N — description`
- **Bug fixes:** `fix(KB-059): description`
- **Tests:** `test(KB-059): description`

## Do NOT

- Add JavaScript-based zoom prevention (unnecessary, meta tag is sufficient)
- Block legitimate accessibility features (screen readers should still work)
- Prevent input focus or text selection (only prevent zoom)
- Skip tests or rely on manual verification only
- Modify desktop viewport behavior
