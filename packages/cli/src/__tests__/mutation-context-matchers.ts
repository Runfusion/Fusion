/*
FNXC:Identity 2026-08-09-03:04 (U18/KTD2 Stage D — the test-side assertion for the required context):

Stage D made the mutation context a real argument at 67 `@runfusion/fusion` call sites, so every
`toHaveBeenCalledWith` that pinned one of those calls now sees one more argument than it declared.

Deleting the trailing argument from the assertion, or relaxing the whole call to `expect.anything()`,
would leave the suite unable to tell an attributed write from an unattributed one — which is the only
thing this unit changed. So the assertions are EXTENDED instead: they pin the context too.

Mirrors `packages/engine/src/__tests__/mutation-context-matchers.ts` deliberately; two packages
asserting the same invariant with two different vocabularies is how one of them quietly stops
asserting it.
*/

import { expect } from "vitest";

/** A mutation context carrying some resolved actor — the minimum U18 guarantees at every call site. */
export const ANY_MUTATION_CONTEXT = expect.objectContaining({
  actor: expect.objectContaining({
    actor: expect.objectContaining({ id: expect.any(String) }),
  }),
});

/**
 * A mutation context attributed to a specific agent id. Prefer this wherever the CLI can derive a
 * real actor — today that is the pi extension's tool surface, where an `agent` principal resolved
 * from the session-identity registry produces genuine attribution.
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
 * The unattributed marker — assert this only where the call site is KNOWN to still be unwired: the
 * operator CLI (U11) and the daemon's PR-merge drain (U13). Asserting it is not the same as
 * tolerating it; it pins WHICH sites are still debt, so wiring one of them fails this assertion and
 * the census in the same commit.
 */
export const UNATTRIBUTED_CONTEXT_MATCHER = expect.objectContaining({
  actor: expect.objectContaining({
    actor: expect.objectContaining({ id: "system:unattributed" }),
  }),
});
