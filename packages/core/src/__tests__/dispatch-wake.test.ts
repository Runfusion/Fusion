import { describe, expect, it, vi } from "vitest";

import { createDispatchWakeSignal, resolveDispatchWakeProjectKey } from "../dispatch-wake.js";
import type { DispatchWakeEvent } from "../dispatch-wake.js";
import { TaskStore } from "../store.js";

/*
FNXC:EventDrivenDispatch 2026-09-18-00:40:
FN-519 — contract tests for the advisory dispatch-wake signal. Each case pins one clause of the
contract documented on the module, because every clause exists to stop a specific failure:

- coalescing keyed on (project, reason, taskId) so two cards cannot swallow each other's wake,
  which is the "lost signal" class this whole change removes;
- project scoping so a second project's engine is never woken (cross-project admission);
- listener isolation so a throwing/rejecting subscriber cannot break or fail the publishing
  mutation, and a late rejection cannot surface as an unhandled rejection;
- a transport that fires on LOCAL publishes only, so two engines cannot bounce one wake forever;
- a transport failure that degrades to a diagnostic rather than a mutation failure;
- ids/bounded-enums-only payloads, since a cross-process transport makes them visible to every
  database user.

Settling is a controlled deferral (`defer`), never a timer: a case that needed a clock would be
proving a periodic backstop rather than the event path.
*/

function harness(options: Parameters<typeof createDispatchWakeSignal>[0] = {}) {
  const queue: Array<() => void> = [];
  const warnings: string[] = [];
  const signal = createDispatchWakeSignal({
    defer: (run) => queue.push(run),
    warn: (message) => warnings.push(message),
    ...options,
  });
  return {
    signal,
    warnings,
    /** Run every scheduled flush, including flushes scheduled by a flush. */
    drain() {
      for (let guard = 0; guard < 20 && queue.length > 0; guard++) {
        const batch = queue.splice(0, queue.length);
        for (const run of batch) run();
      }
    },
    pendingFlushes: () => queue.length,
  };
}

const event = (overrides: Partial<DispatchWakeEvent> = {}): DispatchWakeEvent => ({
  projectId: "/p/a",
  reason: "task-eligibility",
  ...overrides,
});

describe("createDispatchWakeSignal", () => {
  it("delivers a published wake to the project's subscribers", () => {
    const h = harness();
    const seen: DispatchWakeEvent[] = [];
    h.signal.subscribe("/p/a", (e) => seen.push(e));

    h.signal.publish(event({ taskId: "FN-1" }));
    expect(seen).toEqual([]); // deferred, so a publisher's mutation is never behind a listener
    h.drain();

    expect(seen).toEqual([{ projectId: "/p/a", reason: "task-eligibility", taskId: "FN-1" }]);
  });

  it("coalesces identical publications into one delivery", () => {
    const h = harness();
    const seen: DispatchWakeEvent[] = [];
    h.signal.subscribe("/p/a", (e) => seen.push(e));

    for (let i = 0; i < 50; i++) h.signal.publish(event({ taskId: "FN-1" }));
    h.drain();

    expect(seen).toHaveLength(1);
  });

  it("keeps distinct cards and distinct reasons separate, so no wake swallows another", () => {
    const h = harness();
    const seen: DispatchWakeEvent[] = [];
    h.signal.subscribe("/p/a", (e) => seen.push(e));

    h.signal.publish(event({ taskId: "FN-1" }));
    h.signal.publish(event({ taskId: "FN-2" }));
    h.signal.publish(event({ taskId: "FN-1", reason: "continuation" }));
    h.drain();

    expect(seen.map((e) => `${e.reason}:${e.taskId}`).sort()).toEqual([
      "continuation:FN-1",
      "task-eligibility:FN-1",
      "task-eligibility:FN-2",
    ]);
  });

  it("never delivers across projects, even for the same task id", () => {
    const h = harness();
    const a: string[] = [];
    const b: string[] = [];
    h.signal.subscribe("/p/a", () => a.push("a"));
    h.signal.subscribe("/p/b", () => b.push("b"));

    // The same task ID can legitimately exist in two PostgreSQL partitions.
    h.signal.publish(event({ projectId: "/p/a", taskId: "FN-1" }));
    h.drain();

    expect(a).toEqual(["a"]);
    expect(b).toEqual([]);
  });

  it("isolates a throwing subscriber from its peers and from the publisher", () => {
    const h = harness();
    const seen: string[] = [];
    h.signal.subscribe("/p/a", () => { throw new Error("listener exploded"); });
    h.signal.subscribe("/p/a", () => seen.push("peer"));

    expect(() => h.signal.publish(event())).not.toThrow();
    expect(() => h.drain()).not.toThrow();
    expect(seen).toEqual(["peer"]);
    expect(h.warnings.some((w) => w.includes("listener failed"))).toBe(true);
  });

  it("absorbs a rejecting async subscriber without an unhandled rejection", async () => {
    const h = harness();
    h.signal.subscribe("/p/a", async () => { throw new Error("async boom"); });

    h.signal.publish(event());
    h.drain();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.warnings.some((w) => w.includes("listener rejected"))).toBe(true);
  });

  it("stops delivering after the subscriber is disposed, and disposal is idempotent", () => {
    const h = harness();
    const seen: string[] = [];
    const off = h.signal.subscribe("/p/a", () => seen.push("x"));
    expect(h.signal.subscriberCount("/p/a")).toBe(1);

    off();
    off();
    expect(h.signal.subscriberCount("/p/a")).toBe(0);

    h.signal.publish(event());
    h.drain();
    expect(seen).toEqual([]);
  });

  it("publishes to the transport for local events only, so two engines cannot bounce a wake", () => {
    const publish = vi.fn();
    const h = harness({ transport: { publish } });
    h.signal.subscribe("/p/a", () => undefined);

    h.signal.publish(event({ taskId: "FN-1" }));
    h.signal.publish(event({ taskId: "FN-2", remote: true }));
    h.drain();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ taskId: "FN-1" }));
  });

  it("delivers a remote event locally and marks it remote", () => {
    const h = harness();
    const seen: DispatchWakeEvent[] = [];
    h.signal.subscribe("/p/a", (e) => seen.push(e));

    h.signal.publish(event({ taskId: "FN-1", remote: true }));
    h.drain();

    expect(seen).toEqual([{ projectId: "/p/a", reason: "task-eligibility", taskId: "FN-1", remote: true }]);
  });

  it("degrades a failing transport to a diagnostic and still delivers locally", () => {
    const h = harness({ transport: { publish: () => { throw new Error("no connection"); } } });
    const seen: string[] = [];
    h.signal.subscribe("/p/a", () => seen.push("local"));

    expect(() => h.signal.publish(event())).not.toThrow();
    h.drain();

    expect(seen).toEqual(["local"]);
    expect(h.warnings.some((w) => w.includes("transport publish failed"))).toBe(true);
  });

  it("drops a publication with no project scope rather than fanning it out", () => {
    const publish = vi.fn();
    const h = harness({ transport: { publish } });
    const seen: string[] = [];
    h.signal.subscribe("/p/a", () => seen.push("x"));

    h.signal.publish({ projectId: "", reason: "task-eligibility" });
    h.drain();

    expect(seen).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it("stops delivering and stops scheduling after dispose()", () => {
    const h = harness();
    const seen: string[] = [];
    h.signal.subscribe("/p/a", () => seen.push("x"));

    h.signal.publish(event());
    h.signal.dispose();
    h.drain();

    expect(seen).toEqual([]);
    expect(h.signal.subscriberCount("/p/a")).toBe(0);
    // A subscription taken after dispose is inert rather than a leak.
    const off = h.signal.subscribe("/p/a", () => seen.push("late"));
    h.signal.publish(event());
    h.drain();
    expect(seen).toEqual([]);
    off();
  });

  it("carries only ids and bounded enums, never task content", () => {
    const h = harness();
    const seen: DispatchWakeEvent[] = [];
    h.signal.subscribe("/p/a", (e) => seen.push(e));

    h.signal.publish(event({ reason: "continuation", taskId: "FN-1" }));
    h.drain();

    // The payload shape IS the privacy boundary: a cross-process transport makes it visible to
    // every user of the database, so anything beyond these keys would be a leak.
    expect(Object.keys(seen[0]).sort()).toEqual(["projectId", "reason", "taskId"]);
  });
});

/*
FNXC:EventDrivenDispatch 2026-09-18-14:27:
FN-519 — the routing key must be resolved identically by every publisher and every subscriber.

The defect this pins: the cross-process publisher named the partition identity
(`AsyncDataLayer.projectId`, e.g. `local-<sha256>`) while the runtime subscribed under the
filesystem root, so a remote wake — including the engine's own NOTIFY returning to it — was routed
to a key with no subscriber and dropped. These cases deliberately make the two identities DIVERGE,
because when the root and the partition identity are equal the bug is invisible.
*/
describe("resolveDispatchWakeProjectKey", () => {
  it("prefers the partition identity over the project root", () => {
    // Two processes of the same project share the partition identity and never the checkout path,
    // so it is the only value that can route a cross-process wake.
    expect(resolveDispatchWakeProjectKey({ projectId: "local-abc", rootDir: "/p/one" }))
      .toBe("local-abc");
  });

  it("falls back to the project root for an unscoped store", () => {
    expect(resolveDispatchWakeProjectKey({ projectId: null, rootDir: "/p/one" })).toBe("/p/one");
    expect(resolveDispatchWakeProjectKey({ projectId: "", rootDir: "/p/one" })).toBe("/p/one");
  });
});

describe("TaskStore dispatch-wake publication key", () => {
  it("publishes canonical task publications under the partition identity, not the root dir", () => {
    const store = new TaskStore(process.cwd(), undefined, {
      asyncLayer: { projectId: "local-abc" } as never,
    });
    const seen: DispatchWakeEvent[] = [];
    const signal = createDispatchWakeSignal({ defer: (run) => run() });
    // Subscribing under the partition identity is what the runtime does; before the fix the store
    // published under the root dir and this subscriber never heard anything.
    signal.subscribe("local-abc", (e) => seen.push(e));
    store.setDispatchWakeSignal(signal);

    store.emit("task:updated", { id: "FN-1", column: "building" } as never);
    store.emitTaskLifecycleEventSafely("task:created", [{ id: "FN-2", column: "triage" } as never]);

    expect(seen.map((e) => `${e.projectId}:${e.reason}:${e.taskId}`)).toEqual([
      "local-abc:task-eligibility:FN-1",
      "local-abc:task-eligibility:FN-2",
    ]);
    signal.dispose();
  });
});
