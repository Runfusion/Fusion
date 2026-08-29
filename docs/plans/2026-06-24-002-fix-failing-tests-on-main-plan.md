---
title: "fix: Fix failing tests on origin main"
date: 2026-06-24
type: fix
---

# Fix Failing Tests on Origin Main

## Summary

Six tests are failing on `origin/main` after recent feature commits landed without updating dependent test assertions. Each failure is a test that drifted from its source-of-truth configuration, plus one stale build artifact issue. No production behavior is broken — every fix aligns the test (or build output) with an intentional code change.

## Problem Frame

The full test suite (`pnpm test:full`) and individual package suites have 6 failures across 3 packages. All are caused by test assertions that were not updated when the corresponding source changed. The root cause for each is an intentional source change that is correct in production; the tests simply lagged behind.

## Root Causes

1. **Core `test-project.test.ts`** — commit `800f845e1` changed `DEFAULT_PROJECT_SETTINGS.taskPrefix` from `"FN"` to `undefined` (prefix now derived from project name). The test still asserts `"FN"`.
2. **Dashboard `text-token-canonicalization.test.ts`** — `ScriptsModal.css` uses `var(--text-primary)`, but `--text-primary` is banned outside `components/command-center/`. The canonical replacement is `var(--text)`.
3. **CLI `package-config.test.ts`** — pi runtime deps were bumped from `^0.79.1` to `^0.79.9` in `package.json` but the test still hardcodes `^0.79.1`.
4. **CLI `skill-sync.test.ts`** — four engine session tools (`fn_acquire_repo_worktree`, `fn_artifact_register`, `fn_artifact_list`, `fn_artifact_view`) were added to `agent-tools.ts` but not documented in `engine-tools.md`.
5. **CLI `version.test.ts`** — root `release:version` script gained `&& node scripts/run-ci-distill.mjs` but the test expects the old value.
6. **CLI `bundled-plugin-freshness.test.ts`** — three bundled plugins have stale dist directories relative to src; needs `pnpm build`.

---

## Implementation Units

### U1. Fix core test-project taskPrefix assertion

**Goal:** Align the test with the intentional `taskPrefix: undefined` default.

**Files:**
- `packages/core/src/__tests__/test-project.test.ts` (modify)

**Approach:** Change `expect(config.settings.taskPrefix).toBe("FN")` to `expect(config.settings.taskPrefix).toBeUndefined()`. The runtime fallback `(settings.taskPrefix || "FN")` still ensures tasks get `FN-NNN` IDs — this is covered by the existing test at line 89 (`expect(firstTasks[0].id).toBe("FN-001")`).

**Test scenarios:**
- Fresh project config.json has `settings.taskPrefix` as `undefined` (not persisted by default)
- Tasks created in a fresh test project still get `FN-NNN` IDs (existing assertion, unchanged)

**Verification:** `pnpm --filter @fusion/core vitest run src/__tests__/test-project.test.ts`

---

### U2. Fix dashboard text-token canonicalization in ScriptsModal.css

**Goal:** Replace the banned `--text-primary` token with the canonical `--text` token.

**Files:**
- `packages/dashboard/app/components/ScriptsModal.css` (modify)

**Approach:** Replace `var(--text-primary)` with `var(--text)` on line 2333. This is a CSS token alias migration — `--text` is the canonical primary text color; `--text-primary` is the legacy alias that the canonicalization test blocks outside command-center.

**Test scenarios:**
- No `--text-primary` references in dashboard source files outside `components/command-center/`

**Verification:** Dashboard quality lane passes the `text-token-canonicalization` test.

---

### U3. Fix CLI package-config dependency version assertion

**Goal:** Update the test to match the current `^0.79.9` dependency version.

**Files:**
- `packages/cli/src/__tests__/package-config.test.ts` (modify)

**Approach:** Change the hardcoded `"^0.79.1"` in `assertRuntimeDepsAreNotOptionalPeers` to `"^0.79.9"` for both `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`.

**Test scenarios:**
- Source manifest declares pi runtime deps at `^0.79.9`
- Published (prepack) manifest also declares them at `^0.79.9`

**Verification:** `pnpm --filter @runfusion/fusion vitest run src/__tests__/package-config.test.ts`

---

### U4. Document four undocumented engine session tools

**Goal:** Add `fn_acquire_repo_worktree`, `fn_artifact_register`, `fn_artifact_list`, `fn_artifact_view` to `engine-tools.md`.

**Files:**
- `packages/cli/skill/fusion/references/engine-tools.md` (modify)

**Approach:** Add table rows to the "Shared runtime tools" section for the three artifact tools (register/list/view — used by executor, heartbeat, and chat/planning variants) and add `fn_acquire_repo_worktree` as an executor workspace tool.

**Test scenarios:**
- `getEngineSessionToolNames()` returns a subset of `getDocumentedEngineToolNames()`

**Verification:** `pnpm --filter @runfusion/fusion vitest run src/__tests__/skill-sync.test.ts`

---

### U5. Fix CLI version test release:version assertion

**Goal:** Update the test to expect the full `release:version` script including the distill step.

**Files:**
- `packages/cli/src/__tests__/version.test.ts` (modify)

**Approach:** Change the expected value from `"changeset version && node scripts/sync-workspace-version.mjs"` to `"changeset version && node scripts/sync-workspace-version.mjs && node scripts/run-ci-distill.mjs"`.

**Test scenarios:**
- `release:version` script includes changeset version, workspace version sync, and CI distill

**Verification:** `pnpm --filter @runfusion/fusion vitest run src/__tests__/version.test.ts`

---

### U6. Rebuild stale bundled plugin dist directories

**Goal:** Rebuild dist for the three stale bundled plugins so the freshness test passes.

**Files:**
- `plugins/fusion-plugin-hermes-runtime/dist/**` (build output)
- `plugins/fusion-plugin-openclaw-runtime/dist/**` (build output)
- `plugins/fusion-plugin-paperclip-runtime/dist/**` (build output)

**Approach:** Run `pnpm build` (or targeted plugin build) to regenerate the dist directories from current src. No source changes needed.

**Test expectation:** none — build output regeneration, not a behavioral change.

**Verification:** `pnpm --filter @runfusion/fusion vitest run src/plugins/__tests__/bundled-plugin-freshness.test.ts`

---

## Scope Boundaries

### Out of scope
- Changing the `taskPrefix` default back to `"FN"` (the workspace-derived prefix is the intended behavior)
- Adding new features or changing product behavior
- Investigating the 12 dashboard quality lanes that were skipped after the first failure (will re-run after fix to confirm no hidden failures)
