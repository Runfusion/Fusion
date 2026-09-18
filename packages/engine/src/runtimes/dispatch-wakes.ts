/*
FNXC:EventDrivenDispatch 2026-09-18-00:40:
FN-519 — one place that binds a runtime's existing consumers to the event signals that should wake
them, and one disposer list that unbinds them at stop.

Why a module instead of inline wiring in `InProcessRuntime.start()`: the runtime's constructor
attaches to the real project registry, so wiring written inline cannot be shown to subscribe or to
clean up. Every subscription here takes its consumer as an injected callback, so a test can prove
"the release signal reaches the continuation consumer" and "stop() unsubscribes" without building a
runtime. Losing the cleanup is not cosmetic: a leaked reservation-release listener holds a stopped
runtime's drain closure alive and wakes it for a project it no longer serves.

Everything wired here is ADVISORY. A wake decides WHEN an existing admission/drain pass looks, never
WHETHER a card may run: the pass itself re-applies pause, approval, dependency, lease, capacity, and
`autoMerge:false` gates. Periodic intervals are deliberately kept as the recovery backstop for a
lost notification or a crash — event-driven nominal flow is not the absence of repair.
*/

import { projectAdmissionCoordinator } from "../concurrency/concurrency.js";
import type {
  DispatchWakeEvent,
  DispatchWakeReason,
  DispatchWakeSignal,
  DispatchWakeTransport,
} from "@fusion/core";

export interface DispatchWakeWiringDeps {
  /**
   * The project this runtime serves, in the `ProjectAdmissionCoordinator`'s key space (the project
   * root directory). Reservation-release subscriptions use this key.
   */
  readonly projectId: string;
  /*
  FNXC:EventDrivenDispatch 2026-09-18-14:27:
  FN-519 — the dispatch-wake routing key, which is NOT necessarily the admission-coordinator key.
  Wake publishers (the store's local publish and the cross-process NOTIFY) name the project through
  `resolveDispatchWakeProjectKey`, which prefers the partition identity over the filesystem root
  because two processes of the same project share the former and never the latter. Subscribing under
  the root while publishers named the partition identity routed every remote wake to an empty key
  and left the 2 s periodic sweep as the only real trigger. Defaults to `projectId` so an unscoped
  store keeps today's behaviour.
  */
  readonly wakeProjectId?: string | undefined;
  /** Wake the durable workflow-continuation consumer (plan review, code review, resumed graphs). */
  readonly kickContinuations: () => void;
  /** Wake the execution-lane scheduler pass. */
  readonly kickScheduler: () => void;
  /** Wake planning discovery. */
  readonly kickPlanning: () => void;
  /** The advisory dispatch-wake signal published by the store, when the store exposes one. */
  readonly dispatchWake?: DispatchWakeSignal | undefined;
  readonly warn?: (message: string) => void;
}

/** A disposer bundle. Calling `dispose()` twice is a no-op. */
export interface DispatchWakeWiring {
  dispose: () => void;
  /** Test/diagnostic seam: how many subscriptions this wiring currently holds. */
  readonly subscriptionCount: number;
}

/**
 * Which consumers a given publication reason should wake.
 *
 * Deliberately narrow: a wake per token, log line, heartbeat, or bare lease renewal would turn an
 * advisory signal into a busy loop, which is the failure mode that makes people distrust
 * event-driven dispatch and go back to polling. Only reasons that can change ELIGIBILITY are
 * mapped, and each maps to the smallest set of consumers that can act on it.
 */
export function resolveWakeTargets(reason: DispatchWakeReason): {
  planning: boolean;
  scheduler: boolean;
  continuations: boolean;
} {
  switch (reason) {
    // A card entering/leaving a lane, or a create, changes what planning and execution may select.
    case "task-eligibility":
      return { planning: true, scheduler: true, continuations: true };
    // A durable continuation row appeared or became runnable: only its consumer can act.
    case "continuation":
      return { planning: false, scheduler: false, continuations: true };
    // Capacity, pause, and approval changes re-open every lane.
    case "capacity":
    case "settings":
      return { planning: true, scheduler: true, continuations: true };
    // A finished/released owner frees shared capacity and may unblock a deferred review.
    case "release":
      return { planning: true, scheduler: true, continuations: true };
    default:
      // An unknown reason from a newer publisher wakes the authoritative passes rather than being
      // dropped: a missed wake is a stall, while a spurious wake is one bounded no-op pass.
      return { planning: true, scheduler: true, continuations: true };
  }
}

/*
FNXC:EventDrivenDispatch 2026-09-18-14:27:
FN-519 — route a REMOTE wake onto this runtime's subscription key, without breaking project
isolation.

A notification is broadcast on one shared channel, so the payload's project id is the only thing
separating projects. This maps a delivery to the local subscription key ONLY when the payload names
an identity this runtime is known by (its wake key or its project root); anything else keeps the
foreign id, so the consumer's project-scoped subscription filters it out exactly as before. The
alias set is what makes a legacy `rootDir`-keyed publisher (an older peer process, or an unscoped
store) still reach this runtime instead of being silently dropped.
*/
export function resolveRemoteWakeProjectId(
  eventProjectId: string,
  identity: { readonly wakeProjectId: string; readonly aliases?: readonly string[] },
): string {
  if (eventProjectId === identity.wakeProjectId) return identity.wakeProjectId;
  if (identity.aliases?.some((alias) => alias.length > 0 && alias === eventProjectId)) {
    return identity.wakeProjectId;
  }
  return eventProjectId;
}

/*
FNXC:EventDrivenDispatch 2026-09-18-14:27:
FN-519 — the outbound transport for LOCAL task/settings publications.

The work-item writers publish their own NOTIFY inside the writing transaction, but canonical task
and settings publications had no outbound path at all: a card created or moved by the CLI, or a
settings change written by a second store, woke only that process and left every other engine on
its periodic sweep.

Discipline, and why each clause: publication is FIRE-AND-FORGET on the layer's existing pooled
handle (never a new connection, never the dedicated LISTEN session), and
`notifyDispatchWakeWithinTransaction` absorbs its own failures — so an unreachable database degrades
to a diagnostic and can never delay, fail, or roll back the mutation that published. The signal
itself refuses to transport a `remote` delivery, so two engines cannot bounce one wake forever.
*/
export function createDispatchWakeTransport(deps: {
  readonly execute: (query: unknown) => Promise<unknown>;
  readonly notify: (
    handle: { execute(query: unknown): Promise<unknown> },
    event: DispatchWakeEvent,
    warn?: (message: string) => void,
  ) => Promise<void>;
  readonly warn?: (message: string) => void;
}): DispatchWakeTransport {
  const handle = { execute: (query: unknown) => deps.execute(query) };
  return {
    publish: (event: DispatchWakeEvent) => {
      try {
        void deps.notify(handle, event, deps.warn).catch(() => undefined);
      } catch (error) {
        deps.warn?.(
          `Dispatch-wake transport publish failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

export function wireDispatchWakes(deps: DispatchWakeWiringDeps): DispatchWakeWiring {
  const disposers: Array<() => void> = [];
  let disposed = false;

  /*
  Reservation release: returning the last shared slot is the exact moment ANOTHER card becomes
  admissible, and that peer has no other owner — the departing lane only ran its own pass. The
  release signal is NOT a substitute for the planning-owner cleanup signal: a reservation can be
  returned before the owning session's `finally` has removed it from the live-owner sets, so the
  two are wired separately and both remain necessary.
  */
  disposers.push(
    projectAdmissionCoordinator.onReservationReleased(deps.projectId, () => {
      deps.kickPlanning();
      deps.kickScheduler();
      deps.kickContinuations();
    }),
  );

  if (deps.dispatchWake) {
    disposers.push(
      deps.dispatchWake.subscribe(deps.wakeProjectId ?? deps.projectId, (event) => {
        const targets = resolveWakeTargets(event.reason);
        if (targets.planning) deps.kickPlanning();
        if (targets.scheduler) deps.kickScheduler();
        if (targets.continuations) deps.kickContinuations();
      }),
    );
  }

  return {
    get subscriptionCount() {
      return disposed ? 0 : disposers.length;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const off of disposers) {
        try {
          off();
        } catch (error) {
          deps.warn?.(
            `Dispatch-wake disposer failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      disposers.length = 0;
    },
  };
}
