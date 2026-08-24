---
title: Prompt write read-back queries the task row
date: 2026-08-22
category: logic-errors
module: packages/engine/src/agent-tools.ts
problem_type: persistence_verification
symptoms: [prompt-write-false-failure, infinite-replanning]
applies_when: "A fail-closed mutation check compares a field stored outside the returned database row."
---

# Prompt write read-back queries the task row

## Symptom

Every `fn_task_prompt_write` call reported that the authoritative `PROMPT.md`
read-back could not be verified, even though the plan was immediately readable.
Planners correctly refuse to finish until the tool confirms persistence, so each
failed session was recovered as `needs-replan` and started another planning pass.

## Root cause

FN-094 added workspace repository-scope publication to the prompt-write path.
It retained the pre-write `getTask` needed for scope validation, then changed the
post-write check to inspect `updateTask`'s return value. That value is a
`project.tasks` row. `prompt` is filesystem-only: it is written to `PROMPT.md`
and only hydrated by `getTaskImpl`. The returned row therefore cannot prove the
write and has no `prompt` value to compare.

## Fix

After `updateTask` completes its single prompt-plus-scope mutation, read the
task again with `store.getTask(taskId)` and compare the hydrated prompt byte for
byte with the requested content. Missing, empty, changed, or unreadable
read-backs remain errors. Mirroring the verified plan to the project database
continues to be best-effort and occurs only afterwards.

## Rule

A mutation return value is not a read-back when the mutated field lives outside
that row. Repair fail-closed gates by correcting what they observe, never by
weakening their strictness. A false failure at a planning confirmation boundary
can amplify into an infinite replanning loop because the planner must treat an
unverified artifact as unsafe.

## Verification

- `packages/engine/src/__tests__/agent-document-tools.test.ts` covers exact,
  duplicate, workspace, missing, empty, altered, rejecting, and mirror-failure
  states.
- `packages/engine/src/__tests__/plan-prompt-write-surfaces.test.ts` covers
  triage/replanning, Plan Review, and reviewer-inline registration reachability.
