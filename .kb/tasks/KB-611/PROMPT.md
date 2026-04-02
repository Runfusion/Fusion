# Task: KB-611 - Serialize tasks with overlapping files should default on

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** Simple default value change from false to true. Single-line code change with cascading test updates. No risk of breaking existing functionality.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Change the default value of the `groupOverlappingFiles` setting from `false` to `true`. This setting controls whether the scheduler prevents tasks with overlapping file scopes from running concurrently. When enabled, tasks that touch the same files are serialized (run sequentially) to avoid merge conflicts. The UI label for this setting is "Serialize tasks with overlapping files". Making this the default improves out-of-the-box safety by preventing file-level conflicts between concurrent tasks.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — Contains `DEFAULT_PROJECT_SETTINGS` where `groupOverlappingFiles: false` is defined (around line 671)
- `packages/dashboard/app/components/SettingsModal.tsx` — Contains the form state initialization with default values (around line 75)

## File Scope

- `packages/core/src/types.ts` — Change `groupOverlappingFiles: false` to `groupOverlappingFiles: true` in `DEFAULT_PROJECT_SETTINGS`
- `packages/dashboard/app/components/SettingsModal.tsx` — Update form state default from `false` to `true`

## Steps

### Step 1: Update Default Settings in Types

- [ ] Change `groupOverlappingFiles: false` to `groupOverlappingFiles: true` in `DEFAULT_PROJECT_SETTINGS` in `packages/core/src/types.ts`
- [ ] Run `pnpm build` to verify TypeScript compiles

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Update Dashboard Form Default

- [ ] Change the default form state in `SettingsModal.tsx` from `groupOverlappingFiles: false` to `groupOverlappingFiles: true`
- [ ] Verify the checkbox renders checked by default in the settings modal

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` to execute the full test suite
- [ ] Fix any test failures caused by the default value change
- [ ] Update any hardcoded test expectations that assume `groupOverlappingFiles: false` as the default
- [ ] Build passes (`pnpm build`)

### Step 4: Documentation & Delivery

- [ ] Create changeset file for this change (patch bump — behavior change for new projects)
- [ ] Verify no documentation updates needed (setting is self-documenting in UI)

**Changeset:**
```bash
cat > .changeset/serialize-overlapping-default-on.md << 'EOF'
---
"@dustinbyrne/kb": patch
---

Change default value of `groupOverlappingFiles` setting to `true`. New projects will now serialize tasks with overlapping file scopes by default, preventing concurrent modification conflicts.
EOF
```

## Documentation Requirements

**Must Update:**
- None — the setting is documented in the UI label "Serialize tasks with overlapping files"

**Check If Affected:**
- `AGENTS.md` — Check if this setting is mentioned in any agent guidelines

## Completion Criteria

- [ ] `groupOverlappingFiles` defaults to `true` in `DEFAULT_PROJECT_SETTINGS`
- [ ] Dashboard settings modal shows the checkbox checked by default
- [ ] All tests passing
- [ ] Build passes
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-611): complete Step N — description`
- **Bug fixes:** `fix(KB-611): description`
- **Tests:** `test(KB-611): description`

## Do NOT

- Modify the setting name or UI label
- Change the behavior logic in scheduler.ts — only change the default
- Remove the ability to disable the feature (keep the checkbox)
- Skip tests or leave failing tests
