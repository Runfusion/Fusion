# Task: KB-138 - Mark dashboard regression task as duplicate of KB-134

**Created:** 2026-03-30
**Size:** S

## Review Level: 0 (None)

**Assessment:** This is a metadata/documentation task with no product code changes. The only goal is to make KB-138 visibly and mechanically point at KB-134 so the same dashboard regression bundle is not implemented twice.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 1

## Mission

Update KB-138’s repo-managed task artifacts so it is unmistakably marked as a duplicate of KB-134. KB-134 already owns the executable plan for the dashboard regression bundle tied to `packages/dashboard/app/components/Header.test.tsx`, `packages/dashboard/app/hooks/useTerminal.test.ts`, and `packages/dashboard/src/__tests__/typecheck.test.ts`. KB-138 must only record that superseded relationship in its own prompt and task metadata; it must not modify dashboard code, tests, package manifests, dependencies, or build settings.

## Dependencies

- **Task:** KB-134 (the canonical implementation task whose PROMPT already owns the dashboard regression file scope plus the real automated `pnpm test` / `pnpm build` verification)

## Context to Read First

- `.fusion/tasks/KB-134/PROMPT.md` — canonical implementation spec that already owns the dashboard regression bundle
- `.fusion/tasks/KB-138/task.json` — current metadata that still reads like executable implementation work
- `README.md` — task dependencies are used to sequence related work
- `packages/core/src/store.ts` — `dependencies` are persisted task metadata in `task.json`
- `packages/dashboard/app/components/TaskCard.tsx` — dashboard cards render `task.title || task.description`, so description text must clearly say the task is duplicate/superseded
- `packages/dashboard/app/components/TaskDetailModal.tsx` — task detail modal renders `task.title || task.description`, so description text must clearly say the task is duplicate/superseded

## File Scope

This task is metadata-only. Do not modify dashboard implementation or test files.

- `.fusion/tasks/KB-138/PROMPT.md`
- `.fusion/tasks/KB-138/task.json`

## Steps

### Step 0: Preflight

- [ ] Required files and paths exist
- [ ] Dependencies satisfied

### Step 1: Make KB-138 visibly superseded by KB-134

- [ ] Update `.fusion/tasks/KB-138/task.json` so `dependencies` is exactly `[
  "KB-134"
]` unless the file already contains that same dependency and no extras need removal
- [ ] Rewrite `.fusion/tasks/KB-138/task.json` `description` to explicit wording such as `Duplicate of KB-134 — superseded; do not implement separately` so the dashboard UI no longer presents KB-138 as executable implementation work; if a `title` field is introduced or already present, it must either remain unset or carry the same duplicate/superseded wording
- [ ] Update `.fusion/tasks/KB-138/PROMPT.md` so it explicitly states KB-134 is the only implementation path for this dashboard regression bundle
- [ ] Do not change any dashboard source, tests, lockfiles, package manifests, or task metadata outside KB-138

**Artifacts:**
- `.fusion/tasks/KB-138/PROMPT.md` (modified)
- `.fusion/tasks/KB-138/task.json` (modified)

### Step 2: Testing & Verification

> Metadata-only verification. Run scripted assertions against KB-138 task artifacts; do not run duplicate source-level test/build work here.

- [ ] Run a real assertion-based verification command such as:
  ```bash
  node --input-type=module -e "
  import assert from 'node:assert/strict';
  import { execFileSync } from 'node:child_process';
  import { readFileSync } from 'node:fs';

  const task = JSON.parse(readFileSync('.fusion/tasks/KB-138/task.json', 'utf8'));
  assert.deepEqual(task.dependencies, ['KB-134']);
  assert.match(task.description, /duplicate|superseded/i);
  if (typeof task.title === 'string') assert.match(task.title, /duplicate|superseded/i);

  const changed = execFileSync('git', ['status', '--short', '--untracked-files=all'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3));
  const allowed = new Set(['.fusion/tasks/KB-138/PROMPT.md', '.fusion/tasks/KB-138/task.json']);
  assert.ok(changed.every((file) => allowed.has(file)), `Unexpected changed files: ${changed.filter((file) => !allowed.has(file)).join(', ')}`);
  "
  ```
- [ ] The scripted verification must fail if `dependencies` is anything other than exactly `['KB-134']`, if the description/title do not advertise duplicate/superseded status, or if files outside KB-138 metadata changed
- [ ] Confirm KB-138 does not run or require separate `pnpm test` / `pnpm build`; those source-level quality gates remain owned by KB-134

### Step 3: Documentation & Delivery

- [ ] Keep KB-138 documented as superseded by KB-134 in both the prompt and task metadata
- [ ] Do not add a changeset because KB-138 must not change any published-package behavior or runtime code
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- `.fusion/tasks/KB-138/PROMPT.md` — explain the duplicate rationale and state that KB-134 is the only implementation path
- `.fusion/tasks/KB-138/task.json` — add the KB-134 dependency and rewrite the description so the task visibly reads as superseded

**Check If Affected:**
- `.fusion/tasks/KB-134/PROMPT.md` — only if its mission or file scope no longer clearly owns the dashboard regression bundle referenced by KB-138

## Completion Criteria

- [ ] `.fusion/tasks/KB-138/task.json` records `KB-134` as its only dependency
- [ ] `.fusion/tasks/KB-138/task.json` description clearly states KB-138 is duplicate/superseded by KB-134
- [ ] `.fusion/tasks/KB-138/PROMPT.md` explicitly says KB-138 must not be implemented separately
- [ ] No dashboard source, test, dependency, or build files are modified under KB-138
- [ ] All steps complete
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-138): complete Step N — description`
- **Bug fixes:** `fix(KB-138): description`
- **Tests:** `test(KB-138): description`

## Do NOT

- Expand task scope
- Skip verification
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Implement the dashboard regression fixes a second time under KB-138
- Modify `packages/dashboard/app/components/Header.tsx`, `packages/dashboard/app/components/Header.test.tsx`, `packages/dashboard/app/hooks/useTerminal.ts`, `packages/dashboard/app/hooks/useTerminal.test.ts`, `packages/dashboard/src/__tests__/typecheck.test.ts`, `packages/dashboard/package.json`, or `pnpm-lock.yaml`
- Add a changeset for this duplicate-resolution task
