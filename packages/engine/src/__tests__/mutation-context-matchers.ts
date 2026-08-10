/*
FNXC:Identity 2026-08-09-03:04 (U18/KTD2 Stage B — the test-side assertion for the required context):

Stage B made the mutation context a real argument at ~380 engine call sites, so every
`toHaveBeenCalledWith` that pinned one of those calls now sees one more argument than it declared.
Deleting the trailing argument from the assertion, or relaxing the whole call to `expect.anything()`,
would leave the suite unable to tell an attributed write from an unattributed one — which is the only
thing this unit changed.

So the assertions are EXTENDED instead: they now pin the context too.

- `ANY_MUTATION_CONTEXT` proves a context object with an actor reached the store. It rejects
  `undefined`, `null`, and a bare `{}`, so an un-threaded call site still fails the assertion.
- `mutationContextFor(agentId)` is the stronger form and is what a lane test should use: it pins the
  DERIVED actor, so re-marking a converted site (or attributing a merge to the triage lane) fails.
*/

import { expect } from "vitest";

/** A mutation context carrying some resolved actor — the minimum U18 guarantees at every call site. */
export const ANY_MUTATION_CONTEXT = expect.objectContaining({
  actor: expect.objectContaining({
    actor: expect.objectContaining({ id: expect.any(String) }),
  }),
});

/** A mutation context attributed to a specific agent/lane id. Prefer this in lane tests. */
export function mutationContextFor(agentId: string): unknown {
  return expect.objectContaining({
    agentId,
    actor: expect.objectContaining({
      actor: expect.objectContaining({ id: agentId }),
    }),
  });
}

/** The unattributed marker — assert this only where the call site is KNOWN to still be unwired. */
export const UNATTRIBUTED_CONTEXT_MATCHER = expect.objectContaining({
  actor: expect.objectContaining({
    actor: expect.objectContaining({ id: "system:unattributed" }),
  }),
});
