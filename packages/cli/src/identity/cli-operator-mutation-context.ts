/*
FNXC:Identity 2026-08-09-03:04 (U18/KTD2 Stage D — the CLI operator's actor is ONE open question):

Every `fn task …` / `fn pr …` command, and the operator branch of the pi extension's tool gates, write
to the store as the human sitting at the terminal. U18 makes those writes carry a mutation context;
U11 is the unit that gives that human a name (the CLI credential). Until it lands there is exactly one
unanswered question across the whole package — "who is the operator?" — so it is asked in exactly one
place rather than re-marked at each of the ~50 command call sites.

Why a single module and not a marker per call site:
  - The census is a WORK LIST. Fifty rows that all say "U11 must name the CLI operator" is one item
    written fifty times; it tells U11 nothing the first row did not, and it buries the CLI's genuinely
    distinct debts (the daemon PR-merge drain in `commands/task-lifecycle.ts`, which is a system sweep
    owned by U13, not an operator action) under noise.
  - It is the same shape Stage B used for the engine's tool factories: resolve once at the surface
    boundary, thread the value inward.

What this is NOT, and must not become:
  - It is NOT the bootstrap actor. A bootstrap write means "identity was off"; this means "the human
    at this terminal has no credential yet". Collapsing them makes an unwired command look like a
    genuine pre-enablement write and deletes U11's work list.
  - It is NOT a home for ambiguity. Where the CALLER is genuinely undecidable — two live agent
    sessions sharing one cwd, in `extension.ts` — the write is REFUSED, not marked. The marker says
    "a later unit fills this in"; ambiguity says "there are two candidates and we must not guess".
    Laundering the second into the first would hide a real safety stop inside ordinary deferred debt.
  - It must not be widened into "the context for any CLI write". A CLI path that runs unattended on a
    timer is not an operator action and keeps its own marker with its own owner.

U11: replace the body with the resolved CLI actor. The call sites do not change.
*/

import { UNATTRIBUTED_MUTATION_CONTEXT } from "@fusion/core";
import type { RunMutationContext } from "@fusion/core";

/**
 * The mutation context for a write made by the human operator running a `fn` command.
 *
 * Deliberately a function, not an exported constant: U11 resolves a real actor per invocation
 * (session credential, possibly per project), and a constant would have to become one anyway.
 */
export function cliOperatorMutationContext(): RunMutationContext {
  return UNATTRIBUTED_MUTATION_CONTEXT;
}
