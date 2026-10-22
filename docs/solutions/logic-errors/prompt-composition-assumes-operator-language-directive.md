---
category: logic-errors
module: "@fusion/engine prompt-section composition (workflow steps, triage planner, heartbeat)"
problem_type: logic_error
component: prompt-composition
tags:
  - operatorLanguage
  - prompt-composition
  - total-function
  - AnyFn-type-hole
  - engine
applies_when:
  - "A workflow step (plan review, code review, browser verification, completion summary) fails with `TypeError: Cannot read properties of undefined (reading 'trim')`"
  - "A project that never configured an operator language cannot complete any prompt-building step"
  - "Adding an optional section to any lane's prompt composition"
  - "Reviewing a change that joins prompt sections with `.filter((x) => x.trim())`"
---

# Prompt-section composition assumed an operator-language directive is always a string

## Symptom

Every prompt-bearing workflow step dies inside prompt assembly and the step never completes:

```
Plan Review failed before producing a verdict: Cannot read properties of undefined (reading 'trim')
  | at file:///app/packages/cli/dist/bin.js:296812:100
  | at Array.filter (<anonymous>)
  | at runOnce (file:///app/packages/cli/dist/bin.js:296812:72)
  | at async executeWorkflowStep (file:///app/packages/cli/dist/bin.js:297392:26)
```

Measured on rtm3 production (read-only, 2026-10-22): 28 cards carried the sentence in
`workflowStepResults`, 153 mirrored sentences across the board mirrors, `operatorLanguage: "auto"` on the
kubernetes/aml/mw projects **and** globally, and fresh failures after the 14:42Z roll (KUBE-028 `completedAt`
15:06:05Z, KUBE-052 15:06:22Z, 15 `priorAttempts` each). The planning lane therefore re-seeded cards forever
until RUFU-768's cycle ceiling parked them, and the review lane inherited the same verdict-less gates.

Before RUFU-772/RUFU-773 landed the throw site, the persisted row carried only `error.message`, which is why
75 victims existed and none of them named a frame. The stack-capture patch is what made this class findable.

## Root cause

`buildOperatorLanguageDirective(settings)` is a total function returning `string | undefined`: unset, empty,
whitespace-only and `"auto"` all legitimately emit **no directive** — and `DEFAULT_PROJECT_SETTINGS.operatorLanguage`
**is** `"auto"`, so the shipped default was exactly the crash value. Six prompt-section joins then dereferenced
`.trim()` straight off the array element:

```ts
// packages/engine/src/executor/execute-workflow-step.ts:960 (the live one)
[stepInstructionParts.configTime, stepOperatorLanguageDirective].filter((section) => section.trim())
```

An absent directive is a valid configuration, not a missing value. The composition was simply not total over it.

**Why `tsc` could not catch it.** `resolveInstructionPartsForRole` is declared `AnyFn` in the executor deps bag
(`packages/engine/src/executor/deps-bags.ts`), so `stepInstructionParts` is `any`, the array literal widens to
`any[]`, and `.trim()` on a `string | undefined` element typechecks clean. Five of the six sites were latent for
the same reason: their element types were `string` *today*, so nothing pointed at the join.

## Fix

Adopt the repo's already-canonical nullish predicate (`packages/engine/src/execution/prompt-layers.ts:179`,
`part?.trim()`) at all six join sites. No helper extraction, no new abstraction, no signature change:
`buildOperatorLanguageDirective` still returns `string | undefined`, `DEFAULT_PROJECT_SETTINGS.operatorLanguage`
stays `"auto"`, and the predicate only **drops** sections — it never reorders or rewords, so the serialized bytes
for a configured language are unchanged (the RUFU-267 contract).

The fixed sites:

| site | lane |
| --- | --- |
| `executor/execute-workflow-step.ts` | workflow-step sessions (plan review, code review, browser verification, completion summary) — the live crash |
| `triage.ts` (`buildTriagePromptLayers` agent instructions) | planner prompt head |
| `triage.ts` (`policySections`) | planner duplicate-policy + dependency instruction join |
| `agent-heartbeat.ts` (role-instruction parts collapse) | heartbeat wake |
| `executor/resolve-instructions-for-role.ts` | role instruction collapse |
| `executor/system-prompt.ts` | executor base-prompt section join |

Deliberately **not** touched: `execution/prompt-layers.ts` and `agents/agent-instructions.ts` (already
nullish-tolerant — the shape being reused), `executor/run-verification-tool.ts:607` (filters over
guaranteed-`string` params with `part.trim().length > 0`; not this defect), and the test-side predicate in
`__tests__/prompt-layers-backward-compat.test.ts`.

## Invariant

**Prompt-section composition never dereferences a method on a possibly-absent section, and an absent
operator-language directive is a valid configuration.**

Pinned by two tests, both proven red before green:

- `packages/engine/src/__tests__/workflow-step-operator-language-totality.test.ts` drives the real
  `executeWorkflowStep(task, step, worktree, settings, …)` seam over `{}`, empty string, whitespace, and
  `"auto"`, plus a configured `"sk"`, an unknown code, and a re-entry (resume-shaped) call. No fixture names a
  language to make a case pass — that would mask the production crash. Byte-identity is asserted as
  "the nullish prompt is a byte-exact prefix of the configured one and the only added tail is the
  `## Custom Instructions` wrapper plus the directive".
- `packages/engine/src/__tests__/prompt-composition-nullish-sites.test.ts` ratchets the two exact non-total
  literals out of production sources under `packages/engine/src` (a code-construct guard, `__tests__` excluded,
  deliberately not a loose `part.trim` substring).

## Adjacent harness defect the fix exposed

`__tests__/executor-test-helpers.ts` mocks the whole `execution/step-session-executor.js` module and never
gained `workflowStepTaskIdentityLine` (added by RUFU-267), because every case in that harness had been throwing
one statement earlier. 12 cases in `executor-browser-verification.test.ts` were failing on the nullish directive
and, once that was fixed, on the missing mock export. Both are repaired at the shared helper, not per test.
