/*
FNXC:EventDrivenDispatch 2026-09-18-00:40:
FN-519 — the advisory dispatch-wake signal: "something that can change eligibility was published
for this project; the owning consumer should look now".

Contract, and the reason each clause exists:

- ADVISORY, NEVER AN AUTHORIZATION. A wake decides WHEN an existing admission/drain pass looks,
  never WHETHER a card may run. Every pause, approval, dependency, lease, capacity, and
  `autoMerge:false` gate still runs at the dispatch point. This is what keeps the signal safe to
  deliver from a cheap transport, and it is why the payload carries no permission of any kind.

- NOT A WORK QUEUE. The durable row (task, work item) stays the single source of truth; the signal
  never creates work and losing it can only delay, never lose. That is also why the periodic
  intervals stay: they are the recovery backstop for a lost notification, a reconnection, or a
  crash. Event-driven nominal flow is not the absence of repair.

- NOT A RE-EMISSION of `task:moved`/`task:updated`. Replaying those would re-run integrations, user
  notifications, and write side effects. This signal is a bare "look now" nudge and deliberately
  carries no task body.

- IDS AND BOUNDED ENUMS ONLY in the payload. A cross-process transport makes the payload visible to
  every user of the database, so it must never carry a prompt, a title, task content, a connection
  URL, or a secret. The `taskId` is optional precisely so a publisher with nothing safe to say can
  still wake the consumer.

- LOCALLY COALESCED. Publishers are per-mutation, consumers are per-pass, so a burst of identical
  publications must collapse into one delivery rather than one pass each; otherwise an import or a
  multi-card drag turns into a busy loop.

- LISTENER-ISOLATED. A throwing or rejecting subscriber cannot alter or fail the mutation that
  published, and a late-settling one cannot produce an unhandled rejection.
*/

/** Why a wake was published. Bounded on purpose: see `resolveWakeTargets` in the engine. */
export type DispatchWakeReason =
  /** A task was created, moved, or changed in a way that can change lane eligibility. */
  | "task-eligibility"
  /** A durable workflow continuation row was written or became runnable. */
  | "continuation"
  /** Shared capacity changed (a reservation returned, a limit raised). */
  | "capacity"
  /** Settings that gate admission changed (pause, engine pause, concurrency). */
  | "settings"
  /** An owner finished and released its ownership of a card. */
  | "release";

export interface DispatchWakeEvent {
  readonly projectId: string;
  readonly reason: DispatchWakeReason;
  /** Optional: publishers with nothing safe to name omit it. Never a title or any content. */
  readonly taskId?: string;
  /** True when this delivery arrived from another process rather than from a local publish. */
  readonly remote?: boolean;
}

export type DispatchWakeListener = (event: DispatchWakeEvent) => void;

/*
FNXC:EventDrivenDispatch 2026-09-18-14:27:
FN-519 — ONE routing key per project, resolved the same way by every publisher and every
subscriber.

This exists because the two sides were free to disagree, and did: the cross-process publisher named
the partition identity (`AsyncDataLayer.projectId`, e.g. `local-<sha256>`), while the runtime
subscribed under the filesystem root (`TaskStore.getRootDir()`). `publish` only notifies listeners
registered under the EXACT `event.projectId`, so every remote wake — including the engine's own
NOTIFY coming back — was routed to a key with no subscriber and silently dropped, leaving the 2 s
periodic relève as the real trigger. Resolving the key through this single function on both sides
is what makes a remote wake reach `kickContinuations`/`kickScheduler`/`kickPlanning`.

Preference order is deliberate: the partition identity is the only value that is the same in two
processes of the same project (their checkouts/worktrees differ), so it wins; `rootDir` is the
fallback for an unscoped (legacy/test) store that has no partition identity at all.
*/
export function resolveDispatchWakeProjectKey(identity: {
  readonly projectId?: string | null;
  readonly rootDir?: string | null;
}): string {
  const scoped = identity.projectId;
  if (typeof scoped === "string" && scoped.length > 0) return scoped;
  const root = identity.rootDir;
  return typeof root === "string" ? root : "";
}

/** A publishable, subscribable advisory wake channel. */
export interface DispatchWakeSignal {
  /** Subscribe for one project. Returns a disposer; calling it twice is a no-op. */
  subscribe(projectId: string, listener: DispatchWakeListener): () => void;
  /** Publish a wake. Never throws, never blocks the caller's mutation. */
  publish(event: DispatchWakeEvent): void;
  /** Number of live subscriptions for a project (diagnostics/tests). */
  subscriberCount(projectId: string): number;
  /** Release every subscription and pending delivery. */
  dispose(): void;
}

/**
 * Optional outbound transport, so a local signal can also reach other processes.
 *
 * Kept as a plain interface with no PostgreSQL types so `dispatch-wake.ts` stays transport-free and
 * a test can inject a controlled transport. Implementations MUST be non-blocking and MUST absorb
 * their own failures: a degraded transport is a diagnostic, never a mutation failure.
 */
export interface DispatchWakeTransport {
  publish(event: DispatchWakeEvent): void;
}

export interface CreateDispatchWakeSignalOptions {
  /** Called for every local publish, to fan the wake out to other processes. */
  readonly transport?: DispatchWakeTransport | undefined;
  readonly warn?: (message: string) => void;
  /** Injectable deferral so tests settle without a timer; defaults to `queueMicrotask`. */
  readonly defer?: (run: () => void) => void;
}

/**
 * Create an in-process advisory wake signal with per-(project, reason, taskId) coalescing.
 *
 * Coalescing key includes `taskId` so two different cards becoming eligible in the same turn both
 * reach the consumer — collapsing on project alone would let one card's wake swallow another's,
 * which is exactly the "lost signal" class this whole change exists to remove. Within one key a
 * burst collapses to a single delivery.
 */
export function createDispatchWakeSignal(
  options: CreateDispatchWakeSignalOptions = {},
): DispatchWakeSignal {
  const listeners = new Map<string, Set<DispatchWakeListener>>();
  const pending = new Map<string, DispatchWakeEvent>();
  const defer = options.defer ?? ((run: () => void) => queueMicrotask(run));
  let flushScheduled = false;
  let disposed = false;

  const keyOf = (event: DispatchWakeEvent) =>
    `${event.projectId}\u0000${event.reason}\u0000${event.taskId ?? ""}\u0000${event.remote ? "r" : "l"}`;

  const flush = (): void => {
    flushScheduled = false;
    if (disposed) {
      pending.clear();
      return;
    }
    const batch = [...pending.values()];
    pending.clear();
    for (const event of batch) {
      for (const listener of [...(listeners.get(event.projectId) ?? [])]) {
        try {
          /*
          A subscriber must never be able to break the mutation that published, so both a throw and
          a rejected promise are absorbed here. `void` on the result keeps a late-settling async
          listener from surfacing as an unhandled rejection.
          */
          const result = listener(event) as unknown;
          if (result && typeof (result as Promise<unknown>).catch === "function") {
            void (result as Promise<unknown>).catch((error: unknown) => {
              options.warn?.(
                `Dispatch-wake listener rejected: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
          }
        } catch (error) {
          options.warn?.(
            `Dispatch-wake listener failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  };

  return {
    subscribe(projectId, listener) {
      if (disposed) return () => undefined;
      const set = listeners.get(projectId) ?? new Set<DispatchWakeListener>();
      set.add(listener);
      listeners.set(projectId, set);
      let off = false;
      return () => {
        if (off) return;
        off = true;
        const live = listeners.get(projectId);
        if (!live) return;
        live.delete(listener);
        if (live.size === 0) listeners.delete(projectId);
      };
    },
    publish(event) {
      if (disposed || !event?.projectId) return;
      /*
      The transport runs on LOCAL publishes only. Re-publishing a remote delivery would make two
      engines bounce the same wake between them forever.
      */
      if (!event.remote && options.transport) {
        try {
          options.transport.publish(event);
        } catch (error) {
          options.warn?.(
            `Dispatch-wake transport publish failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      pending.set(keyOf(event), event);
      if (flushScheduled) return;
      flushScheduled = true;
      defer(flush);
    },
    subscriberCount(projectId) {
      return listeners.get(projectId)?.size ?? 0;
    },
    dispose() {
      disposed = true;
      listeners.clear();
      pending.clear();
    },
  };
}
