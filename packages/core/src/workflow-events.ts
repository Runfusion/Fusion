/*
FNXC:WorkflowEvents 2026-07-27-11:20 (U3 / R5, R6 — workflow-owned lifecycle):
THE post-commit lifecycle bus: one place transitions are announced, one registry
of subscribers. Later units move imperative cross-service calls behind it —
today `executor.ts` is 21k lines largely because it is the junction box every
lane routes its reactions through.

WHAT THIS BUS IS NOT. It is not a queue, not a transaction participant, and not
a delivery guarantee. Durable follow-on work uses the TRANSACTIONAL OUTBOX —
a `workflow_work_items` row written INSIDE the transition transaction (the shape
`createCompletionHandoffWorkflowWork` already uses). "Emit after commit, let a
subscriber enqueue the work" has a crash window: a process that dies between the
commit and the subscriber leaves no event AND no work-item row, so required work
is skipped permanently with nothing to recover from. Writing the item in the
transaction closes that window — a crash between commit and emit then costs at
most a notification.

Consequently EMISSION IS DELIBERATELY LOSSY AND ISOLATED:
  - a throwing subscriber is caught, logged, and cannot roll back the
    transition or stop the other subscribers;
  - a rejected async subscriber is caught the same way;
  - emission never blocks the caller's return, but events are DELIVERED IN
    COMMIT ORDER (see the serial chain below).

ORDERING. Subscribers may be async, so a naive `for (…) void fn(e)` would let a
slow subscriber on transition #1 interleave with transition #2. Every emit is
appended to a single promise chain, so subscriber invocations for two transitions
on one task run in the order the transitions committed. That property is what
lets a subscriber maintain derived state (a board projection, a counter) without
its own sequencing.

TESTABILITY. `emit` is fire-and-forget; `drain()` awaits the current chain so a
test can assert on delivery without polling. Production code must not await
`drain()` on a lifecycle path — doing so would make a subscriber able to slow a
transition, which is the coupling the bus exists to remove.
*/

import { createLogger } from "./logger.js";
import {
  findWorkflowEventShapeViolations,
  type WorkflowLifecycleEvent,
} from "./types/workflow-events.js";

const eventLog = createLogger("workflow-events");

/** A post-commit reaction. Must not perform a lifecycle transition (R5). */
export type WorkflowEventSubscriber = (event: WorkflowLifecycleEvent) => void | Promise<void>;

export interface WorkflowEventSubscription {
  /** Diagnostic name used in isolation warnings; defaults to "anonymous". */
  name?: string;
}

export interface WorkflowEventBus {
  /** Register a subscriber. Returns an unsubscribe function. */
  subscribe(subscriber: WorkflowEventSubscriber, options?: WorkflowEventSubscription): () => void;
  /** Announce a COMMITTED seam. Fire-and-forget; never throws. */
  emit(event: WorkflowLifecycleEvent): void;
  /** Await delivery of everything emitted so far. Test/shutdown seam only. */
  drain(): Promise<void>;
  /** Drop every subscriber. */
  clear(): void;
  subscriberCount(): number;
}

export function createWorkflowEventBus(): WorkflowEventBus {
  const subscribers = new Map<symbol, { fn: WorkflowEventSubscriber; name: string }>();
  // The serial delivery chain — see ORDERING above.
  let chain: Promise<void> = Promise.resolve();

  const deliver = async (event: WorkflowLifecycleEvent): Promise<void> => {
    // Snapshot: a subscriber that unsubscribes (or one registered) mid-delivery
    // must not mutate the iteration for the event already in flight.
    for (const { fn, name } of [...subscribers.values()]) {
      try {
        await fn(event);
      } catch (err) {
        /*
        FNXC:WorkflowEvents 2026-07-27-11:25 (U3 / R5):
        ISOLATION. Logged and swallowed — never rethrown. A subscriber is a
        reaction; letting one fail the emit would let a plugin's bug become a
        lifecycle fault, and the transition it is reacting to has ALREADY
        committed, so there is nothing left to roll back even if we wanted to.
        */
        eventLog.warn("workflow event subscriber threw (isolated)", {
          phase: "workflow-events:deliver",
          subscriber: name,
          eventType: event.type,
          taskId: event.taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  return {
    subscribe(subscriber, options) {
      const key = Symbol("workflow-event-subscriber");
      subscribers.set(key, { fn: subscriber, name: options?.name ?? "anonymous" });
      return () => {
        subscribers.delete(key);
      };
    },

    emit(event) {
      /*
      FNXC:WorkflowEvents 2026-07-27-11:30 (U3):
      The ids-only rule is enforced at the EMIT boundary, not at the subscriber,
      so a violating payload never reaches a plugin or a log sink. It degrades
      rather than throws: the emitter is on a post-commit path where throwing
      would surface a shape bug as a lifecycle failure. The test suite asserts
      the violation is DETECTED; production merely refuses to forward it.
      */
      const violations = findWorkflowEventShapeViolations(event);
      if (violations.length > 0) {
        eventLog.warn("workflow event dropped — payload is not ids/outcomes-only", {
          phase: "workflow-events:emit",
          eventType: (event as { type?: string })?.type,
          violations: violations.map((v) => `${v.path}:${v.reason}`),
        });
        return;
      }
      if (subscribers.size === 0) return;
      chain = chain.then(() => deliver(event));
    },

    drain() {
      return chain;
    },

    clear() {
      subscribers.clear();
    },

    subscriberCount() {
      return subscribers.size;
    },
  };
}

/*
FNXC:WorkflowEvents 2026-07-27-11:35 (U3):
Process-global default bus. The emitters (`moveTaskInternalImpl`, the graph's
column-boundary controller) are deep inside call paths with no place to thread a
bus handle, and the subscribers (engine lane services, plugins) register at
process start — the same shape as the existing `store.on/off` seam this bus
generalises. A per-store bus would need plumbing through every one of those call
sites for no isolation benefit: subscribers are already isolated from each other
and from the transition.

`resetWorkflowEventBusForTesting` exists so a suite cannot leak subscribers into
the next one; production must never call it.
*/
let globalBus: WorkflowEventBus | undefined;

export function getWorkflowEventBus(): WorkflowEventBus {
  globalBus ??= createWorkflowEventBus();
  return globalBus;
}

/** Emit onto the global bus. The single call the emitters use. */
export function emitWorkflowLifecycleEvent(event: WorkflowLifecycleEvent): void {
  getWorkflowEventBus().emit(event);
}

/** @internal test-only — drop all subscribers and reset the delivery chain. */
export function resetWorkflowEventBusForTesting(): void {
  globalBus = createWorkflowEventBus();
}
