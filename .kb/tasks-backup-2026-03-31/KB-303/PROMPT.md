# Task: KB-303 - Global settings should be stored in the user home directory under .fusion

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Simple path change with well-defined blast radius. Only affects `GlobalSettingsStore` default directory and documentation strings.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Change the default global settings storage location from `~/.pi/kb/settings.json` to `~/.fusion/settings.json`. This aligns the storage path with the product's new branding as "Fusion". The change must update the default directory function, all documentation references, and corresponding test expectations.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/global-settings.ts` — Contains the `defaultGlobalDir()` function that returns `~/.pi/kb/`
- `packages/core/src/types.ts` — Contains JSDoc comments referencing `~/.pi/kb/settings.json`
- `packages/core/src/store.ts` — Contains JSDoc comments on `globalSettingsStore` field and methods
- `packages/dashboard/src/routes.ts` — Contains API route documentation referencing `~/.pi/kb/settings.json`
- `packages/core/src/global-settings.test.ts` — Test file that may need path expectation updates
- `AGENTS.md` — Project guidelines file documenting the settings hierarchy (already provided in context)

## File Scope

- `packages/core/src/global-settings.ts` — Modify `defaultGlobalDir()` function
- `packages/core/src/types.ts` — Update JSDoc comments referencing `~/.pi/kb/settings.json`
- `packages/core/src/store.ts` — Update JSDoc comments referencing `~/.pi/kb/settings.json`
- `packages/dashboard/src/routes.ts` — Update JSDoc comments referencing `~/.pi/kb/settings.json`
- `packages/dashboard/src/routes.test.ts` — Update mock paths if any hardcoded expectations
- `packages/core/src/global-settings.test.ts` — Update if tests check for specific paths in comments

## Steps

### Step 1: Update Global Settings Directory Path

- [ ] Change `defaultGlobalDir()` in `packages/core/src/global-settings.ts` to return `join(homedir(), ".fusion")` instead of `join(homedir(), ".pi", "kb")`
- [ ] Update the JSDoc comment on `defaultGlobalDir()` to reference `~/.fusion/`
- [ ] Update the class-level JSDoc comment for `GlobalSettingsStore` to reference `~/.fusion/settings.json`
- [ ] Update constructor parameter documentation to reference `~/.fusion/`

### Step 2: Update Documentation References in Types

- [ ] Update the comment block in `types.ts` (around line 1) that describes the settings hierarchy — change `~/.pi/kb/settings.json` to `~/.fusion/settings.json`
- [ ] Update the `GlobalSettings` interface JSDoc to reference `~/.fusion/settings.json`
- [ ] Update any other JSDoc comments in `types.ts` referencing the old path

### Step 3: Update Documentation in Store

- [ ] Update the `globalSettingsStore` field JSDoc in `store.ts` to reference `~/.fusion/settings.json`
- [ ] Update the `getSettings()` method JSDoc that mentions `~/.pi/kb/settings.json`
- [ ] Update the `getSettingsByScope()` method JSDoc if it references the old path
- [ ] Update the `updateGlobalSettings()` method JSDoc to reference `~/.fusion/settings.json`

### Step 4: Update Dashboard Routes Documentation

- [ ] Update the JSDoc on the global settings GET endpoint to reference `~/.fusion/settings.json`
- [ ] Update the JSDoc on the global settings PUT endpoint to reference `~/.fusion/settings.json`

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` to ensure all existing tests pass
- [ ] Verify that `packages/core/src/global-settings.test.ts` tests still pass (they use mock directories, so they should be unaffected by the default path change)
- [ ] If any tests fail due to hardcoded path expectations, update them
- [ ] Run `pnpm build` to verify TypeScript compiles without errors

### Step 6: Documentation & Delivery

- [ ] Create a changeset file for the `@dustinbyrne/kb` package (this is a user-facing configuration change):
  ```bash
  cat > .changeset/move-global-settings-to-fusion.md << 'EOF'
  ---
  "@dustinbyrne/kb": patch
  ---

  Move global settings storage from `~/.pi/kb/settings.json` to `~/.fusion/settings.json` to align with the Fusion branding.
  EOF
  ```
- [ ] Verify the changeset file was created correctly

## Documentation Requirements

**Must Update:**
- JSDoc comments in all modified files to reference `~/.fusion/settings.json` instead of `~/.pi/kb/settings.json`

**Check If Affected:**
- `README.md` — Search for any references to `~/.pi/kb` and update if found
- `AGENTS.md` — Already mentions the settings hierarchy; verify it matches the new path

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] `pnpm build` succeeds
- [ ] Changeset file created
- [ ] No references to `~/.pi/kb` remain in the codebase (verify with `grep -r "\.pi/kb" packages --include="*.ts" --include="*.md"`)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-303): complete Step N — description`
- **Documentation fixes:** `docs(KB-303): description`
- **Tests:** `test(KB-303): description`

## Do NOT

- Modify the settings file format or schema (keep `settings.json` filename)
- Change any project-level settings paths (`.fusion/config.json` stays the same)
- Add migration logic for existing settings (the new location starts fresh)
- Modify the `GlobalSettingsStore` class API or behavior (only change the default directory)
- Touch any files outside the File Scope
