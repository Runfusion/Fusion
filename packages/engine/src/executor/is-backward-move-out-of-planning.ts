/**
 * FNXC:CodeOrganization 2026-08-04-06:20:
 * Host for isBackwardMoveOutOfPlanning requirement history (U4). The method body stays on
 * TaskExecutor so `check-inert-sync-lanes` keeps counting the two resolvePlannerLanes guards
 * in executor.ts — do not free-peel that body without re-proving the inert-sync baseline.
 *
 * FNXC:WorkflowLifecycleColumns 2026-07-30-16:55 (PR #2628 review, greptile P1):
 * THE FORWARD EXCLUSIONS MUST RESOLVE TOO, and leaving them literal made this branch WORSE
 * than before I touched it. With a role-aware source check and name-matched destinations, a
 * renamed board's ordinary FORWARD move (planning -> building) passed the source test and
 * matched none of the exclusions, so the evacuation fired on a card that was simply
 * advancing: it aborted live planning work and deleted the valid pre-execution worktree.
 * Before the conversion the source check failed and nothing happened; a half-conversion
 * turned a missed rescue into active damage. Third time this program has produced that
 * shape — gates converted, destinations left literal.
 *
 * Forward means the workflow's own wip, review, or complete lane. When a role is not
 * declared it cannot be a forward target, so it is simply not excluded.
 *
 * FNXC:WorkflowResolvedColumns 2026-07-31-23:59 (LANES COME FROM THE EMITTER — the sync resolver
 * is gone):
 * This took its lanes from `resolvePlannerLanes`, whose selection reader returns `undefined`
 * unconditionally under PostgreSQL, so it answered with the DEFAULT board for every task and both
 * its guards were INERT — counted by `check-inert-sync-lanes`, invisible to the census because
 * they already read as converted.
 *
 * The comment above said it had to be synchronous because the `task:moved` emitter is. That was
 * true and is no longer binding: the emitter now resolves the lanes ONCE, asynchronously
 * (`moves.ts` -> `resolveWorkflowIrForTask`), and hands them down on the payload. Reading a
 * parameter is as synchronous as reading `from`, so nothing is reordered and no listener resolves.
 *
 * `lanes` is REQUIRED rather than optional, deliberately. An optional parameter that the one
 * production caller happens to pass is the "seam with no supplier" shape this program keeps
 * finding — required means a future caller fails typecheck instead of silently falling back to a
 * default board. When the emitter itself could not resolve (`lanes` undefined on the payload), the
 * legacy ids answer, which is exactly what `resolvePlannerLanes` degraded to anyway.
 *
 * FNXC:WorkflowResolvedColumns 2026-07-31-23:59 (fallback CHANGED — adopting the better argument
 * from the duplicate PR #3140):
 * The payload is the real path and is preferred. The FALLBACK, for the case where the emitter could
 * not resolve, is the SYNC resolver rather than the legacy literals.
 *
 * Falling back to literals reads cleaner and drops these guards off `check-inert-sync-lanes` —
 * but it makes the NO-PAYLOAD path strictly WORSE, because `resolvePlannerLanes` is best-effort
 * (it answers correctly under legacy SQLite, and only degrades to the default board under
 * PostgreSQL) whereas a literal can never be right on a renamed board. Optimising the guard off a
 * ratchet at the cost of the degraded path is scoring the number.
 *
 * THESE TWO GUARDS STAY COUNTED by `check-inert-sync-lanes`, which is the honest state: the sync
 * call is still here, so the ratchet should still point at it. `executor.ts` goes 4 -> 2, from the
 * `isPlannerColumnFor` deletion, not from these.
 *
 * That took two corrections to get right, recorded because the intermediate state was wrong in a way
 * that looked authoritative. I predicted "stays counted", the gate reported ZERO, and I wrote the
 * under-reporting down as fact. It was a gate defect, not a property of this code: the scan
 * registered a sync local only from a direct call initializer and did not follow one through a
 * conditional (#3169) or through the object literal these lanes are rebuilt into (#3170). With both
 * hops followed the gate reports 2 here — the original prediction.
 *
 * The shape was deliberately NOT rewritten to whatever form the scanner recognised. Payload-first
 * with a sync fallback is correct on the merits, and a guard that pushes authors toward a worse
 * degraded path to keep its own count tidy is a guard doing harm — so the scanner was fixed instead.
 *
 * DELIBERATELY NOT ALSO EXCLUDING planner-to-planner moves. The literal version fired the
 * evacuation on `todo -> triage` (a replan rebound), and whether that is right is a separate
 * question from this review fix — the replan path is engine-initiated, so aborting the planning
 * session there may be exactly wrong, but changing it is a behavior change with its own
 * surfaces to enumerate. This conversion keeps that case behaving as it does today.
 */

export {};
