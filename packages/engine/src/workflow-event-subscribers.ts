/*
FNXC:WorkflowEvents 2026-07-27-12:20 (U3 / R5 — workflow-owned lifecycle):
The ENGINE side of the post-commit lifecycle bus: where lane services register
their reactions to a committed transition, and the boundary that later units move
imperative cross-service calls across.

The problem this exists to solve: today, when a task transitions, every service
that must react — notify, wake an agent, refresh a board, enqueue follow-on work —
is invoked DIRECTLY from the transition site. That is the main reason
`executor.ts` is 21k lines; it is the junction box every lane routes through.
Registering a reaction here instead means the transition site does not know its
reactors exist.

THE ADMISSION RULE for anything registered here — a handler that violates it is a
bug even if its tests pass:

  1. It must not perform a lifecycle transition. The graph decides placement; a
     subscriber that moves a card is a second authority, which is the failure
     mode (FN-8504, the done-laundering incident) this program removes.
  2. It must be safe to skip. Delivery is fire-and-forget and a process can die
     between commit and emit. If skipping the handler loses a unit of work, the
     work belongs in the TRANSACTIONAL OUTBOX — a `workflow_work_items` row
     written inside the transition transaction — and this handler should at most
     nudge the worker that drains it.
  3. It must tolerate being called for a transition it does not care about, and
     must not throw. Throws are caught and logged by the bus, but a handler that
     routinely throws is a handler that routinely does nothing.

Registration is process-scoped and idempotent: `registerWorkflowEventSubscribers`
tears down anything it registered before re-registering, so an engine restart or
a test re-init cannot double-deliver.

STARTING EMPTY IS DELIBERATE. U3 lands the seam and its invariants; U7/U8/U10
move real reactions (triage's column wake, board refresh, agent wake) onto it,
each with the characterization tests that prove the reaction was non-authoritative
before it moved. Landing the seam pre-populated would mean converting reactions
in the same commit that introduces the mechanism they rely on.
*/

import {
  getWorkflowEventBus,
  type WorkflowEventSubscriber,
  type WorkflowLifecycleEvent,
} from "@fusion/core";

/** A named engine-side reaction to a committed lifecycle seam. */
export interface WorkflowEventSubscriberRegistration {
  /** Diagnostic name; appears in the bus's isolation warnings. */
  name: string;
  /** Event types this reaction handles. Others are not delivered to it. */
  types: readonly WorkflowLifecycleEvent["type"][];
  handle: (event: WorkflowLifecycleEvent) => void | Promise<void>;
}

/** Unsubscribe functions for the currently-registered set. */
let active: Array<() => void> = [];

/**
 * Register the engine's post-commit reactions on the global bus. Idempotent —
 * a second call replaces the first registration rather than adding to it.
 *
 * Returns an unsubscribe function for symmetry with the bus API; callers that
 * hold the engine for a process lifetime can ignore it.
 *
 * FNXC:WorkflowEvents 2026-07-27-15:30 (U3, PR #2467 review):
 * The returned cleanup is scoped to THIS registration, not to the module. It
 * previously returned `unregisterWorkflowEventSubscribers`, so a stale handle
 * from an earlier call would silently unsubscribe a LATER registration's set —
 * an engine restart followed by a deferred cleanup would leave the process with
 * no reactions and no error. A per-call closure makes a stale cleanup a no-op
 * instead.
 */
export function registerWorkflowEventSubscribers(
  registrations: readonly WorkflowEventSubscriberRegistration[] = ENGINE_WORKFLOW_EVENT_SUBSCRIBERS,
): () => void {
  unregisterWorkflowEventSubscribers();
  const bus = getWorkflowEventBus();
  const mine = registrations.map((registration) => {
    const subscriber: WorkflowEventSubscriber = (event) => {
      // Type filtering lives here rather than in the bus so the bus stays a
      // dumb fan-out and a handler's declared interest is visible at its
      // registration site.
      if (!registration.types.includes(event.type)) return;
      return registration.handle(event);
    };
    return bus.subscribe(subscriber, { name: registration.name });
  });
  active = mine;
  return () => {
    for (const off of mine) off();
    // Only clear the module handle when it still points at THIS registration,
    // so a stale cleanup cannot blank a newer one's bookkeeping.
    if (active === mine) active = [];
  };
}

/** Drop every subscriber this module registered. Safe to call when none are. */
export function unregisterWorkflowEventSubscribers(): void {
  for (const off of active) off();
  active = [];
}

/** Count of currently-registered engine subscribers (diagnostics/tests). */
export function activeWorkflowEventSubscriberCount(): number {
  return active.length;
}

/**
 * The engine's default reaction set. Empty by design in U3 — see the module
 * header. Each later unit appends the reaction it converts, with the
 * characterization test proving it was non-authoritative beforehand.
 */
export const ENGINE_WORKFLOW_EVENT_SUBSCRIBERS: readonly WorkflowEventSubscriberRegistration[] = [];
