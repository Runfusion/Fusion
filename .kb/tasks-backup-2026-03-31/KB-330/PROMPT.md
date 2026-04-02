# Task: KB-330 - Rename internal packages from @kb/* to @fusion/*

**Created:** 2026-03-31
**Size:** L

## Review Level: 2 (Plan and Code)

**Assessment:** This is a large-scale mechanical refactor affecting all internal packages. While the pattern is straightforward (search/replace), the blast radius is high (183+ imports across 4 packages). Full test suite must pass as the quality gate.
**Score:** 5/8 — Blast radius: 2, Pattern novelty: 0, Security: 1, Reversibility: 2

## Mission

Rename all internal workspace packages from the `@kb/*` namespace to `@fusion/*` to align with the new project branding. This includes:
- `@kb/core` → `@fusion/core`
- `@kb/dashboard` → `@fusion/dashboard`
- `@kb/engine` → `@fusion/engine`

Update all `package.json` name fields, workspace dependencies, and import statements across the codebase. After the rename, the entire project must build and all tests must pass.

## Dependencies

- **None** — This is the foundational rename task that other rename tasks (KB-331 through KB-335) depend on.

## Context to Read First

Read these files to understand the current package structure and import patterns:

1. `packages/core/package.json` — Current `@kb/core` definition
2. `packages/dashboard/package.json` — Current `@kb/dashboard` definition with deps on `@kb/core` and `@kb/engine`
3. `packages/engine/package.json` — Current `@kb/engine` definition with dep on `@kb/core`
4. `packages/cli/package.json` — Current `@dustinbyrne/kb` with devDependencies on all three internal packages
5. `pnpm-workspace.yaml` — Workspace configuration (packages/* pattern)

Run this command to see all import patterns (optional context gathering):
```bash
grep -r "from ['\"]@kb/core['\"]\|from ['\"]@kb/dashboard['\"]\|from ['\"]@kb/engine['\"]" --include="*.ts" --include="*.tsx" --include="*.mts" packages/
```

## File Scope

**Package.json files to modify (name field and dependencies):**
- `packages/core/package.json`
- `packages/dashboard/package.json`
- `packages/engine/package.json`
- `packages/cli/package.json`

**Source files with imports to update (~183 occurrences):**
- `packages/cli/src/**/*.ts` — Extension and command sources
- `packages/cli/src/**/*.test.ts` — CLI tests
- `packages/dashboard/app/**/*.ts` — Dashboard client sources
- `packages/dashboard/app/**/*.tsx` — Dashboard React components
- `packages/dashboard/src/**/*.ts` — Dashboard server sources
- `packages/engine/src/**/*.ts` — Engine sources
- `packages/engine/src/**/*.test.ts` — Engine tests

**Excluded from changes:**
- `.worktrees/` directories (these are ephemeral build worktrees)
- `node_modules/` directories
- `dist/` directories (will be rebuilt)
- `@dustinbyrne/kb` package name (handled in KB-331)

## Steps

### Step 1: Update Package Names in package.json Files

Update the `name` field in each internal package's package.json:

- [ ] `packages/core/package.json`: Change `"name": "@kb/core"` to `"name": "@fusion/core"`
- [ ] `packages/dashboard/package.json`: Change `"name": "@kb/dashboard"` to `"name": "@fusion/dashboard"`
- [ ] `packages/engine/package.json`: Change `"name": "@kb/engine"` to `"name": "@fusion/engine"`

**Artifacts:**
- `packages/core/package.json` (modified)
- `packages/dashboard/package.json` (modified)
- `packages/engine/package.json` (modified)

### Step 2: Update Workspace Dependencies in package.json Files

Update all `workspace:*` dependencies that reference the old package names:

- [ ] `packages/dashboard/package.json`: Update `dependencies`:
  - `"@kb/core": "workspace:*"` → `"@fusion/core": "workspace:*"`
  - `"@kb/engine": "workspace:*"` → `"@fusion/engine": "workspace:*"`

- [ ] `packages/engine/package.json`: Update `dependencies`:
  - `"@kb/core": "workspace:*"` → `"@fusion/core": "workspace:*"`

- [ ] `packages/cli/package.json`: Update `devDependencies`:
  - `"@kb/core": "workspace:*"` → `"@fusion/core": "workspace:*"`
  - `"@kb/dashboard": "workspace:*"` → `"@fusion/dashboard": "workspace:*"`
  - `"@kb/engine": "workspace:*"` → `"@fusion/engine": "workspace:*"`

**Artifacts:**
- `packages/dashboard/package.json` (modified)
- `packages/engine/package.json` (modified)
- `packages/cli/package.json` (modified)

### Step 3: Update All Import Statements in Source Files

Use find-and-replace across all TypeScript source files to update import paths:

- [ ] Replace all `from "@kb/core"` with `from "@fusion/core"`
- [ ] Replace all `from "@kb/dashboard"` with `from "@fusion/dashboard"`
- [ ] Replace all `from "@kb/engine"` with `from "@fusion/engine"`
- [ ] Replace all `from '@kb/core'` with `from '@fusion/core'` (single quotes)
- [ ] Replace all `from '@kb/dashboard'` with `from '@fusion/dashboard'` (single quotes)
- [ ] Replace all `from '@kb/engine'` with `from '@fusion/engine'` (single quotes)

Apply to these directories:
- `packages/cli/src/`
- `packages/dashboard/app/`
- `packages/dashboard/src/`
- `packages/engine/src/`

**Verification command to confirm all imports are updated:**
```bash
grep -r "from ['\"]@kb/core['\"]\|from ['\"]@kb/dashboard['\"]\|from ['\"]@kb/engine['\"]" --include="*.ts" --include="*.tsx" --include="*.mts" packages/ | grep -v "/dist/" | grep -v "node_modules" | wc -l
```
Expected result: 0

**Artifacts:**
- All source files with updated imports (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm install` to update lockfile with new package names
- [ ] Run `pnpm build` to verify all packages compile successfully
- [ ] Run `pnpm test` to verify all tests pass
- [ ] Fix any build or test failures

**Common issues to watch for:**
- TypeScript path resolution errors (should be automatic with pnpm workspace)
- Test files that mock or spy on module imports
- Any hardcoded package name strings in tests

**Artifacts:**
- `pnpm-lock.yaml` (auto-updated by pnpm install)
- All builds pass
- All tests pass

### Step 5: Documentation & Delivery

- [ ] Verify no references to `@kb/core`, `@kb/dashboard`, or `@kb/engine` remain in source files (excluding historical documentation like AGENTS.md unless explicitly requested)
- [ ] Create changeset for this patch-level change:
```bash
cat > .changeset/rename-internal-packages.md << 'EOF'
---
"@dustinbyrne/kb": patch
"@fusion/core": patch
"@fusion/dashboard": patch
"@fusion/engine": patch
---

Rename internal packages from @kb/* to @fusion/* namespace
EOF
```
- [ ] Out-of-scope findings: If you discover any remaining `@kb/*` references that should be handled by other tasks (KB-331 through KB-335), do NOT modify them — document them in the task log instead.

**Artifacts:**
- `.changeset/rename-internal-packages.md` (new)

## Completion Criteria

- [ ] All 4 package.json files updated with new package names
- [ ] All workspace dependencies updated to use new names
- [ ] All 183+ import statements updated across all source files
- [ ] `pnpm install` completes successfully with updated lockfile
- [ ] `pnpm build` passes for all packages
- [ ] `pnpm test` passes with zero failures
- [ ] Changeset file created for the change

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step 1:** `feat(KB-330): rename package names in package.json files`
- **Step 2:** `feat(KB-330): update workspace dependencies to @fusion/*`
- **Step 3:** `feat(KB-330): update all import statements to @fusion/*`
- **Step 4:** `test(KB-330): verify build and tests pass`
- **Step 5:** `chore(KB-330): add changeset for package rename`

## Do NOT

- Change the `@dustinbyrne/kb` package name (handled in KB-331)
- Rename the data directory from `.fusion` to `.fusion` (handled in KB-334)
- Rename task ID prefixes from KB-XXX (handled in KB-332)
- Rename environment variables from KB_* (handled in KB-333)
- Update documentation references unless they specifically mention the package names being changed
- Modify files in `.worktrees/` directories (these are ephemeral)
- Skip running the full test suite
- Commit lockfile or changeset without the task ID prefix
