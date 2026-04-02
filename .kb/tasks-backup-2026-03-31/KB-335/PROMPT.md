# Task: KB-335 - Rename Environment Variables from KB_* to FUSION_*

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is a mechanical refactor with medium blast radius. The pattern is straightforward (search/replace environment variable names), but it affects 14 distinct environment variables across 12+ source files, test files, and documentation. Full test suite must pass as the quality gate.
**Score:** 4/8 — Blast radius: 2, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Rename all environment variables from the `KB_*` prefix to `FUSION_*` to align with the new project branding. This is a comprehensive rename affecting:

- GitHub App configuration variables
- Badge pub/sub Redis configuration
- Dashboard debug and asset path overrides
- Runtime native asset paths

After the rename, the entire project must build and all tests must pass.

## Dependencies

- **Task:** KB-330 (Rename internal packages from @kb/* to @fusion/*) — must be complete so the codebase is in a consistent state with updated package imports before environment variables are renamed.

## Context to Read First

Read these files to understand the current environment variable usage patterns:

1. `packages/dashboard/src/github-webhooks.ts` — GitHub App env vars
2. `packages/dashboard/src/badge-pubsub.ts` — Redis pub/sub env vars
3. `packages/dashboard/src/server.ts` — Debug and client directory env vars
4. `packages/dashboard/src/terminal-service.ts` — Runtime directory env vars
5. `packages/cli/src/runtime/native-patch.ts` — Native asset path env vars
6. `README.md` — User-facing documentation
7. `packages/cli/STANDALONE.md` — Deployment documentation
8. `packages/dashboard/README.md` — Technical documentation

Run this command to see all KB_* environment variable usages:
```bash
grep -rn "process\.env\.KB_\|KB_[A-Z_]*=" /Users/eclipxe/Projects/kb/packages --include="*.ts" --include="*.tsx" --include="*.md" 2>/dev/null | grep -v node_modules | grep -v ".worktrees"
```

## File Scope

**Source files with environment variable references (must update):**

1. `packages/dashboard/src/github-webhooks.ts` — 4 env vars
2. `packages/dashboard/src/badge-pubsub.ts` — 2 env vars + 1 default channel string
3. `packages/dashboard/src/server.ts` — 2 env vars
4. `packages/dashboard/src/terminal-service.ts` — 2 env vars
5. `packages/cli/src/runtime/native-patch.ts` — 3 env vars

**Test files with environment variable references (must update):**

6. `packages/dashboard/src/__tests__/github-webhooks.test.ts` — 4 env vars
7. `packages/dashboard/src/__tests__/badge-pubsub.test.ts` — 2 env vars

**Documentation files (must update):**

8. `README.md` — 2 env var references
9. `packages/cli/STANDALONE.md` — 4 env var references
10. `packages/dashboard/README.md` — 6 env var references

**Changeset files (check for references):**
- `.changeset/*.md` — Any changesets mentioning KB_* env vars

**Excluded from changes:**
- `.worktrees/` directories (ephemeral)
- `node_modules/` directories
- `dist/` directories (rebuilt)
- Historical task data in `.fusion/tasks/` (preserve as-is)

## Environment Variable Mapping

| Old Name | New Name | Files Affected |
|----------|----------|----------------|
| `KB_GITHUB_APP_ID` | `FUSION_GITHUB_APP_ID` | github-webhooks.ts, test file, docs |
| `KB_GITHUB_APP_PRIVATE_KEY` | `FUSION_GITHUB_APP_PRIVATE_KEY` | github-webhooks.ts, test file, docs |
| `KB_GITHUB_APP_PRIVATE_KEY_PATH` | `FUSION_GITHUB_APP_PRIVATE_KEY_PATH` | github-webhooks.ts, test file, docs |
| `KB_GITHUB_WEBHOOK_SECRET` | `FUSION_GITHUB_WEBHOOK_SECRET` | github-webhooks.ts, test file, docs |
| `KB_BADGE_PUBSUB_REDIS_URL` | `FUSION_BADGE_PUBSUB_REDIS_URL` | badge-pubsub.ts, test file, docs |
| `KB_BADGE_PUBSUB_CHANNEL` | `FUSION_BADGE_PUBSUB_CHANNEL` | badge-pubsub.ts, test file, docs |
| `KB_DEBUG_PLANNING_ROUTES` | `FUSION_DEBUG_PLANNING_ROUTES` | routes.ts, server.ts |
| `KB_RUNTIME_DIR` | `FUSION_RUNTIME_DIR` | native-patch.ts, terminal-service.ts |
| `KB_NATIVE_ASSETS_PATH` | `FUSION_NATIVE_ASSETS_PATH` | native-patch.ts, terminal-service.ts |
| `KB_FAKE_BUNFS_ROOT` | `FUSION_FAKE_BUNFS_ROOT` | native-patch.ts |
| `KB_CLIENT_DIR` | `FUSION_CLIENT_DIR` | server.ts, README.md |

**Note:** The default channel name `kb:badge-updates` in `badge-pubsub.ts` should also be updated to `fusion:badge-updates` for consistency.

## Steps

### Step 1: Update Dashboard Source Files

Update all KB_* environment variable references in the dashboard package.

**github-webhooks.ts:**
- [ ] Change `process.env.KB_GITHUB_APP_ID` to `process.env.FUSION_GITHUB_APP_ID`
- [ ] Change `process.env.KB_GITHUB_WEBHOOK_SECRET` to `process.env.FUSION_GITHUB_WEBHOOK_SECRET`
- [ ] Change `process.env.KB_GITHUB_APP_PRIVATE_KEY` to `process.env.FUSION_GITHUB_APP_PRIVATE_KEY`
- [ ] Change `process.env.KB_GITHUB_APP_PRIVATE_KEY_PATH` to `process.env.FUSION_GITHUB_APP_PRIVATE_KEY_PATH`
- [ ] Update JSDoc comment: "Supports KB_GITHUB_APP_PRIVATE_KEY" → "Supports FUSION_GITHUB_APP_PRIVATE_KEY"

**badge-pubsub.ts:**
- [ ] Change `process.env.KB_BADGE_PUBSUB_REDIS_URL` to `process.env.FUSION_BADGE_PUBSUB_REDIS_URL`
- [ ] Change `process.env.KB_BADGE_PUBSUB_CHANNEL` to `process.env.FUSION_BADGE_PUBSUB_CHANNEL`
- [ ] Update JSDoc comments for both environment variables
- [ ] Change default channel from `"kb:badge-updates"` to `"fusion:badge-updates"`

**server.ts:**
- [ ] Change `process.env.KB_CLIENT_DIR` to `process.env.FUSION_CLIENT_DIR`
- [ ] Change `process.env.KB_DEBUG_PLANNING_ROUTES` to `process.env.FUSION_DEBUG_PLANNING_ROUTES`
- [ ] Update comment: "1. KB_CLIENT_DIR env override" → "1. FUSION_CLIENT_DIR env override"

**routes.ts:**
- [ ] Change `process.env.KB_DEBUG_PLANNING_ROUTES` to `process.env.FUSION_DEBUG_PLANNING_ROUTES`

**terminal-service.ts:**
- [ ] Change `process.env.KB_RUNTIME_DIR` to `process.env.FUSION_RUNTIME_DIR`
- [ ] Change `process.env.KB_NATIVE_ASSETS_PATH` to `process.env.FUSION_NATIVE_ASSETS_PATH`

**Artifacts:**
- `packages/dashboard/src/github-webhooks.ts` (modified)
- `packages/dashboard/src/badge-pubsub.ts` (modified)
- `packages/dashboard/src/server.ts` (modified)
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/src/terminal-service.ts` (modified)

### Step 2: Update CLI Runtime Files

Update all KB_* environment variable references in the CLI package.

**native-patch.ts:**
- [ ] Change `process.env.KB_RUNTIME_DIR` to `process.env.FUSION_RUNTIME_DIR` (2 occurrences)
- [ ] Change `process.env.KB_NATIVE_ASSETS_PATH` to `process.env.FUSION_NATIVE_ASSETS_PATH` (3 occurrences)
- [ ] Change `process.env.KB_FAKE_BUNFS_ROOT` to `process.env.FUSION_FAKE_BUNFS_ROOT` (1 occurrence)

**Artifacts:**
- `packages/cli/src/runtime/native-patch.ts` (modified)

### Step 3: Update Test Files

Update all KB_* environment variable references in test files.

**github-webhooks.test.ts:**
- [ ] Change all `process.env.KB_GITHUB_APP_ID` to `process.env.FUSION_GITHUB_APP_ID`
- [ ] Change all `process.env.KB_GITHUB_APP_PRIVATE_KEY` to `process.env.FUSION_GITHUB_APP_PRIVATE_KEY`
- [ ] Change all `process.env.KB_GITHUB_APP_PRIVATE_KEY_PATH` to `process.env.FUSION_GITHUB_APP_PRIVATE_KEY_PATH`
- [ ] Change all `process.env.KB_GITHUB_WEBHOOK_SECRET` to `process.env.FUSION_GITHUB_WEBHOOK_SECRET`
- [ ] Update all `delete process.env.KB_*` cleanup statements

**badge-pubsub.test.ts:**
- [ ] Change all `process.env.KB_BADGE_PUBSUB_REDIS_URL` to `process.env.FUSION_BADGE_PUBSUB_REDIS_URL`
- [ ] Change all `process.env.KB_BADGE_PUBSUB_CHANNEL` to `process.env.FUSION_BADGE_PUBSUB_CHANNEL`
- [ ] Update all `delete process.env.KB_*` cleanup statements

**Artifacts:**
- `packages/dashboard/src/__tests__/github-webhooks.test.ts` (modified)
- `packages/dashboard/src/__tests__/badge-pubsub.test.ts` (modified)

### Step 4: Update Documentation

Update all KB_* environment variable references in documentation files.

**README.md:**
- [ ] Change `KB_CLIENT_DIR` to `FUSION_CLIENT_DIR` (2 occurrences: description and example)
- [ ] Change `KB_BADGE_PUBSUB_REDIS_URL` to `FUSION_BADGE_PUBSUB_REDIS_URL`

**packages/cli/STANDALONE.md:**
- [ ] Change `KB_BADGE_PUBSUB_REDIS_URL` to `FUSION_BADGE_PUBSUB_REDIS_URL`
- [ ] Change `KB_BADGE_PUBSUB_CHANNEL` to `FUSION_BADGE_PUBSUB_CHANNEL`
- [ ] Change `KB_GITHUB_APP_ID` to `FUSION_GITHUB_APP_ID`
- [ ] Change `KB_GITHUB_APP_PRIVATE_KEY_PATH` to `FUSION_GITHUB_APP_PRIVATE_KEY_PATH`
- [ ] Change `KB_GITHUB_APP_PRIVATE_KEY` to `FUSION_GITHUB_APP_PRIVATE_KEY`
- [ ] Change `KB_GITHUB_WEBHOOK_SECRET` to `FUSION_GITHUB_WEBHOOK_SECRET`

**packages/dashboard/README.md:**
- [ ] Change all 6 KB_* env var references to FUSION_* equivalents
- [ ] Change `kb:badge-updates` to `fusion:badge-updates` in the default channel documentation

**Artifacts:**
- `README.md` (modified)
- `packages/cli/STANDALONE.md` (modified)
- `packages/dashboard/README.md` (modified)

### Step 5: Update Changeset Files

Check and update any changeset files that mention KB_* environment variables.

- [ ] Search for changesets containing KB_* env vars
- [ ] Update any found references to FUSION_* equivalents

**Verification command:**
```bash
grep -l "KB_" /Users/eclipxe/Projects/kb/.changeset/*.md 2>/dev/null
```

**Artifacts:**
- Any affected `.changeset/*.md` files (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm install` to ensure dependencies are up to date
- [ ] Run `pnpm build` to verify all packages compile successfully
- [ ] Run `pnpm test` to verify all tests pass
- [ ] Verify no remaining KB_* environment variable references (excluding historical data):
  ```bash
  grep -rn "process\.env\.KB_\|KB_[A-Z_]*=" /Users/eclipxe/Projects/kb/packages --include="*.ts" --include="*.tsx" --include="*.md" 2>/dev/null | grep -v node_modules | grep -v ".worktrees" | wc -l
  # Expected result: 0
  ```

**Common issues to watch for:**
- Test files that set/unset environment variables
- Hardcoded strings in error messages or comments
- Default channel name references

**Artifacts:**
- All builds pass
- All tests pass

### Step 7: Documentation & Delivery

- [ ] Create changeset for this rename:
```bash
cat > .changeset/rename-environment-variables.md << 'EOF'
---
"@dustinbyrne/fusion": minor
"@fusion/dashboard": patch
---

Rename environment variables from KB_* to FUSION_* prefix

BREAKING CHANGE: All environment variables have been renamed:
- KB_GITHUB_APP_ID → FUSION_GITHUB_APP_ID
- KB_GITHUB_APP_PRIVATE_KEY → FUSION_GITHUB_APP_PRIVATE_KEY
- KB_GITHUB_APP_PRIVATE_KEY_PATH → FUSION_GITHUB_APP_PRIVATE_KEY_PATH
- KB_GITHUB_WEBHOOK_SECRET → FUSION_GITHUB_WEBHOOK_SECRET
- KB_BADGE_PUBSUB_REDIS_URL → FUSION_BADGE_PUBSUB_REDIS_URL
- KB_BADGE_PUBSUB_CHANNEL → FUSION_BADGE_PUBSUB_CHANNEL
- KB_DEBUG_PLANNING_ROUTES → FUSION_DEBUG_PLANNING_ROUTES
- KB_RUNTIME_DIR → FUSION_RUNTIME_DIR
- KB_NATIVE_ASSETS_PATH → FUSION_NATIVE_ASSETS_PATH
- KB_FAKE_BUNFS_ROOT → FUSION_FAKE_BUNFS_ROOT
- KB_CLIENT_DIR → FUSION_CLIENT_DIR
EOF
```
- [ ] Verify all documentation accurately reflects the new variable names
- [ ] Document any out-of-scope findings: If you discover references that should be handled by other tasks, do NOT modify them — document them in the task log

**Artifacts:**
- `.changeset/rename-environment-variables.md` (new)

## Completion Criteria

- [ ] All 11 source files updated with new environment variable names
- [ ] All 2 test files updated with new environment variable names
- [ ] All 3 documentation files updated
- [ ] Default pub/sub channel name updated from `kb:badge-updates` to `fusion:badge-updates`
- [ ] `pnpm install` completes successfully
- [ ] `pnpm build` passes for all packages
- [ ] `pnpm test` passes with zero failures
- [ ] Changeset file created for the rename
- [ ] Zero remaining `KB_*` environment variable references in active codebase (excluding historical `.fusion/tasks/` data)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step 1:** `feat(KB-335): rename env vars in dashboard source files`
- **Step 2:** `feat(KB-335): rename env vars in CLI runtime files`
- **Step 3:** `test(KB-335): update test files with new env var names`
- **Step 4:** `docs(KB-335): update documentation with new env var names`
- **Step 5:** `chore(KB-335): update changeset files`
- **Step 6:** `test(KB-335): verify build and tests pass`
- **Step 7:** `chore(KB-335): add changeset for env var rename`

## Do NOT

- Rename the data directory from `.fusion` to `.fusion` (handled in KB-336)
- Rename task ID prefixes from KB-XXX (handled in KB-332)
- Change package names (handled in KB-330 and KB-333)
- Modify files in `.worktrees/` directories (ephemeral)
- Modify historical task data in `.fusion/tasks/` (preserve as-is)
- Skip running the full test suite
- Commit lockfile or changeset without the task ID prefix
- Update any environment variables not listed in the mapping table
