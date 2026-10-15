---
title: Verify serialized prompt byte-stability after deploy (RUFU-267)
date: 2026-09-24
component: engine prompt composition / provider prefix caching
category: performance
module: packages/engine/src/execution/prompt-layers.ts
tags: [prompt-caching, prefix-cache, byte-stability, volatility, RUFU-267]
problem_type: performance
applies_when: A lane's system prompt starts carrying runtime-mutable state again, or cache-read tokens stop growing after the first requests of a session
symptoms:
  - Dashboard chat and engine lanes show cache-read tokens only for the first request of a session and ~0 afterwards
  - Cost per turn stays flat as a session gets longer instead of falling
  - Two consecutive requests of the same role share only the first ~0.8–2.8 KB of the system prompt
root_cause: Lanes rebuilt the serialized system prompt per request with volatile state inside it (retrieved memory bodies, live goal rows, rating summaries, per-card identity/policy, per-turn recall), so the cached prefix ended at the first volatile byte.
resolution_type: structural-composition-change-plus-static-guard
---

# Verify serialized prompt byte-stability after deploy

RUFU-267 moved runtime-mutable prompt content out of the serialized system prompt and onto the end of
each request. This runbook is what an operator runs **after deploying** to confirm the fix is real, in
increasing order of confidence: a guard that cannot be green by accident, then the byte-identity
assertions, then the observable cache-read numbers.

## 1. Static guard (fastest, must be green)

The guard is the durable part of the fix: lint, typecheck, build and the ordinary suites all stay green
when a prompt starts diverging per request, so a lane that re-adds volatile state can only be caught
structurally.

```bash
pnpm check:prompt-volatility      # standalone
node scripts/check-prompt-volatility.mjs
```

It must exit 0 and print no violations. It refuses four shapes:

1. A volatile field (`memorySection`, `goalContext`, `performanceFeedback`, `identitySection`,
   `policySections`, `recallSection`, `ratingsSection`, `steeringSection`) passed into
   `buildPromptLayers` / `buildSystemPromptWithInstructions` / `collapsePromptLayers`.
2. An interpolated (`` `…${x}…` ``) or identifier-joined value in a `systemPrompt:` slot — the shape that
   put a task id into the workflow-step head before.
3. A file that composes prompt layers **and** calls a volatile producer
   (`resolveAgentInstructionParts*`, `buildAgentChatPrompt*`, `retrieveMemory`, `resolveGoalContext`,
   `getRatingSummary`, …) without ever referencing a request-tail producer.
4. A **collapsed** instruction producer (`resolveAgentInstructions`, `resolveAgentInstructionsWithRatings`,
   `buildAgentChatPrompt`) whose result reaches a prompt-head slot — nested directly in a head-composition
   call, or held by a named binding that appears inside one. Head sinks are `buildPromptLayers`,
   `buildSystemPromptWithInstructions`, `collapsePromptLayers`, and any `*PromptLayers` / `*SystemPrompt` /
   `*PromptContext` seam. The collapsed forms return config-time bytes and runtime-mutable memory/rating
   bytes as one string, so the lane that resolved planner instructions this way shipped a system prompt that
   changed on every dispatch while rules 1-3 stayed silent — the head argument list never named the volatile
   fields. Use `resolveAgentInstructionPartsWithRatings` and route `memorySection` / `performanceFeedback` to
   the request tail.

It is part of the blocking gate chain (`test:gate:static`), and `pnpm test:gate` therefore runs it on every
PR; `scripts/__tests__/run-static-gate-checks.test.mjs` fails if it is ever dropped from that chain, and
`scripts/__tests__/check-prompt-volatility.test.mjs` fails if a rule stops matching anything — each rule has
a refusing case **and** a compliant case, so a neutered regex is a red test rather than an invisible guard.

Because the guard reads names and argument lists, a lane must not make its head seam unrecognisable to keep
it green. The matching convention on the test side is that a lane's byte-identity assertion drives the
**production** seam (e.g. `resolveTriagePlannerInstructions` + `buildTriagePromptContext` for planning), never
a re-typed literal: a test that assembles its own head cannot observe a caller that leaks volatile bytes.

## 2. Byte-identity suite (the acceptance contract)

```bash
pnpm --filter @fusion/engine exec vitest run \
  src/__tests__/prompt-byte-stability.test.ts \
  src/__tests__/prompt-layers.test.ts \
  src/__tests__/reviewer-prompt-layers.test.ts \
  src/__tests__/prompt-layers-backward-compat.test.ts \
  --silent=passed-only --reporter=dot
```

Each lane case builds the same role's prompt twice with the volatile state changed in between and asserts
`expect(second).toBe(first)` on the **serialized head**, then asserts the changed state still reaches the
model in the request tail. Both halves matter: a tail that is always empty would satisfy byte-identity
while silently dropping memory, goals, or ratings from the prompt.

Expected: all cases pass. A lane whose case goes red has reintroduced volatile bytes into its head — read
which block differs; the fix is to move that block into `buildRequestVolatileContext`, never to reorder it.

## 3. Observable cache reads (the thing the operator actually paid for)

Before the fix, the same defect measured as a divergence point 797–2,807 bytes into the serialized prompt
(chat 797, reviewer 1,612, triage 2,769, heartbeat 2,774, executor 2,807) — i.e. the cached prefix ended
almost immediately.

The planning lane needed a second measurement after code review, because its first one was taken through a
test-local literal head rather than the production caller, and the lane was in fact still leaking: resolved
through `resolveTriagePlannerInstructions` + `buildTriagePromptContext` with one planner whose memory file and
rating summary change between dispatches, the pre-fix head diverged at **byte 823** of 887 (887 → 944 bytes,
different SHA-256 prefixes), while the fixed head is **byte-identical** at 140 bytes with the same 747 bytes of
memory/rating content now on the request tail (804 → 861 characters across the two dispatches). Read that as
the general shape: the head stops moving, the volatile payload keeps moving, and nothing is dropped.

Watch the per-session token telemetry in the dashboard (task/agent run token usage, `cacheReadTokens`):

- **Expected after deploy:** the first request of a role pays full prompt cost; the second and later
  requests of the **same role and configuration** report `cacheReadTokens` ≈ the serialized system-prompt
  size, and cost per turn falls as the session grows.
- **Regression signature:** `cacheReadTokens` stays ≈ 0 on the second request of the same role, or drops to
  0 mid-session after a deploy that touched prompt composition.
- Expect the head to change **once** right after the upgrade (the composition itself changed bytes) and then
  stay put. A head that changes every turn is the old bug, not upgrade churn.
- Volatile refreshes are still visible in the transcript: the request now ends with a
  `## Session Context (runtime state, refreshed per request)` block carrying the memory/goal/rating/recall
  blocks. Its presence is correct and is what keeps behaviour identical while the head stops moving.

## 4. If a lane regresses

1. Run step 1 to identify the offending file/line, or bisect the lane's `buildPromptLayers` call site.
2. Move the volatile block into `buildRequestVolatileContext({ … })` and append with
   `appendRequestVolatileContext` / `withRequestVolatileContext` at **every** send site of that lane,
   including resume paths — a resume that skips the tail loses the state rather than restoring stability.
3. Keep the sentences identical; only byte position may change.
4. Add the lane's role to `src/__tests__/prompt-byte-stability.test.ts` if it is not covered yet, and
   confirm the new case fails before the fix and passes after.
