---
date: 2026-06-11
topic: validator-behavioral-verification
---

# Trustworthy "Done": Behavioral Verification in the Validator

## Summary

Make the done-gate require evidence of real behavior instead of trusting a diff's apparent intent. The Validator Run defaults to *fail* unless a behavioral or bug-fix assertion carries executable proof, and the gate gains a bounded verification run that actually exercises the code — runs the relevant tests, drives the app — to confirm the assertion before a Feature can count as done.

## Problem Frame

The Validator Run is the quality gate: an AI judge inspects a Feature's implementation and decides whether its Contract Assertions are met. By design it is read-only — it reads the diff and records a verdict, never executing anything.

That design is structurally weak for behavioral correctness. A bug-fix task was marked done after the judge accepted a diff that *looked* like a fix; the bug was still live in the running app. The judge graded the implementation's intent. Reality — the actual behavior — was never consulted. The behavioral truth existed (it was caught and captured by hand, manually testing the running app), but that truth never reached the verdict.

The cost shape: false-positive passes erode trust in "done" entirely. A gate that rubber-stamps can't be relied on, so every completed task inherits a manual re-check tax, which defeats the point of an automated gate.

## Key Decisions

- **Default to fail, not pass.** The judge's posture inverts: a behavioral/bug assertion is *not met* until there is crisp evidence it is. The judge's job becomes verifying that proof exists and is genuine, not reasoning about whether the code probably works.
- **Policy needs teeth — adversarial posture and executable verification ship together.** Raising the evidence bar alone (A) is insufficient, because a leniency-prone agent can also produce weak or fake proof. The gate must independently *execute* to observe behavior (B), not merely inspect the agent's claims more skeptically.
- **Verification is scoped to behavioral/bug assertions, not all assertions.** Static judging stays adequate for non-behavioral assertions; the bounded verification run is reserved for assertions whose truth is observable only by exercising the code, so execution cost is paid only where it buys correctness.
- **The verification run extends the validator's read-only invariant.** Confirming behavior requires running code, which the validator was explicitly forbidden from doing. This is an accepted, deliberate change to a documented design principle, bounded to a verification capability — the judge still creates no board task and edits no code.

## Actors

- A1. Coding agent — produces the implementation and, under the new posture, the executable proof (e.g., a regression test) that a behavioral/bug assertion is satisfied.
- A2. Validator Run (AI judge) — evaluates Contract Assertions; now defaults to fail on behavioral/bug assertions absent verified evidence.
- A3. Verification run — the bounded execution capability the gate invokes to exercise the code (run tests, drive the app) and observe real behavior.
- A4. Human / orchestrator — relies on a trustworthy "done"; previously the implicit fallback that caught escapes by manual testing.

## Requirements

### Judging posture

- R1. For behavioral and bug-fix assertions, the validator defaults to a fail verdict unless the assertion is backed by verified behavioral evidence.
- R2. The validator classifies each Contract Assertion as behavioral/bug (truth observable only by exercising the code) or non-behavioral (judgeable by inspection), and applies the stricter posture only to the former.
- R3. For non-behavioral assertions, existing static judging is preserved — the change does not raise cost or strictness where inspection already suffices.

### Behavioral verification

- R4. The gate can invoke a bounded verification run that exercises the code to confirm a behavioral/bug assertion's observable outcome before passing it.
- R5. For bug-fix assertions specifically, verification confirms the reported defect is no longer reproducible — not merely that a plausible change was made.
- R6. The verification run is bounded in time and cost, and a run that cannot complete or conclude resolves to a non-passing verdict (fail/blocked/error), never a default pass.
- R7. The verification run honors the validator's non-mutating boundary: it observes behavior but creates no board task and edits no code.

### Evidence and proof

- R8. A behavioral/bug assertion passes only when verification evidence corroborates it; an agent's narrative claim that the assertion is met is not, on its own, sufficient evidence.
- R9. When the agent supplies executable proof (e.g., a regression test that fails on the pre-fix state and passes on the implementation), the validator verifies the proof is genuine rather than accepting its presence at face value.
- R10. A non-passing verdict records why it failed in terms the downstream Fix Feature can act on (which assertion, what behavior was observed vs. expected).

## Key Flows

- F1. Bug-fix verification
  - **Trigger:** A bug-fix Feature reaches validation with a Contract Assertion of the form "defect X no longer occurs."
  - **Actors:** A2, A3
  - **Steps:** The judge classifies the assertion as behavioral (R2) and defaults it to fail (R1). It invokes a bounded verification run (R4) that reproduces the original defect against the implementation. If the defect no longer reproduces, the assertion passes; if it still reproduces, or verification cannot conclude, the assertion fails with a reason (R6, R10).
  - **Outcome:** "Done" reflects observed behavior, not diff intent.

- F2. Agent-supplied proof
  - **Trigger:** A behavioral assertion arrives with an agent-authored regression test as proof.
  - **Actors:** A1, A2, A3
  - **Steps:** The verification run executes the test (R9) and confirms it genuinely exercises the asserted behavior — failing on the pre-fix state and passing now. A weak or non-exercising test does not satisfy the assertion (R8).
  - **Outcome:** Honest proof accelerates a pass; fake or weak proof does not buy one.

- F3. Escape into the fix loop
  - **Trigger:** Verification returns fail/blocked for a behavioral assertion.
  - **Actors:** A2, A4
  - **Steps:** The Feature does not reach a passing Validator Run, so it does not count toward Slice completion; a Fix Feature carries the remediation, seeded with the recorded reason (R10).
  - **Outcome:** The false-pass path is closed; the work re-enters the loop instead of shipping wrong.

## Acceptance Examples

- AE1. Covers R1, R5. **Given** a bug-fix assertion "clicking Save no longer drops the form," **when** the diff changes Save handling but the bug still reproduces under verification, **then** the assertion fails and the Feature does not reach done.
- AE2. Covers R8. **Given** the agent's verdict narrative asserts the bug is fixed but supplies no executable proof and verification cannot confirm the behavior, **when** the judge evaluates the assertion, **then** it defaults to fail rather than accepting the narrative.
- AE3. Covers R3. **Given** a non-behavioral assertion ("the new flag is documented in the README"), **when** the judge evaluates it, **then** static inspection applies with no verification run and no added strictness.
- AE4. Covers R6. **Given** a verification run that exceeds its time/cost bound before concluding, **when** it is terminated, **then** the assertion resolves to a non-passing verdict, never a default pass.
- AE5. Covers R9. **Given** an agent-supplied test that passes both before and after the fix (so it never actually exercised the defect), **when** verification inspects it, **then** the proof is rejected and the assertion is not satisfied.

## Scope Boundaries

### Deferred for later

- The self-tightening gate (Approach C): caught escapes feeding back to harden the relevant assertion and seed a permanent check so the same bug class can't pass again. This is the compounding second move, built on top of A+B once they're in place.

### Outside this product's identity

- This work targets the "completes but wrong" failure mode for *behavioral correctness*. Off-target or low-quality work that isn't a behavioral/bug defect (e.g., a stylistically poor but functionally correct implementation) is not what this gate is being sharpened to catch.

## Dependencies / Assumptions

- Assumes a bounded execution environment is available to the verification run for exercising code and driving the app (the same behavioral-testing capability used to capture the manual proof today). Whether verification reuses existing worktree/session infrastructure is a planning decision.
- Assumes the accepted change to the read-only validator invariant is limited to a non-mutating verification capability — the validator continues to create no board task and edit no code (R7).
- A stricter gate will produce more failing verdicts and therefore more Fix Features and longer loops; this rework cost is accepted in exchange for a trustworthy "done."

## Outstanding Questions

### Deferred to planning

- How behavioral-vs-non-behavioral assertion classification is determined (assertion authoring convention, judge inference, or an explicit assertion field).
- What the verification run reuses for execution (test runner invocation, browser/app driving) and how its time/cost bounds are set.
- How an agent is expected to express executable proof so the judge can locate and run it.
