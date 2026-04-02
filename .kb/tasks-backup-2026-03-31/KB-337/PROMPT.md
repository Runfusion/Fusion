# Task: KB-337 - Update Documentation and Remaining References After Rename

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is a documentation and coordination task with moderate blast radius. It touches multiple documentation files and requires coordination with KB-335 (env var rename). The pattern is straightforward (search/replace in docs) but must be done systematically to ensure consistency.
**Score:** 4/8 — Blast radius: 2, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

After all major rename tasks complete (KB-330 through KB-334), execute the final documentation and reference cleanup. This task:

1. **Executes KB-335** — Rename environment variables from `KB_*` to `FUSION_*`
2. **Updates remaining documentation** — Catch any references missed by the individual rename tasks, including:
   - Package name references in AGENTS.md
   - Task ID format references (KB-XXX → FN-XXX)
   - Branch naming references (kb/ → fusion/)
   - Data directory references (.fusion/ → .fusion/)
   - Commit message conventions
   - High-level project documentation

This is the final cleanup task that ensures all documentation is consistent with the new "Fusion" branding after the mechanical renames are complete.

## Dependencies

- **Task:** KB-330 (Rename internal packages from @kb/* to @fusion/*) — must be complete
- **Task:** KB-331 (Add respecify button) — must be complete
- **Task:** KB-332 (Execute subtask KB-330) — must be complete
- **Task:** KB-333 (Rename published package from @dustinbyrne/kb to @dustinbyrne/fusion) — must be complete
- **Task:** KB-334 (Rename task ID prefix and branch naming from KB-XXX/kb/ to FN-XXX/fusion/) — must be complete

## Context to Read First

Read these files to understand the current state of the codebase and what references need updating:

1. `/Users/eclipxe/Projects/kb/README.md` — Main project documentation with package references, CLI commands, and usage examples
2. `/Users/eclipxe/Projects/kb/AGENTS.md` — Project guidelines with commit conventions and package structure
3. `/Users/eclipxe/Projects/kb/RELEASING.md` — Release documentation with package name references
4. `/Users/eclipxe/Projects/kb/packages/cli/README.md` — CLI package documentation
5. `/Users/eclipxe/Projects/kb/packages/dashboard/README.md` — Dashboard package documentation
6. `/Users/eclipxe/Projects/kb/packages/cli/STANDALONE.md` — Standalone CLI documentation with env vars

Also read the KB-335 PROMPT.md to understand what env var rename work needs to be executed:
- `/Users/eclipxe/Projects/kb/.fusion/tasks/KB-335/PROMPT.md`

## File Scope

**Documentation files to update (remaining references):**
- `README.md` — Package references, task ID examples, branch naming, data directory
- `AGENTS.md` — Package structure section, commit conventions, database location, Git references
- `RELEASING.md` — Package filter references, binary names
- `packages/cli/README.md` — Package name references
- `packages/dashboard/README.md` — Package header, env var references
- `packages/cli/STANDALONE.md` — Env var references (KB_335 handles this, but verify)

**KB-335 execution scope (read the KB-335 PROMPT.md for full details):**
- `packages/dashboard/src/github-webhooks.ts`
- `packages/dashboard/src/badge-pubsub.ts`
- `packages/dashboard/src/server.ts`
- `packages/dashboard/src/routes.ts`
- `packages/dashboard/src/terminal-service.ts`
- `packages/cli/src/runtime/native-patch.ts`
- Test files: `github-webhooks.test.ts`, `badge-pubsub.test.ts`
- Documentation: `README.md`, `STANDALONE.md`, `packages/dashboard/README.md`

## Steps

### Step 1: Execute KB-335 — Rename Environment Variables

KB-335 is a prerequisite task that must be completed as part of this work. Execute all steps from the KB-335 PROMPT.md:

- [ ] Read `/Users/eclipxe/Projects/kb/.fusion/tasks/KB-335/PROMPT.md` completely
- [ ] Execute Step 1: Update dashboard source files with FUSION_* env vars
- [ ] Execute Step 2: Update CLI runtime files with FUSION_* env vars
- [ ] Execute Step 3: Update test files with FUSION_* env vars
- [ ] Execute Step 4: Update documentation files with FUSION_* env vars
- [ ] Execute Step 5: Update any changeset files referencing KB_* env vars
- [ ] Execute Step 6: Verify build and tests pass
- [ ] Execute Step 7: Create changeset for env var rename

**KB-335 Environment Variable Mapping (for reference):**
| Old Name | New Name |
|----------|----------|
| `KB_GITHUB_APP_ID` | `FUSION_GITHUB_APP_ID` |
| `KB_GITHUB_APP_PRIVATE_KEY` | `FUSION_GITHUB_APP_PRIVATE_KEY` |
| `KB_GITHUB_APP_PRIVATE_KEY_PATH` | `FUSION_GITHUB_APP_PRIVATE_KEY_PATH` |
| `KB_GITHUB_WEBHOOK_SECRET` | `FUSION_GITHUB_WEBHOOK_SECRET` |
| `KB_BADGE_PUBSUB_REDIS_URL` | `FUSION_BADGE_PUBSUB_REDIS_URL` |
| `KB_BADGE_PUBSUB_CHANNEL` | `FUSION_BADGE_PUBSUB_CHANNEL` |
| `KB_DEBUG_PLANNING_ROUTES` | `FUSION_DEBUG_PLANNING_ROUTES` |
| `KB_RUNTIME_DIR` | `FUSION_RUNTIME_DIR` |
| `KB_NATIVE_ASSETS_PATH` | `FUSION_NATIVE_ASSETS_PATH` |
| `KB_FAKE_BUNFS_ROOT` | `FUSION_FAKE_BUNFS_ROOT` |
| `KB_CLIENT_DIR` | `FUSION_CLIENT_DIR` |

**Also update:** Default pub/sub channel from `kb:badge-updates` to `fusion:badge-updates`

**Artifacts:**
- All files from KB-335 scope (modified)
- `.changeset/rename-environment-variables.md` (created by KB-335 step 7)

### Step 2: Update AGENTS.md — Package Structure and Conventions

Update AGENTS.md to reflect the new package names and conventions:

- [ ] Update **Package Structure** section: Change `@kb/core`, `@kb/dashboard`, `@kb/engine` to `@fusion/core`, `@fusion/dashboard`, `@fusion/engine`
- [ ] Update **SQLite Storage Architecture** section: Change references to `.fusion/fusion.db` to `.fusion/fusion.db` (if data directory rename is complete)
- [ ] Update **Dashboard badge WebSockets** section: Change `KB_GITHUB_WEBHOOK_SECRET` to `FUSION_GITHUB_WEBHOOK_SECRET`
- [ ] Update **Git** section: Change commit message convention from `feat(KB-XXX):` to `feat(FN-XXX):`
- [ ] Update **Settings** section: Change data directory references from `.fusion/` to `.fusion/` and `~/.pi/kb/settings.json` to `~/.pi/fusion/settings.json` (where appropriate)
- [ ] Search for any remaining `@kb/` package references and update to `@fusion/`
- [ ] Search for any remaining `KB-XXX` task ID examples and update to `FN-XXX`

**Verification:**
```bash
grep -n "@kb/core\|@kb/dashboard\|@kb/engine" /Users/eclipxe/Projects/kb/AGENTS.md
grep -n "feat(KB-\|fix(KB-\|test(KB-" /Users/eclipxe/Projects/kb/AGENTS.md
grep -n "process\.env\.KB_" /Users/eclipxe/Projects/kb/AGENTS.md
```
Expected: 0 matches after updates

**Artifacts:**
- `AGENTS.md` (modified)

### Step 3: Update README.md — High-Level Documentation

Update the main README.md with consistent new branding:

- [ ] Update **Packages** table: Change `@kb/core`, `@kb/dashboard`, `@kb/engine` to `@fusion/core`, `@fusion/dashboard`, `@fusion/engine`
- [ ] Update **Task Storage** section: Change `.fusion/tasks/` example to `.fusion/tasks/` (if data directory rename complete), update `KB-001` example to `FN-001`
- [ ] Update CLI command examples: `fn task show KB-001` → `fn task show FN-001`, etc.
- [ ] Update **GitHub Import** examples: `fn task create "Bug" --depends KB-001` → `--depends FN-001`
- [ ] Update **Configuration Reference**: Change `~/.pi/kb/settings.json` to `~/.pi/fusion/settings.json` for global settings path
- [ ] Update **PR-first mode prerequisites**: Change branch naming from `kb/<task-id-lower>` to `fusion/<task-id-lower>`
- [ ] Search for any remaining `@dustinbyrne/kb` and update to `@dustinbyrne/fusion`
- [ ] Search for any remaining `KB_` env var references and update to `FUSION_`

**Verification:**
```bash
grep -n "@kb/core\|@kb/dashboard\|@kb/engine" /Users/eclipxe/Projects/kb/README.md
grep -n "@dustinbyrne/kb" /Users/eclipxe/Projects/kb/README.md | grep -v "installation"
grep -n "KB_[A-Z_]*" /Users/eclipxe/Projects/kb/README.md
grep -n "kb/<task-id" /Users/eclipxe/Projects/kb/README.md
```
Expected: 0 matches (except possibly historical installation instructions if preserving)

**Artifacts:**
- `README.md` (modified)

### Step 4: Update RELEASING.md — Package References

Update release documentation:

- [ ] Update package filter references from `@dustinbyrne/kb` to `@dustinbyrne/fusion`
- [ ] Update binary names in platform table if they changed (kb-linux-x64 → fusion-linux-x64, etc.)
- [ ] Update any CLI command examples that reference old package names

**Verification:**
```bash
grep -n "@dustinbyrne/kb" /Users/eclipxe/Projects/kb/RELEASING.md
grep -n "kb-linux\|kb-darwin\|kb-windows" /Users/eclipxe/Projects/kb/RELEASING.md
```

**Artifacts:**
- `RELEASING.md` (modified)

### Step 5: Update Package README Files

Update individual package README files:

- [ ] `packages/cli/README.md`: Update package name from `@dustinbyrne/kb` to `@dustinbyrne/fusion`, update references to `kb/<task-id-lower>` to `fusion/<task-id-lower>`
- [ ] `packages/dashboard/README.md`: Update package header from `@kb/dashboard` to `@fusion/dashboard`, update all `KB_*` env vars to `FUSION_*`, update `kb:badge-updates` to `fusion:badge-updates`
- [ ] Verify `packages/cli/STANDALONE.md` was updated by KB-335 execution (if not, update env vars)

**Verification:**
```bash
grep -n "@kb/dashboard" /Users/eclipxe/Projects/kb/packages/dashboard/README.md
grep -n "KB_" /Users/eclipxe/Projects/kb/packages/dashboard/README.md
grep -n "@dustinbyrne/kb" /Users/eclipxe/Projects/kb/packages/cli/README.md
```

**Artifacts:**
- `packages/cli/README.md` (modified)
- `packages/dashboard/README.md` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm install` to ensure dependencies are current
- [ ] Run `pnpm build` to verify all packages compile successfully
- [ ] Run `pnpm test` to verify all tests pass
- [ ] Verify no remaining old references in source files:
  ```bash
  # Check for old package names in source
  grep -rn "@kb/core\|@kb/dashboard\|@kb/engine" /Users/eclipxe/Projects/kb/packages --include="*.ts" --include="*.tsx" --include="*.json" 2>/dev/null | grep -v node_modules | grep -v ".worktrees" | grep -v "/dist/" | wc -l
  # Expected: 0
  
  # Check for old env vars in source
  grep -rn "process\.env\.KB_" /Users/eclipxe/Projects/kb/packages --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v node_modules | grep -v ".worktrees" | wc -l
  # Expected: 0
  
  # Check for old env vars in documentation
  grep -rn "KB_" /Users/eclipxe/Projects/kb/*.md /Users/eclipxe/Projects/kb/packages/**/*.md 2>/dev/null | grep -v ".changeset" | wc -l
  # Expected: 0 (or only historical references preserved intentionally)
  ```

**Artifacts:**
- All builds pass
- All tests pass

### Step 7: Documentation & Delivery

- [ ] Create changeset for this documentation update:
```bash
cat > .changeset/update-documentation-references.md << 'EOF'
---
"@dustinbyrne/fusion": patch
"@fusion/core": patch
"@fusion/dashboard": patch
"@fusion/engine": patch
---

Update documentation and remaining references for Fusion rebrand

- Updated AGENTS.md with new package names and commit conventions
- Updated README.md with FN-XXX task ID format and fusion/ branch naming
- Updated RELEASING.md with new package filters
- Updated package README files with consistent branding
- Completed KB-335 environment variable rename (KB_* → FUSION_*)
EOF
```
- [ ] Document any out-of-scope findings: If you discover references that should be preserved (e.g., historical changelog entries), document them in the task log
- [ ] Move KB-335 to "done" column since it was executed as part of this task

**Artifacts:**
- `.changeset/update-documentation-references.md` (new)

## Completion Criteria

- [ ] KB-335 fully executed (all 7 steps complete)
- [ ] All environment variables renamed from `KB_*` to `FUSION_*`
- [ ] AGENTS.md updated with new package names (`@fusion/*`) and commit conventions (`feat(FN-XXX)`)
- [ ] README.md updated with new task ID format (`FN-XXX`) and branch naming (`fusion/`)
- [ ] RELEASING.md updated with new package filters
- [ ] Package README files updated with consistent branding
- [ ] Default pub/sub channel updated to `fusion:badge-updates`
- [ ] `pnpm build` passes for all packages
- [ ] `pnpm test` passes with zero failures
- [ ] Changeset file created for the documentation update
- [ ] KB-335 moved to "done" column

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step 1:** `feat(KB-337): execute KB-335 — rename environment variables KB_* to FUSION_*`
- **Step 2:** `docs(KB-337): update AGENTS.md with new package names and conventions`
- **Step 3:** `docs(KB-337): update README.md with FN-XXX format and fusion/ branch naming`
- **Step 4:** `docs(KB-337): update RELEASING.md with new package filters`
- **Step 5:** `docs(KB-337): update package README files with consistent branding`
- **Step 6:** `test(KB-337): verify build and tests pass`
- **Step 7:** `chore(KB-337): add changeset for documentation update`

## Do NOT

- Skip executing KB-335 — it is a required part of this task
- Rename the `.fusion/` data directory (handled in KB-336)
- Rename existing task IDs in `.fusion/tasks/` (KB-XXX tasks remain as-is)
- Modify historical changelog entries in `packages/cli/CHANGELOG.md` (preserve history)
- Rename existing Git branches (only new branches use fusion/ prefix)
- Skip running the full test suite
- Commit lockfile or changeset without the task ID prefix
- Update references in `.changeset/*.md` files (they are historical records)
