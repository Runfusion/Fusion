# Task: KB-235 - Fix duplicate delay function in packages dashboard src

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** Simple duplicate function removal - straightforward fix with minimal blast radius
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Remove the duplicate `delay` function in `packages/dashboard/src/github.ts`. The duplicate exists in the committed version at line 1920 (identical to the one at line 15), causing TypeScript compilation errors due to function redeclaration. The fix involves keeping the first occurrence at line 15 and removing the duplicate at line 1920.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/github.ts` — Check current state of the file; if working directory already has fix applied, verify and commit it. Otherwise, remove the duplicate.
- Use `git show HEAD:packages/dashboard/src/github.ts | grep -n "function delay"` to verify duplicate exists in committed version

## File Scope

- `packages/dashboard/src/github.ts` — Remove duplicate `delay` function at line 1920 (or verify it's already removed in working directory)

## Steps

### Step 0: Preflight

- [ ] Check committed version for duplicate: `git show HEAD:packages/dashboard/src/github.ts | grep -n "function delay"`
- [ ] Verify TWO `delay` functions exist in HEAD (lines 15 and 1920)
- [ ] Check working directory state: `grep -n "function delay" packages/dashboard/src/github.ts`
- [ ] If working directory shows TWO functions, proceed to Step 1 to remove the duplicate
- [ ] If working directory shows ONE function, the fix is already applied — proceed to verification in Step 2

### Step 1: Fix Duplicate Function

- [ ] Remove the duplicate `delay` function at line 1920 (located just after `shouldRetryBatchRequestError` function)
- [ ] The exact code to remove (4 lines including blank line):
  ```typescript
  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  ```
- [ ] Verify only one `delay` function remains at line 15

**Artifacts:**
- `packages/dashboard/src/github.ts` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run dashboard TypeScript typecheck: `cd packages/dashboard && npx tsc --noEmit`
- [ ] Run full test suite: `pnpm test`
- [ ] Fix any failures
- [ ] Build passes: `pnpm build`
- [ ] Verify `grep -n "function delay" packages/dashboard/src/github.ts` shows exactly ONE result

### Step 3: Documentation & Delivery

- [ ] Create changeset file for the fix (patch level)
- [ ] Stage the change: `git add packages/dashboard/src/github.ts`
- [ ] Commit the fix with task ID prefix

**Changeset:**
```bash
cat > .changeset/fix-duplicate-delay.md << 'EOF'
---
"@dustinbyrne/kb": patch
---

Fix duplicate delay function in packages/dashboard/src/github.ts that was causing build failures.
EOF
```

**Commit message:**
```
feat(KB-235): remove duplicate delay function in github.ts

Removes the duplicate delay function at line 1920 that was causing
TypeScript compilation errors. The function is already defined at
line 15 and is used throughout the file for throttled fetch operations.
```

## Documentation Requirements

**Must Update:**
- None required for this bug fix

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Build passes with no TypeScript errors
- [ ] Only one `delay` function remains in the file
- [ ] Changeset created
- [ ] Fix committed with proper message including task ID

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-235): complete Step N — description`
- **Bug fixes:** `fix(KB-235): description`
- **Tests:** `test(KB-235): description`

## Do NOT

- Expand task scope beyond fixing the duplicate function
- Skip the test suite
- Modify other functions or refactor code
- Commit without the task ID prefix
- Change the `delay` function implementation (only remove the duplicate)
