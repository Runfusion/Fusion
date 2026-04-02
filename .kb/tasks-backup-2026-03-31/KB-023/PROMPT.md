# Task: KB-023 - Automatically resolve merge conflicts when merging

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task enhances the core merge algorithm to automatically resolve trivial conflicts without AI intervention. It touches conflict detection patterns, git operations in merger.ts, and adds test coverage. The change is additive and reversible — existing AI-based resolution remains as the fallback for complex conflicts.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Enhance the merge system to automatically resolve common merge conflicts **without spawning an AI agent**. Lock files (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Gemfile.lock`, `bun.lockb`), generated files (`*.gen.ts`, `dist/*`, `coverage/*`, `*.min.js`), and trivial whitespace conflicts should be resolved automatically using git strategies (`--ours`, `--theirs`, or `merge -X ours/theirs`). This reduces latency and API costs for the most common merge conflict scenarios, reserving AI intervention for complex code conflicts only.

## Dependencies

- **None**

## Context to Read First

- `packages/engine/src/merger.ts` — Core merge logic (`aiMergeTask`, `buildMergeSystemPrompt`, conflict handling)
- `packages/engine/src/merger.test.ts` — Existing merge tests showing mock patterns
- `packages/core/src/types.ts` — `MergeResult`, `Settings`, `DEFAULT_SETTINGS` definitions
- `packages/core/src/store.ts` — Non-AI merge implementation for reference (`mergeTask` method)

## File Scope

- `packages/engine/src/merger.ts` (modify — add conflict detection and auto-resolution)
- `packages/engine/src/merger.test.ts` (modify — add tests for auto-resolution)
- `packages/core/src/types.ts` (modify — add `smartConflictResolution` setting)

## Steps

### Step 1: Add Smart Conflict Resolution Setting

- [ ] Add `smartConflictResolution?: boolean` to `Settings` interface in `packages/core/src/types.ts`
- [ ] Add `smartConflictResolution: true` to `DEFAULT_SETTINGS`
- [ ] Add test in `packages/core/src/store.test.ts` verifying the setting persists with default value

**Artifacts:**
- `packages/core/src/types.ts` (modified)
- `packages/core/src/store.test.ts` (modified)

### Step 2: Implement Conflict Classification Logic

- [ ] Create `classifyConflict(filePath: string, cwd: string): ConflictType` function in `merger.ts` that returns one of:
  - `'lockfile-ours'` — Lock files that should use "ours" (keep main's version)
  - `'generated-theirs'` — Generated files that should use "theirs" (keep branch's fresh generation)
  - `'trivial-whitespace'` — Whitespace-only conflicts detectable via `git diff -w` showing no substantive diff
  - `'complex'` — Everything else (requires AI)
- [ ] Create `LOCKFILE_PATTERNS` constant: `["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Gemfile.lock", "bun.lockb", "composer.lock", "poetry.lock", "go.sum"]`
- [ ] Create `GENERATED_PATTERNS` constant: `["*.gen.ts", "*.gen.js", "dist/*", "build/*", "coverage/*", "*.min.js", "*.min.css", ".next/*", "out/*"]` (support glob matching)
- [ ] Implement `isTrivialWhitespaceConflict(filePath: string, cwd: string): boolean` that uses `git show :1:file` (base), `git show :2:file` (ours), `git show :3:file` (theirs) to compare with `-w` (ignore whitespace)
- [ ] Add unit tests for classification logic with mocked git calls

**Artifacts:**
- `packages/engine/src/merger.ts` (modified — new functions and constants)
- `packages/engine/src/merger.test.ts` (new tests for classification)

### Step 3: Implement Auto-Resolution Functions

- [ ] Create `resolveWithOurs(filePath: string, cwd: string): void` — runs `git checkout --ours "${filePath}" && git add "${filePath}"`
- [ ] Create `resolveWithTheirs(filePath: string, cwd: string): void` — runs `git checkout --theirs "${filePath}" && git add "${filePath}"`
- [ ] Create `resolveTrivialWhitespace(filePath: string, cwd: string): void` — runs `git add "${filePath}"` (git considers whitespace-resolved files as staged)
- [ ] Create `getConflictedFiles(cwd: string): string[]` — runs `git diff --name-only --diff-filter=U` and returns array of file paths
- [ ] Add comprehensive tests for each resolution function using mocked `execSync`

**Artifacts:**
- `packages/engine/src/merger.ts` (modified — resolution helpers)
- `packages/engine/src/merger.test.ts` (tests for resolution functions)

### Step 4: Integrate Smart Resolution into aiMergeTask

- [ ] Modify the conflict handling section in `aiMergeTask` (around line 120-150) to:
  1. Read `smartConflictResolution` from settings
  2. If enabled: call `getConflictedFiles()` and `classifyConflict()` for each
  3. Auto-resolve all lock files with "ours"
  4. Auto-resolve all generated files with "theirs"
  5. Auto-resolve all trivial whitespace conflicts
  6. Re-check remaining conflicts with `getConflictedFiles()`
  7. If **only** complex conflicts remain (or none), proceed with AI agent (reduced scope)
  8. If **all** conflicts were auto-resolved, commit with fallback message (skip AI entirely)
- [ ] Add `resolutionMethod?: 'ai' | 'auto' | 'mixed'` field to `MergeResult` to track how conflicts were resolved
- [ ] Update `MergeResult` type in `packages/core/src/types.ts`
- [ ] Ensure proper cleanup (`git reset --merge`) if any step fails

**Artifacts:**
- `packages/engine/src/merger.ts` (modified — smart resolution integration)
- `packages/core/src/types.ts` (modified — `resolutionMethod` in `MergeResult`)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all tests pass
- [ ] Add tests in `merger.test.ts`:
  - Mock conflict in `package-lock.json` → verify auto-resolution with "ours" and no AI spawned
  - Mock conflict in `pnpm-lock.yaml` → verify auto-resolution
  - Mock conflict in `dist/bundle.js` → verify auto-resolution with "theirs" and no AI spawned
  - Mock trivial whitespace conflict → verify auto-resolution via `git add`
  - Mock mixed conflicts (lock file + code) → verify lock file auto-resolved, AI called for code
  - Mock all conflicts auto-resolved → verify commit happens without AI, `resolutionMethod: 'auto'`
  - Mock auto-resolution failure → verify fallback to AI, `resolutionMethod: 'mixed'`
- [ ] Add test verifying `smartConflictResolution: false` bypasses auto-resolution (existing behavior)
- [ ] Run `pnpm build` — builds pass

**Artifacts:**
- `packages/engine/src/merger.test.ts` (comprehensive test coverage)

### Step 6: Documentation & Delivery

- [ ] Update `AGENTS.md` — document new `smartConflictResolution` setting under Settings section
- [ ] Add changeset file for the feature:
  ```bash
  cat > .changeset/smart-conflict-resolution.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Add smart automatic merge conflict resolution. Lock files, generated files, and trivial whitespace conflicts are now resolved automatically without AI intervention, reducing merge latency and API costs.
  EOF
  ```
- [ ] Create follow-up task for dashboard UI to expose the `smartConflictResolution` toggle

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Add section under "Settings" documenting `smartConflictResolution` with behavior description

**Check If Affected:**
- `packages/dashboard/` — Verify no API changes needed (setting flows through existing `getSettings`)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] New setting documented in `AGENTS.md`
- [ ] Changeset file included
- [ ] Lock file conflicts (`package-lock.json`, `pnpm-lock.yaml`, etc.) resolve automatically without AI
- [ ] Generated file conflicts (`dist/*`, `*.gen.ts`, etc.) resolve automatically without AI
- [ ] Trivial whitespace conflicts resolve automatically without AI
- [ ] Complex code conflicts still trigger AI agent resolution
- [ ] `resolutionMethod` field tracks how conflicts were resolved (for metrics/debugging)
- [ ] Setting `smartConflictResolution: false` preserves existing behavior (AI resolves everything)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-023): complete Step N — description`
- **Bug fixes:** `fix(KB-023): description`
- **Tests:** `test(KB-023): description`

## Do NOT

- Remove or replace the AI-based conflict resolution — it's still needed for complex conflicts
- Change the default behavior when `smartConflictResolution` is disabled
- Add UI changes in this task — defer dashboard toggle to a follow-up
- Skip auto-resolution for lock files that are in the explicit `LOCKFILE_PATTERNS` list
- Use AI for conflicts that can be resolved deterministically (lock files, generated files)
- Forget to run `git reset --merge` on any failure path
- Skip testing the "mixed" scenario (some auto-resolved, some AI-resolved)
