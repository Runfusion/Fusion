# Task: FN-670 - Ensure Build Passes Before Merging to Main

**Created:** 2026-04-01
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This change affects the critical merge path - modifying merger prompts and adding pre-merge build verification. The blast radius is moderate (merger.ts and executor.ts prompts), but a failure here could block all merges or let broken code through.

**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Currently, the system runs tests and builds during task execution in isolated worktrees, but there's no guarantee the build passes in the main repository context before merging. The merger agent only resolves conflicts and writes commit messages - it doesn't verify the build still passes after staging the squash merge.

Add mandatory build verification to the merge process. The merger AI agent must run the configured build command (if any) before finalizing the merge. If the build fails, the merge aborts and the task stays in "in-review" for human investigation. This ensures broken code never reaches main.

## Dependencies

- **None**

## Context to Read First

- `packages/engine/src/merger.ts` — Current merger implementation and system prompt
- `packages/engine/src/executor.ts` — How build commands are injected into execution prompts (see `buildExecutionPrompt()` around line 1730-1750)
- `packages/engine/src/merger.test.ts` — Existing merger tests for reference
- `packages/core/src/types.ts` — Settings type definitions (buildCommand field)

## File Scope

- `packages/engine/src/merger.ts` (modified)
- `packages/engine/src/executor.ts` (modified)
- `packages/engine/src/merger.test.ts` (modified)

## Steps

### Step 1: Update Merger System Prompt for Build Verification

- [ ] Modify `buildMergeSystemPrompt()` in `merger.ts` to include build verification instructions
- [ ] Add a new section after "## Commit message" called "## Build verification"
- [ ] The section should contain this exact text:
  ```
  ## Build verification

  If a build command is configured for this project, you MUST run it before committing.

  1. Run the build command (shown in the prompt context below)
  2. If the build succeeds (exit code 0), proceed with the commit
  3. If the build fails (non-zero exit code), DO NOT commit. Instead:
     - Respond with "BUILD FAILED: <error details>" 
     - Stop and do not proceed further

  The merge will only be completed if the build passes or no build command is configured.
  ```

**Artifacts:**
- `packages/engine/src/merger.ts` (modified)

### Step 2: Pass Build Command to Merge Context

- [ ] Modify `buildMergePrompt()` in `merger.ts` to accept a `buildCommand` parameter
- [ ] Add a "## Build command" section to the merge prompt when buildCommand is provided:
  ```
  ## Build command
  Build command: `pnpm build`
  
  Run this command via bash tool before committing to verify the build passes.
  ```
- [ ] Update `runAiAgentForCommit()` signature to accept `buildCommand: string | undefined`
- [ ] Update `runAiAgentForCommit()` to pass the build command to `buildMergePrompt()`
- [ ] Update `executeMergeAttempt()` to read `settings.buildCommand` and pass it through the call chain
- [ ] Handle the case where `buildCommand` is empty string (treat as undefined - skip verification)

**Artifacts:**
- `packages/engine/src/merger.ts` (modified)

### Step 3: Update Executor Prompt Template

- [ ] Modify `buildExecutionPrompt()` in `executor.ts` around line 1750
- [ ] In the existing "## Project Commands" section, ensure the build command is shown when configured
- [ ] Add to the final "Begin" section: before `task_done()`, verify the build passes:
  ```
  Verify build passes using the configured build command before calling `task_done()`.
  ```

**Artifacts:**
- `packages/engine/src/executor.ts` (modified)

### Step 4: Handle Build Failure in Merge Flow

- [ ] Update `runAiAgentForCommit()` to detect build failure from agent response
- [ ] After `await session.prompt(prompt)`, check the agent's response content:
  - If the response starts with "BUILD FAILED:", treat as build failure
  - Return a new result object: `{ success: false; error: string }` instead of `Promise<boolean>`
- [ ] Update `executeMergeAttempt()` to handle the new result type from `runAiAgentForCommit()`
- [ ] When build fails:
  1. Log the failure: `await store.logEntry(taskId, "Build verification failed during merge", errorMessage)`
  2. Reset staged changes: `execSync("git reset --merge", { cwd: rootDir, stdio: "pipe" })`
  3. Throw an error: `throw new Error(\`Build verification failed for ${taskId}: ${errorMessage}\`)`
  4. The error will propagate to `aiMergeTask()` and cause the task to stay in "in-review"
- [ ] On success, proceed with branch deletion and worktree cleanup as normal

**Artifacts:**
- `packages/engine/src/merger.ts` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add tests in `merger.test.ts` for:
  - Build command being included in the merge prompt when configured
  - Build verification section appearing in system prompt  
  - Merge succeeding when build passes (agent responds normally, no "BUILD FAILED" prefix)
  - Merge aborting when build fails (agent responds with "BUILD FAILED: ...")
  - Merge proceeding normally when no build command is configured
  - Merge proceeding when buildCommand is empty string
- [ ] Mock the agent response to simulate build failure vs success cases
- [ ] Verify `git reset --merge` is called when build fails
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/engine/src/merger.test.ts` (modified)

### Step 6: Documentation & Delivery

- [ ] Create changeset file: `.changeset/build-verification-before-merge.md`
- [ ] Document the new behavior in the changeset:
  - Merger now runs build verification before committing
  - Build failures block merge and keep task in in-review
- [ ] Verify no documentation updates needed in AGENTS.md (this is an internal engine behavior change)

**Artifacts:**
- `.changeset/build-verification-before-merge.md` (new)

## Documentation Requirements

**Must Update:**
- `.changeset/build-verification-before-merge.md` — Document the new build verification behavior

**Check If Affected:**
- None — this is internal engine behavior

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Merger system prompt includes build verification instructions with exact text specified
- [ ] Build command is passed to merger context when configured
- [ ] Executor prompt emphasizes build verification before `task_done()`
- [ ] Build failures during merge abort the merge, reset staged changes, and keep task in in-review
- [ ] Agent signals build failure via "BUILD FAILED:" response prefix
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(FN-670): complete Step N — description`
- **Bug fixes:** `fix(FN-670): description`
- **Tests:** `test(FN-670): description`

## Do NOT

- Run the build in the worktree (it runs in the main repo on staged squash merge changes)
- Modify the Testing & Verification step template in triage.ts (that applies to task execution, not merging)
- Skip tests for the new build verification logic
- Change the merge flow to run build BEFORE staging the squash merge (build must run on staged changes)
- Add a separate "build verification" column or status — keep it simple: fail → stay in in-review
