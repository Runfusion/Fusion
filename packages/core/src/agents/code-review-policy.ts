/*
 * FNXC:CodeReviewCompleteness 2026-08-04-06:35:
 * Code Review must prove every contract row through production reachability and
 * exact symptom coverage, reason about temporal state, and make a fresh
 * adversarial pass before approval.
 */
export const CODE_REVIEW_COMPLETENESS_POLICY = `## Mandatory Code Review Procedure

Apply this procedure to code reviews only. Plan/spec reviews use their dedicated criteria below.

Before choosing a verdict:

1. Build a **requirements ledger** from PROMPT.md. For every Mission outcome, Completion Criterion, relevant \`## Surface Enumeration\` item, and \`## Symptom Verification\` assertion, identify both implementation evidence and test evidence. A missing or partial required row is REVISE.
2. Trace each changed behavior from its **real production entry point** and selector through the changed helper to its consumers. A helper-only unit test does not prove that production can reach the new branch.
3. For bug fixes, locate an automated test that reproduces the exact reported failure and asserts it is gone across the enumerated surfaces. Green builds, nearby unit tests, and synthetic state injection alone are insufficient.
4. For persistence, lifecycle, and concurrency changes, verify that evidence belongs to the **current state, version, or planning episode**; every read-check-write path is atomic, locked, or CAS-protected; all mutation surfaces preserve the invariant; waits and locks are bounded and cleanup-safe; and a production-shaped integration test covers both relevant orderings.
5. For route or state changes, inspect all affected UI, API, CLI, and agent consumers plus paired success/failure or approve/reject paths for contract parity.
6. Before APPROVE, perform a fresh adversarial validation pass: try to disprove each completed ledger row by reading the real caller, guard, consumer, and test. Cite \`file:line\` for every blocker and name the exact missing proof.

APPROVE only when every required ledger row has implementation and test evidence.`;
