# Task: KB-331 - Rename Published Package from @dustinbyrne/kb to @gsxdsm/fusion

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is a mechanical refactor with medium blast radius. The change pattern is simple (search/replace package name), but affects 156+ changeset files, package metadata, documentation, and root workspace scripts. Full test suite must pass as quality gate.
**Score:** 4/8 — Blast radius: 2, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Rename the published npm package from `@dustinbyrne/kb` to `@gsxdsm/fusion`. This is the user-facing package that developers install globally with `npm i -g @gsxdsm/fusion`. The CLI binary name remains `fn` (already renamed). Update all package metadata, workspace references, changeset files, and documentation that reference the old package name.

## Dependencies

- **Task:** KB-330 (Rename internal packages from @kb/* to @fusion/*) — must be complete so internal package imports are already using @fusion/* namespace

## Context to Read First

Read these files to understand current package structure and references:

1. `packages/cli/package.json` — Current `@dustinbyrne/kb` package definition
2. `package.json` (root) — Workspace scripts that filter by package name
3. `RELEASING.md` — Release documentation with package name references
4. `README.md` — Installation instructions and package references

Optional context (to understand scope):
```bash
# Count changeset files that need updating
grep -l "@dustinbyrne/kb" /Users/eclipxe/Projects/kb/.changeset/*.md | wc -l

# Find all non-changeset references
grep -r "@dustinbyrne/kb" /Users/eclipxe/Projects/kb --include="*.json" --include="*.ts" --include="*.tsx" --include="*.md" --include="*.yaml" 2>/dev/null | grep -v node_modules | grep -v ".worktrees" | grep -v ".changeset"
```

## File Scope

**Package metadata (must update):**
- `packages/cli/package.json` — name field, repository.url
- `package.json` (root) — scripts with `--filter @dustinbyrne/kb`
- `packages/cli/README.md` — link to repository

**Documentation (must update):**
- `README.md` — installation command `npm i -g @dustinbyrne/kb`
- `RELEASING.md` — filter references in script examples

**Changeset files (bulk update):**
- `.changeset/*.md` — All files containing `"@dustinbyrne/kb":` frontmatter (156+ files)

**Test files (check and update if needed):**
- `packages/cli/src/__tests__/package-config.test.ts` — may reference package name
- Any test files that assert on package metadata

**Excluded from changes:**
- `.worktrees/` directories (ephemeral)
- `node_modules/` directories
- `dist/` directories (rebuilt)
- Historical task data in `.fusion/tasks/` (preserved as-is)

## Steps

### Step 1: Update Package Metadata

Update the published package's metadata to use the new name.

- [ ] `packages/cli/package.json`: Change `"name": "@dustinbyrne/kb"` to `"name": "@gsxdsm/fusion"`
- [ ] `packages/cli/package.json`: Update repository URL from `https://github.com/dustinbyrne/kb` to `https://github.com/gsxdsm/fusion` (if this is a repo move; if keeping same repo, skip this sub-item)
- [ ] `packages/cli/README.md`: Update repository link from `https://github.com/dustinbyrne/kb#readme` to `https://github.com/gsxdsm/fusion#readme`

**Artifacts:**
- `packages/cli/package.json` (modified)
- `packages/cli/README.md` (modified)

### Step 2: Update Root Workspace Scripts

Update root package.json scripts that reference the old package name.

- [ ] `package.json`: Change `pnpm --filter @dustinbyrne/kb build:exe` to `pnpm --filter @gsxdsm/fusion build:exe`
- [ ] `package.json`: Change `pnpm --filter @dustinbyrne/kb build:exe:all` to `pnpm --filter @gsxdsm/fusion build:exe:all`

**Artifacts:**
- `package.json` (modified)

### Step 3: Update Documentation

Update user-facing documentation with the new package name.

- [ ] `README.md`: Change `npm i -g @dustinbyrne/kb` to `npm i -g @gsxdsm/fusion`
- [ ] `README.md`: Update any other package name references (check for "@dustinbyrne/kb" in the file)
- [ ] `RELEASING.md`: Change all `pnpm --filter @dustinbyrne/kb` to `pnpm --filter @gsxdsm/fusion` (3 occurrences in script examples)

**Artifacts:**
- `README.md` (modified)
- `RELEASING.md` (modified)

### Step 4: Update All Changeset Files

Bulk update all changeset files to use the new package name in their frontmatter.

- [ ] Find all `.changeset/*.md` files containing `@dustinbyrne/kb`
- [ ] Replace `"@dustinbyrne/kb":` with `"@gsxdsm/fusion":` in each file

**Verification command:**
```bash
# Should return 0 after updates
grep -r '"@dustinbyrne/kb":' /Users/eclipxe/Projects/kb/.changeset/*.md 2>/dev/null | wc -l
```

**Artifacts:**
- All updated `.changeset/*.md` files (modified)

### Step 5: Update Test Files (If Needed)

Check and update any test files that reference the package name.

- [ ] Check `packages/cli/src/__tests__/package-config.test.ts` for `@dustinbyrne/kb` references
- [ ] Check `packages/cli/src/__tests__/extension.test.ts` for any package name assertions
- [ ] Update any hardcoded package name strings in tests

**Artifacts:**
- Any modified test files

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm install` to update lockfile with new package name
- [ ] Run `pnpm build` to verify all packages compile successfully
- [ ] Run `pnpm test` to verify all tests pass
- [ ] Verify no `@dustinbyrne/kb` references remain (excluding historical task data and archived files):
  ```bash
  grep -r "@dustinbyrne/kb" /Users/eclipxe/Projects/kb --include="*.json" --include="*.ts" --include="*.tsx" --include="*.md" --include="*.yaml" 2>/dev/null | grep -v node_modules | grep -v ".worktrees" | grep -v ".fusion/tasks/" | wc -l
  # Expected result: 0
  ```

**Common issues to watch for:**
- Test files that mock or assert on package name
- Any dynamic package name resolution
- Changeset frontmatter syntax errors after replacement

**Artifacts:**
- `pnpm-lock.yaml` (auto-updated)
- All builds pass
- All tests pass

### Step 7: Documentation & Delivery

- [ ] Create changeset for this rename:
```bash
cat > .changeset/rename-published-package.md << 'EOF'
---
"@gsxdsm/fusion": minor
---

Rename published package from @dustinbyrne/kb to @gsxdsm/fusion
EOF
```
- [ ] Verify the changeset uses the NEW package name (`@gsxdsm/fusion`)
- [ ] Document any out-of-scope findings: If you discover references that should be handled by other tasks (KB-332 through KB-335), do NOT modify them — document them in the task log

**Artifacts:**
- `.changeset/rename-published-package.md` (new)

## Completion Criteria

- [ ] `packages/cli/package.json` updated with new name `@gsxdsm/fusion`
- [ ] Root `package.json` scripts updated to use `--filter @gsxdsm/fusion`
- [ ] `README.md` installation instructions updated
- [ ] `RELEASING.md` script examples updated
- [ ] All 156+ `.changeset/*.md` files updated
- [ ] Test files updated (if any had hardcoded references)
- [ ] `pnpm install` completes successfully
- [ ] `pnpm build` passes for all packages
- [ ] `pnpm test` passes with zero failures
- [ ] Changeset file created for the rename
- [ ] Zero remaining `@dustinbyrne/kb` references in active codebase (excluding historical `.fusion/tasks/` data)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step 1:** `feat(KB-331): rename package metadata to @gsxdsm/fusion`
- **Step 2:** `feat(KB-331): update root workspace scripts`
- **Step 3:** `docs(KB-331): update README and RELEASING with new package name`
- **Step 4:** `chore(KB-331): update changeset files to @gsxdsm/fusion`
- **Step 5:** `test(KB-331): update test file references`
- **Step 6:** `test(KB-331): verify build and tests pass`
- **Step 7:** `chore(KB-331): add changeset for package rename`

## Do NOT

- Change the CLI binary name — it remains `fn` (already correct)
- Rename the data directory from `.fusion` to `.fusion` (handled in KB-334)
- Rename task ID prefixes from KB-XXX (handled in KB-332)
- Rename environment variables from KB_* (handled in KB-333)
- Modify files in `.worktrees/` directories (ephemeral)
- Modify historical task data in `.fusion/tasks/` (preserve as-is)
- Skip running the full test suite
- Commit lockfile or changeset without the task ID prefix
- Update repository URL unless confirmed the repo is actually moving to gsxdsm organization
