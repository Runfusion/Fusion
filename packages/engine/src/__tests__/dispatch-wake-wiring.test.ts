import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatchWakeSignal } from "@fusion/core";

import {
  clearPreHeldExecutorSlotsForTests,
  projectAdmissionCoordinator,
} from "../concurrency/concurrency.js";
import {
  createDispatchWakeTransport,
  resolveRemoteWakeProjectId,
  resolveWakeTargets,
  wireDispatchWakes,
} from "../runtimes/dispatch-wakes.js";

/*
FNXC:EventDrivenDispatch 2026-09-18-00:40:
FN-519 — the wiring layer's own contract: which consumer each publication reason reaches, and that
a stopped runtime really unsubscribes.

The disposal cases are the load-bearing ones. A leaked reservation-release listener keeps a stopped
runtime's drain closure alive and wakes it for a project it no longer serves, which is both a memory
leak and a source of dispatch from a runtime that has been told to stop.
*/

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function harness(projectId = "/p/wire") {
  const calls = { planning: 0, scheduler: 0, continuations: 0 };
  const signal = createDispatchWakeSignal();
  const wiring = wireDispatchWakes({
    projectId,
    kickPlanning: () => { calls.planning += 1; },
    kickScheduler: () => { calls.scheduler += 1; },
    kickContinuations: () => { calls.continuations += 1; },
    dispatchWake: signal,
  });
  return { calls, signal, wiring, projectId };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  projectAdmissionCoordinator.clearReservationsForTests();
  clearPreHeldExecutorSlotsForTests();
});

describe("resolveWakeTargets", () => {
  it("wakes only the continuation consumer for a continuation publication", () => {
    // A durable continuation row is the ONLY consumer that can claim it; waking planning and the
    // scheduler as well would run two extra no-op passes per graph step.
    expect(resolveWakeTargets("continuation")).toEqual({
      planning: false,
      scheduler: false,
      continuations: true,
    });
  });

  it("wakes every lane for eligibility, capacity, settings, and release", () => {
    for (const reason of ["task-eligibility", "capacity", "settings", "release"] as const) {
      expect(resolveWakeTargets(reason), reason).toEqual({
        planning: true,
        scheduler: true,
        continuations: true,
      });
    }
  });

  it("wakes the authoritative passes for an unknown reason rather than dropping it", () => {
    // Forward compatibility: a newer publisher's reason must not become a stall. A missed wake is
    // a stall; a spurious wake is one bounded no-op pass.
    expect(resolveWakeTargets("something-new" as never)).toEqual({
      planning: true,
      scheduler: true,
      continuations: true,
    });
  });
});

describe("wireDispatchWakes", () => {
  it("routes a published wake to the mapped consumers", async () => {
    const h = harness();
    h.signal.publish({ projectId: h.projectId, reason: "continuation", taskId: "FN-1" });
    await flushMicrotasks();

    expect(h.calls).toEqual({ planning: 0, scheduler: 0, continuations: 1 });

    h.signal.publish({ projectId: h.projectId, reason: "task-eligibility", taskId: "FN-1" });
    await flushMicrotasks();

    expect(h.calls).toEqual({ planning: 1, scheduler: 1, continuations: 2 });
    h.wiring.dispose();
  });

  it("never reacts to another project's wake", async () => {
    const h = harness("/p/mine");
    h.signal.publish({ projectId: "/p/theirs", reason: "task-eligibility", taskId: "FN-1" });
    await flushMicrotasks();

    expect(h.calls).toEqual({ planning: 0, scheduler: 0, continuations: 0 });
    h.wiring.dispose();
  });

  it("wakes all three lanes when the last shared reservation is returned", async () => {
    const h = harness("/p/cap");
    await projectAdmissionCoordinator.admitNext({
      projectId: "/p/cap",
      maxConcurrent: 1,
      claimed: () => 0,
      claimedTaskIds: () => [],
      refresh: async () => [{
        taskId: "FN-CAP-1",
        projectId: "/p/cap",
        lane: "execute",
        consumesWorktree: false,
        createdAt: "2026-09-18T00:00:00.000Z",
        start: async () => undefined,
      }],
    } as any);

    projectAdmissionCoordinator.releaseReservation("FN-CAP-1");

    expect(h.calls).toEqual({ planning: 1, scheduler: 1, continuations: 1 });
    h.wiring.dispose();
  });

  it("unsubscribes everything on dispose, including the reservation-release listener", async () => {
    const h = harness("/p/dispose");
    expect(h.wiring.subscriptionCount).toBe(2);

    h.wiring.dispose();
    expect(h.wiring.subscriptionCount).toBe(0);

    await projectAdmissionCoordinator.admitNext({
      projectId: "/p/dispose",
      maxConcurrent: 1,
      claimed: () => 0,
      claimedTaskIds: () => [],
      refresh: async () => [{
        taskId: "FN-DISP-1",
        projectId: "/p/dispose",
        lane: "execute",
        consumesWorktree: false,
        createdAt: "2026-09-18T00:00:00.000Z",
        start: async () => undefined,
      }],
    } as any);
    projectAdmissionCoordinator.releaseReservation("FN-DISP-1");
    h.signal.publish({ projectId: "/p/dispose", reason: "task-eligibility" });
    await flushMicrotasks();

    expect(h.calls).toEqual({ planning: 0, scheduler: 0, continuations: 0 });
  });

  it("is idempotent on dispose and isolates a throwing disposer", () => {
    const warnings: string[] = [];
    const signal = createDispatchWakeSignal();
    const wiring = wireDispatchWakes({
      projectId: "/p/twice",
      kickPlanning: () => undefined,
      kickScheduler: () => undefined,
      kickContinuations: () => undefined,
      dispatchWake: {
        subscribe: () => () => { throw new Error("disposer exploded"); },
        publish: () => undefined,
        subscriberCount: () => 0,
        dispose: () => undefined,
      },
      warn: (message) => warnings.push(message),
    });
    void signal;

    expect(() => wiring.dispose()).not.toThrow();
    expect(() => wiring.dispose()).not.toThrow();
    expect(warnings.some((w) => w.includes("disposer failed"))).toBe(true);
  });

  it("still wires capacity releases when no dispatch-wake signal is available", () => {
    const calls = { planning: 0, scheduler: 0, continuations: 0 };
    // A store without an installed signal (a degraded transport, a CLI-only process) must keep the
    // in-process capacity wake, which does not depend on the transport at all.
    const wiring = wireDispatchWakes({
      projectId: "/p/nosignal",
      kickPlanning: () => { calls.planning += 1; },
      kickScheduler: () => { calls.scheduler += 1; },
      kickContinuations: () => { calls.continuations += 1; },
      dispatchWake: undefined,
    });
    expect(wiring.subscriptionCount).toBe(1);
    wiring.dispose();
  });
});

/*
FNXC:EventDrivenDispatch 2026-09-18-14:27:
FN-519 — routing regression: the wake routing key and the admission-coordinator key are DIFFERENT
key spaces, and the wiring must subscribe in the publishers'.

Production publishers name the partition identity (`AsyncDataLayer.projectId`, e.g.
`local-<sha256>`), while the admission coordinator and the old subscription used the project root.
Because `publish` only reaches listeners registered under the exact `event.projectId`, that
divergence dropped every remote wake — including this process's own NOTIFY — and left the 2 s
periodic relève as the real trigger for a Plan Review/Code Review continuation written elsewhere.
Every case below keeps the two identities deliberately different.
*/
describe("dispatch-wake routing when rootDir and the partition identity diverge", () => {
  const ROOT = "/p/checkout-a";
  const PARTITION = "local-9f2c";

  it("wakes the consumers for a wake published under the partition identity", async () => {
    const calls = { planning: 0, scheduler: 0, continuations: 0 };
    const signal = createDispatchWakeSignal();
    const wiring = wireDispatchWakes({
      projectId: ROOT,
      wakeProjectId: PARTITION,
      kickPlanning: () => { calls.planning += 1; },
      kickScheduler: () => { calls.scheduler += 1; },
      kickContinuations: () => { calls.continuations += 1; },
      dispatchWake: signal,
    });

    // Exactly what `notifyDispatchWakeWithinTransaction` publishes for a runnable continuation.
    signal.publish({ projectId: PARTITION, reason: "continuation", taskId: "FN-1", remote: true });
    await flushMicrotasks();

    expect(calls.continuations).toBe(1);
    wiring.dispose();
    signal.dispose();
  });

  it("remaps a remote wake naming a known identity, and leaves a foreign project alone", () => {
    // A legacy or unscoped peer may still name the project root; that is this runtime's project, so
    // it must be routed, not dropped.
    expect(resolveRemoteWakeProjectId(ROOT, { wakeProjectId: PARTITION, aliases: [ROOT] }))
      .toBe(PARTITION);
    expect(resolveRemoteWakeProjectId(PARTITION, { wakeProjectId: PARTITION, aliases: [ROOT] }))
      .toBe(PARTITION);
    // Project isolation: another project's wake keeps its own id so this subscription filters it.
    expect(resolveRemoteWakeProjectId("local-other", { wakeProjectId: PARTITION, aliases: [ROOT] }))
      .toBe("local-other");
  });

  it("does not wake this runtime for another project's remote wake", async () => {
    const calls = { planning: 0, scheduler: 0, continuations: 0 };
    const signal = createDispatchWakeSignal();
    const wiring = wireDispatchWakes({
      projectId: ROOT,
      wakeProjectId: PARTITION,
      kickPlanning: () => { calls.planning += 1; },
      kickScheduler: () => { calls.scheduler += 1; },
      kickContinuations: () => { calls.continuations += 1; },
      dispatchWake: signal,
    });

    const foreign = resolveRemoteWakeProjectId("local-other", {
      wakeProjectId: PARTITION,
      aliases: [ROOT],
    });
    signal.publish({ projectId: foreign, reason: "task-eligibility", taskId: "FN-1", remote: true });
    await flushMicrotasks();

    expect(calls).toEqual({ planning: 0, scheduler: 0, continuations: 0 });
    wiring.dispose();
    signal.dispose();
  });
});

/*
FNXC:EventDrivenDispatch 2026-09-18-14:27:
FN-519 — canonical task/settings publications must leave the process.

Before this transport the only cross-process wakes were the work-item writers' in-transaction
NOTIFY: a card created or moved by the CLI, or a settings change written by a second store, woke
nothing remotely and waited for a periodic sweep. The failure cases matter as much as the happy
one — an unreachable database must degrade to a diagnostic, never to a failed mutation.
*/
describe("createDispatchWakeTransport", () => {
  const wake = { projectId: "local-9f2c", reason: "task-eligibility", taskId: "FN-1" } as const;

  it("publishes a local task publication through the layer handle", async () => {
    const seen: Array<{ projectId: string; taskId?: string }> = [];
    const signal = createDispatchWakeSignal({
      transport: createDispatchWakeTransport({
        execute: async () => undefined,
        notify: async (_handle, event) => { seen.push({ projectId: event.projectId, ...(event.taskId ? { taskId: event.taskId } : {}) }); },
      }),
    });

    signal.publish({ ...wake });
    await flushMicrotasks();

    expect(seen).toEqual([{ projectId: "local-9f2c", taskId: "FN-1" }]);
    signal.dispose();
  });

  it("never re-publishes a remote delivery, so two engines cannot bounce one wake", async () => {
    let published = 0;
    const signal = createDispatchWakeSignal({
      transport: createDispatchWakeTransport({
        execute: async () => undefined,
        notify: async () => { published += 1; },
      }),
    });

    signal.publish({ ...wake, remote: true });
    await flushMicrotasks();

    expect(published).toBe(0);
    signal.dispose();
  });

  it("absorbs a throwing and a rejecting publication as a diagnostic", async () => {
    const warnings: string[] = [];
    const throwing = createDispatchWakeTransport({
      execute: async () => undefined,
      notify: () => { throw new Error("notify exploded"); },
      warn: (message) => warnings.push(message),
    });
    const rejecting = createDispatchWakeTransport({
      execute: async () => undefined,
      notify: async () => { throw new Error("database unreachable"); },
      warn: (message) => warnings.push(message),
    });

    // A publish is called from inside a mutation's emission path; it must not be able to throw.
    expect(() => throwing.publish({ ...wake })).not.toThrow();
    expect(() => rejecting.publish({ ...wake })).not.toThrow();
    await flushMicrotasks();

    expect(warnings.some((w) => w.includes("notify exploded"))).toBe(true);
  });
});
