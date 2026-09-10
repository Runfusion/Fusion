/*
FNXC:Identity 2026-08-09-03:04 (U18/KTD2 Stage D — the test-side assertion for the required context):

Stage D made the mutation context a real argument at 151 `@fusion/dashboard` call sites, so every
`toHaveBeenCalledWith` that pinned one of those calls now sees one more argument than it declared.

Deleting the trailing argument from the assertion, or relaxing the whole call to `expect.anything()`,
would leave the suite unable to tell an attributed write from an unattributed one — which is the only
thing this unit changed. So the assertions are EXTENDED instead: they pin the context too.

Mirrors the engine's and the CLI's copies deliberately; three packages asserting the same invariant
with three different vocabularies is how one of them quietly stops asserting it.
*/

import { expect } from "vitest";

/** A mutation context carrying some resolved actor — the minimum U18 guarantees at every call site. */
export const ANY_MUTATION_CONTEXT = expect.objectContaining({
  actor: expect.objectContaining({
    actor: expect.objectContaining({ id: expect.any(String) }),
  }),
});

/**
 * A mutation context attributed to a specific agent id. Nothing in `@fusion/dashboard` derives one
 * yet — the dashboard's actor is the authenticated session and arrives with U9 — so this exists for
 * U9 to assert against the moment it does, rather than being added under time pressure later.
 */
export function mutationContextFor(agentId: string): unknown {
  return expect.objectContaining({
    agentId,
    actor: expect.objectContaining({
      actor: expect.objectContaining({ id: agentId }),
    }),
  });
}

/**
 * The unattributed marker — every dashboard write is still unwired, so this is the matcher these
 * suites use today. Asserting it is not the same as tolerating it: it pins WHICH sites are debt, so
 * wiring one fails this assertion and the census in the same commit rather than silently passing.
 */
export const UNATTRIBUTED_CONTEXT_MATCHER = expect.objectContaining({
  actor: expect.objectContaining({
    actor: expect.objectContaining({ id: "system:unattributed" }),
  }),
});
