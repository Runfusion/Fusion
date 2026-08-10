/*
FNXC:Identity 2026-08-09-03:04 (U18/KTD2):
The store's mutating methods take a `RunMutationContext`, not a bare `ActorContext` — the actor rides
INSIDE the run carrier, because `TaskLogEntry.runContext` is the row that is already persisted and
who-did-it belongs in the same row as which-run-did-it. So U18's call-site conversion needs two
constructors at the carrier level, and this module is where they live rather than `actor.ts`, which
must not depend on the task types.

Both are deliberately narrow, and the difference between them is the point of this unit:

- `mutationContextForAgent` produces a REAL actor. The agent id is genuine, only the run is unknown,
  so nothing here is a placeholder except `runId`.
- `UNATTRIBUTED_MUTATION_CONTEXT` produces NO actor. It is the greppable marker for a call site U18
  converted but could not attribute, and it is what U9 / U11 / U13 must delete as they land.
*/

import type { RunMutationContext } from "../types/task/task-log.js";
import { UNATTRIBUTED_ACTOR_CONTEXT, actorContextForAgent } from "./actor.js";

/*
FNXC:Identity 2026-08-09-03:04:
`"unknown"` and `"system"` are NOT invented here — they are the exact synthetic values the move and
delete audit paths already fall back to when no run context is supplied
(`internal.runContext?.runId ?? "unknown"`, `?.agentId ?? "system"` in task-store/moves.ts and
archive-lifecycle-2.ts). Reusing them is deliberate: converting a call site to the marker must not
silently change what the audit row says about the RUN, only what it says about the ACTOR, which is
the single field U18 exists to add. A new sentinel here would have rewritten thousands of existing
audit rows' agent attribution as a side effect of a mechanical conversion.
*/
export const UNATTRIBUTED_RUN_ID = "unknown";
export const UNATTRIBUTED_RUN_AGENT_ID = "system";

/**
 * FNXC:Identity 2026-08-09-03:04:
 * The U18 marker carrier: "this call site has not yet been given a real actor; the unit that owns
 * this surface must replace it."
 *
 * Never substitute the bootstrap context for it. The bootstrap actor MEANS something — a write made
 * while `identity.enabled` was off, distinguishable in audit from a post-enablement write. Using it
 * for an unwired call site would make the seam report as fully attributed while attributing nothing,
 * and would leave U9/U11/U13 with no way to find their own work. That is the failure mode
 * `docs/solutions/architecture-patterns/resolved-seams-nobody-wired.md` documents.
 *
 * Counted by `packages/core/src/__tests__/unattributed-actor-census.test.ts`, which ratchets DOWN.
 */
export const UNATTRIBUTED_MUTATION_CONTEXT: RunMutationContext = {
  runId: UNATTRIBUTED_RUN_ID,
  agentId: UNATTRIBUTED_RUN_AGENT_ID,
  actor: UNATTRIBUTED_ACTOR_CONTEXT,
};

/**
 * FNXC:Identity 2026-08-09-03:04:
 * Build a mutation context for a write whose acting AGENT is genuinely known but whose run is not —
 * the shape of most `AgentStore` checkout/assignment writes, where `agentId` is a parameter of the
 * calling method.
 *
 * This is NOT the marker: prefer it wherever an agent id is in scope, because it produces real
 * attribution and keeps the census honest. The one trap is direction — use the agent that is DOING
 * the write, never the agent being written ABOUT. `deleteAgent` and `forceReleaseTask` both have an
 * agent id in scope that names their target, and attributing those writes to it would produce an
 * audit row claiming an agent unassigned or evicted itself.
 */
export function mutationContextForAgent(agentId: string, runId?: string): RunMutationContext {
  return {
    runId: runId ?? UNATTRIBUTED_RUN_ID,
    agentId,
    actor: actorContextForAgent(agentId),
  };
}
