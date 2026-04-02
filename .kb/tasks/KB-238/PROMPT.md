# Task: KB-238 - On the usage drop down get rid of the Using

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** Simple text change in pace message generation. Removes "Using" prefix from pace indicator messages in the usage dropdown. No architectural changes, minimal blast radius.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Remove the "Using" text prefix from the pace indicator messages in the usage dropdown. Currently the messages display as "Using X% over pace" and "Using X% under pace" — they should simply read "X% over pace" and "X% under pace". This makes the UI cleaner and more concise.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/usage.ts` — Contains `calculatePace()` function that generates the pace messages with "Using" prefix
- `packages/dashboard/app/components/UsageIndicator.test.tsx` — Contains tests that verify the pace message text

## File Scope

- `packages/dashboard/src/usage.ts`
- `packages/dashboard/app/components/UsageIndicator.test.tsx`

## Steps

### Step 0: Preflight

- [ ] Required files exist and are readable
- [ ] No dependencies blocking this task

### Step 1: Update Pace Message Generation

- [ ] Modify `calculatePace()` function in `packages/dashboard/src/usage.ts`
- [ ] Remove "Using " prefix from ahead pace message (line ~70)
- [ ] Remove "Using " prefix from behind pace message (line ~75)
- [ ] Keep "On pace with time elapsed" message unchanged (already doesn't have "Using")

**Before:**
```typescript
message: `Using ${Math.abs(Math.round(paceDelta))}% over pace`,
message: `Using ${Math.abs(Math.round(paceDelta))}% under pace`,
```

**After:**
```typescript
message: `${Math.abs(Math.round(paceDelta))}% over pace`,
message: `${Math.abs(Math.round(paceDelta))}% under pace`,
```

**Artifacts:**
- `packages/dashboard/src/usage.ts` (modified)

### Step 2: Update Tests

- [ ] Update test expectations in `packages/dashboard/app/components/UsageIndicator.test.tsx`
- [ ] Find all tests checking for "Using X% over pace" pattern and remove "Using "
- [ ] Find all tests checking for "Using X% under pace" pattern and remove "Using "
- [ ] Run tests to verify they pass with new message format

**Test updates needed (approximate):**
- Line ~450: `expect(paceRow).toHaveTextContent(/over pace/)` - may need adjustment
- Line ~476: Check for "Using 20% over pace" → "20% over pace"
- Line ~502: Check for "Using 30% under pace" → "30% under pace"
- Line ~574: Check for "Using 20% over pace" → "20% over pace"

**Artifacts:**
- `packages/dashboard/app/components/UsageIndicator.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in `packages/dashboard` directory
- [ ] Verify all usage-related tests pass
- [ ] Verify no regressions in other dashboard tests
- [ ] Build passes with `pnpm build`

### Step 4: Documentation & Delivery

- [ ] No documentation updates needed (UI text change only)
- [ ] Create changeset for the patch release

**Changeset:**
```bash
cat > .changeset/remove-using-from-pace-messages.md << 'EOF'
---
"@dustinbyrne/kb": patch
---

Remove "Using" prefix from pace indicator messages in usage dropdown for cleaner UI.
EOF
```

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Pace messages display without "Using" prefix (e.g., "20% over pace" instead of "Using 20% over pace")

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-238): complete Step N — description`
- **Bug fixes:** `fix(KB-238): description`
- **Tests:** `test(KB-238): description`

## Do NOT

- Change the "On pace with time elapsed" message
- Modify any other UI text or styling
- Add new features or functionality
- Skip running tests
