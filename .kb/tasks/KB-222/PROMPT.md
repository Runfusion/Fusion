# Task: KB-222 - Adjust documentation and other files to change from "kb" to "Fusion"

**Created:** 2026-03-31
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** Documentation and help text updates to align branding with "Fusion". Low risk changes — string replacements in docs and UI text. No logic changes, fully reversible by reverting text changes.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Update all user-facing documentation, help text, and descriptions to rebrand from "kb" to "Fusion". This completes the branding transition alongside KB-221 (binary rename to `fn`) and KB-071 (dashboard UI rename). Internal identifiers (package names, task IDs, git branches, config directories) remain unchanged — only user-visible text changes.

## Dependencies

- **Task:** KB-221 (Binary rename from `kb` to `fn` — must be complete so documentation references correct command)

## Context to Read First

- `README.md` — main project documentation with extensive "kb" references
- `packages/cli/README.md` — CLI package documentation
- `packages/cli/STANDALONE.md` — standalone CLI usage guide
- `packages/cli/src/bin.ts` — CLI help text with command examples
- `packages/cli/src/extension.ts` — pi extension tool descriptions and `/kb` command

## File Scope

- `README.md`
- `packages/cli/README.md`
- `packages/cli/STANDALONE.md`
- `packages/cli/src/bin.ts`
- `packages/cli/src/extension.ts`

## Steps

### Step 1: Update Root README.md

- [ ] Change main heading from `# kb` to `# Fusion`
- [ ] Update description from "AI-orchestrated task board" to reference Fusion
- [ ] Replace `kb dashboard` examples with `fn dashboard` 
- [ ] Replace `kb task` examples with `fn task`
- [ ] Update Quick Start section to use `fn` command
- [ ] Update CLI commands section to use `fn` command
- [ ] Keep package name as `@dustinbyrne/kb` for npm install (correct)
- [ ] Keep internal references to `.fusion/` directory and `kb/{task-id}` branches (correct)
- [ ] Keep workflow diagram text as-is (describes the system, not the command)

**Key replacements:**
- "npm i -g @dustinbyrne/kb" → keep as-is (package name unchanged)
- "kb dashboard" → "fn dashboard"
- "kb task create" → "fn task create"
- "kb task list" → "fn task list"
- "kb task show" → "fn task show"
- "kb task move" → "fn task move"
- "kb task merge" → "fn task merge"
- "kb task attach" → "fn task attach"
- "kb task pause" → "fn task pause"
- "kb task unpause" → "fn task unpause"
- "kb task import" → "fn task import"

**Artifacts:**
- `README.md` (modified)

### Step 2: Update CLI Package README.md

- [ ] Update heading and all "kb" references to "Fusion"
- [ ] Replace `/kb` command references with `/fn` in pi extension section
- [ ] Update all CLI examples from `kb` to `fn`
- [ ] Keep references to `@dustinbyrne/kb` package name

**Key replacements:**
- "/kb" → "/fn" (when referring to the pi slash command)
- "kb dashboard" → "fn dashboard"
- "kb works" → "Fusion works" (when referring to the product)
- "the kb board" → "the Fusion board"

**Artifacts:**
- `packages/cli/README.md` (modified)

### Step 3: Update STANDALONE.md

- [ ] Replace all `kb` command examples with `fn`
- [ ] Update product references from "kb" to "Fusion"
- [ ] Keep `/kb` command reference in the pi section as `/fn`

**Key replacements:**
- "kb works" → "Fusion works"
- "kb dashboard" → "fn dashboard"
- "kb task" → "fn task"

**Artifacts:**
- `packages/cli/STANDALONE.md` (modified)

### Step 4: Update CLI Help Text (bin.ts)

- [ ] Change `kb — AI-orchestrated task board` to `fn — AI-orchestrated task board` or `Fusion — AI-orchestrated task board`
- [ ] Update all command examples in HELP text from `kb` to `fn`
- [ ] Keep internal logic unchanged — only the HELP constant

**Key replacements in HELP constant:**
- `kb — AI-orchestrated task board` → `Fusion — AI-orchestrated task board`
- All `kb dashboard` → `fn dashboard`
- All `kb task` → `fn task`
- Error messages referencing usage: keep "Usage: fn task ..."

**Artifacts:**
- `packages/cli/src/bin.ts` (modified)

### Step 5: Update Pi Extension (extension.ts)

- [ ] Update tool descriptions that reference "kb" to reference "Fusion"
- [ ] Update `promptSnippet` text from "kb" to "Fusion"
- [ ] Update `/kb` command name to `/fn` (if supported by pi API)
- [ ] Update command description from "kb dashboard" to "Fusion dashboard"
- [ ] Keep tool names as `kb_task_create` etc. (internal API identifiers)
- [ ] Keep function name `kbExtension` as-is (internal identifier)

**Key replacements:**
- "the kb task board" → "the Fusion task board"
- "the kb board" → "the Fusion board"
- "a kb task" → "a Fusion task"
- "kb_task_create" → keep as-is (tool name)
- "kb_dashboard" → keep as-is (internal reference)
- `/kb` command → `/fn` command
- Status messages: "kb dashboard" → "Fusion dashboard"

**Artifacts:**
- `packages/cli/src/extension.ts` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm build` to ensure TypeScript compiles without errors
- [ ] Run `pnpm test` to ensure all tests pass
- [ ] Verify no broken links or syntax errors in markdown files
- [ ] Spot-check that `fn` appears correctly in help text: `node packages/cli/dist/bin.js --help`

### Step 7: Documentation & Delivery

- [ ] Create a changeset documenting the rebranding:

**Changeset location:** `.changeset/rebrand-documentation-to-fusion.md`

**Changeset content:**
```md
---
"@dustinbyrne/kb": minor
---

Rebrand documentation and help text from "kb" to "Fusion"

All user-facing documentation, help text, and tool descriptions now refer to the product as "Fusion" and the CLI as `fn`. Internal identifiers (package names, task IDs, git branches) remain unchanged.
```

- [ ] Include changeset in final commit

## Documentation Requirements

**Must Update:**
- `README.md` — all CLI examples and product references
- `packages/cli/README.md` — pi extension and CLI documentation
- `packages/cli/STANDALONE.md` — standalone CLI usage guide
- `packages/cli/src/bin.ts` — help text constant
- `packages/cli/src/extension.ts` — tool descriptions and command text

**Check If Affected:**
- `AGENTS.md` — review if any new CLI examples need updating (should already reference `fn` after this change)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Build succeeds
- [ ] Changeset file created
- [ ] No remaining "kb" references in user-facing text (except package name `@dustinbyrne/kb`, task IDs like `KB-001`, git branches `kb/{id}`, and `.fusion/` directory)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step 1:** `docs(KB-222): rebrand root README from kb to Fusion`
- **Step 2:** `docs(KB-222): rebrand CLI package README`
- **Step 3:** `docs(KB-222): rebrand STANDALONE.md documentation`
- **Step 4:** `feat(KB-222): update CLI help text to use fn command`
- **Step 5:** `feat(KB-222): update pi extension descriptions for Fusion`
- **Step 6-7:** `docs(KB-222): add changeset for rebranding`

## Do NOT

- Change the npm package name `@dustinbyrne/kb`
- Change internal workspace package names (`@kb/core`, `@kb/dashboard`, `@kb/engine`)
- Change task ID format (`KB-001` stays)
- Change git branch naming convention (`kb/{task-id}` stays)
- Change config directory (`.fusion/` stays)
- Change tool names (`kb_task_create`, etc. — internal identifiers)
- Skip test verification
- Modify any logic beyond text changes
