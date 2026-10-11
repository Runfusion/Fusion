import type { Logger } from "../logger.js";
import { createRepeatSuppressedLog } from "../util/repeat-suppressed-log.js";

/*
FNXC:FinalizationRefusalBounded 2026-10-07-09:10 (RUFU-431):
`recordFinalizationAudit` documented "one row per (task, gate, refusal)" (RUFU-370) but nothing
enforced it: the auto-merge sweep re-attempts a blocked finalization on every pass, so a card whose
required post-merge gate cannot report re-emitted the same terminal refusal forever. Measured one
calendar day: 5,356 refusal rows for 7 cards; re-measured 2026-10-07 on saneca SANE-520 — 4 rows /
4 min, and the identical pair of `store.logEntry` calls per pass in `project-engine.ts` (the
merge-confirmed fast path) rolls the per-task activity log through its 1,000-entry retention cap.

The log roll is the damage, not the noise. RUFU-452 counts verdict-less-gate re-run strikes by
scanning markers in that very log, so rotation silently erases the budget: SANE-507 showed 0
`[verdictless-gate-rerun]` markers against ~30 real re-runs and VLLM-065 retried every ~20 s. A
refusal that is re-stated forever therefore also *disarms the guard meant to bound it*. Measured on
2026-10-07, one saneca card alone produced 61 refusal rows in 30 minutes.

Decision rule: a refusal is a STATE, so it is recorded on the transition into that state —
(task, refusal type, reason). Anything that changes the reason (including a gate that finally
reports, or a new blocker) is a transition and is recorded again. Terminal outcomes are never
bounded here: `…-column-mismatch-reconciled` and every successful finalization is a real state
change and always writes its row.

FNXC:FinalizationRefusalBounded 2026-10-11-05:43 (RUFU-386):
The RUFU-431 sweep covered only the surfaces that shared `recordFinalizationAudit`, so the `recover-merged-review`
maintenance lane — a second writer of the same blocked-finalization sentence, through its own
`store.logEntry` call in `self-healing.ts` — stayed unbounded and kept rolling its card's activity log once per
maintenance pass. This module is now the whole obligation for BOTH writers: every engine lane that can re-state a
merge-confirmed finalization outcome passes through `noteFinalizationPass` on a lane-owned slot, and a new lane must
register its slot in `clearFinalizationNotice`. The completeness check is a grep for the refusal vocabulary, not a
memory of which lanes exist.
*/

/** Shared instance; keys are prefixed per surface so the audit and task-log keyspaces cannot collide. */
const finalizationNotice = createRepeatSuppressedLog();

/**
 * `logOnce` always emits (at `debug()` when suppressed). The audit-only decision path has no line to
 * write, so it logs through this sink and keeps the decision as its only output.
 */
const SILENT_LOGGER: Logger = { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} };

/** Audit-mutation types that restate a refusal with no state change, and are therefore bounded. */
const BOUNDED_REFUSAL_TYPES: ReadonlySet<string> = new Set([
  "task:auto-merge-finalize-column-mismatch-no-action",
  "task:auto-merge-finalize-post-merge-gate-unreachable",
]);

/** True when `type` restates a refusal rather than recording a state change. */
export function isBoundedFinalizationRefusal(type: string): boolean {
  return BOUNDED_REFUSAL_TYPES.has(type);
}

/**
 * May this refusal be written as an audit row?
 *
 * @returns `true` the first time (taskId, type, reason) is seen, or after any of the three changes.
 * `false` means the same refusal was already recorded for this card — write nothing.
 */
export function shouldRecordFinalizationRefusal(taskId: string, type: string, reason: string): boolean {
  // A `|` cannot appear in a mutation type, so the keyspace cannot be forged by a crafted reason.
  return finalizationNotice.logOnce(
    SILENT_LOGGER,
    `audit|${taskId}|${type}`,
    reason,
    "",
  );
}

/**
 * Report one finalization pass and gate its durable task-log write on the same decision.
 *
 * `slot` keeps the surfaces that report a finalization pass on separate keys, because two writers over
 * one card must not read as a transition against each other: the merge-confirmed fast path uses
 * `fast-path-attempt` ("the fast path ran") plus `fast-path-outcome` ("it was refused, because X"), and
 * the `recover-merged-review` self-healing lane uses `self-heal-outcome`. Two alternating messages
 * sharing one key would look like a state change on every pass — the churn this gate exists to stop.
 *
 * The caller owns what counts as news inside its own slot, so `signature` is deliberately opaque:
 * self-healing qualifies its signature with the arm it took (`resumed|<reason>` vs `blocked|<reason>`)
 * because its refusal sentence alone cannot tell a reseed that advanced the card from one that stopped
 * advancing it.
 *
 * @returns `true` when the message was logged at `level` — the caller may then append its
 * `store.logEntry` row. `false` means this pass restates a known state: the message went to
 * `debug()` and the per-task log must not grow.
 */
export function noteFinalizationPass(
  logger: Logger,
  taskId: string,
  slot: string,
  signature: string,
  message: string,
  level: "log" | "warn" = "log",
): boolean {
  return finalizationNotice.logOnce(logger, `pass|${taskId}|${slot}`, signature, message, level);
}

/**
 * Forget a card's finalization state so a later refusal is reported afresh (card left the lane / tests).
 *
 * Enumerates every slot key this module can own, so a new writer's slot must be added here. The function
 * itself has NO production caller today — `finalizeAlreadyMergedTask` is not one, and no lane exit calls
 * this — so treat it as test/reset-facing and do not describe any lane as having a reset path. That is a
 * no-op rather than a bug because the gate holds no lifecycle authority: a stale `self-heal-outcome`
 * signature can only ever suppress the repeat of the same sentence, never a refusal the card has not
 * already had written, and `resetFinalizationNoticeState` covers the process boundary. Wiring a clear
 * into a lane exit is a behavior change to that lane, not this module's call, so it was left out of
 * RUFU-386.
 */
export function clearFinalizationNotice(taskId: string): void {
  finalizationNotice.clear(`pass|${taskId}|fast-path-attempt`);
  finalizationNotice.clear(`pass|${taskId}|fast-path-outcome`);
  finalizationNotice.clear(`pass|${taskId}|self-heal-outcome`);
  // The audit keyspace is exactly (bounded type × this card); a refusal type outside the bounded set
  // never created a key here, so enumerating the set clears every key this module can own.
  for (const type of BOUNDED_REFUSAL_TYPES) finalizationNotice.clear(`audit|${taskId}|${type}`);
}

/** Test-only: drop all remembered finalization state. */
export function resetFinalizationNoticeState(): void {
  finalizationNotice.reset();
}
