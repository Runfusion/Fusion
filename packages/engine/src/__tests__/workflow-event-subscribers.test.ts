/*
FNXC:WorkflowEvents 2026-07-27-16:00 (U3 / R5, PR #2467 review):
The engine registration point's own invariants. Two of them are only
interesting because getting them wrong FAILS SILENTLY — a process ends up with
no reactions registered and nothing reports it:

  IDEMPOTENT RE-REGISTRATION — an engine restart must replace its subscriber set,
  not stack a second copy that double-delivers every event.
  REGISTRATION-SCOPED CLEANUP — a cleanup handle captured before a restart must
  not unsubscribe the set registered AFTER it.

Both are asserted through the real global bus, since that is the object the
production wiring shares.
*/
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  getWorkflowEventBus,
  resetWorkflowEventBusForTesting,
  type WorkflowLifecycleEvent,
} from "@fusion/core";
import {
  registerWorkflowEventSubscribers,
  unregisterWorkflowEventSubscribers,
  activeWorkflowEventSubscriberCount,
  ENGINE_WORKFLOW_EVENT_SUBSCRIBERS,
  type WorkflowEventSubscriberRegistration,
} from "../workflow-event-subscribers.js";

function transitioned(): WorkflowLifecycleEvent {
  return {
    type: "TaskTransitioned",
    taskId: "FN-1",
    at: "2026-07-27T00:00:00.000Z",
    from: "todo",
    to: "in-progress",
  };
}

function recorder(name: string, types: WorkflowLifecycleEvent["type"][]): WorkflowEventSubscriberRegistration & { seen: string[] } {
  const seen: string[] = [];
  return { name, types, seen, handle: (event) => { seen.push(event.type); } };
}

beforeEach(() => {
  resetWorkflowEventBusForTesting();
  unregisterWorkflowEventSubscribers();
});
afterEach(() => {
  unregisterWorkflowEventSubscribers();
});

describe("engine workflow-event subscriber registry (U3 / R5)", () => {
  it("ships EMPTY — reactions arrive with the units that convert them", () => {
    // Landing the seam pre-populated would convert reactions in the same commit
    // that introduces the mechanism they rely on (U7/U8/U10 do that work).
    expect(ENGINE_WORKFLOW_EVENT_SUBSCRIBERS).toEqual([]);
  });

  it("delivers only the event types a registration declares", async () => {
    const transitions = recorder("transitions", ["TaskTransitioned"]);
    const nodes = recorder("nodes", ["NodeEntered"]);
    registerWorkflowEventSubscribers([transitions, nodes]);

    getWorkflowEventBus().emit(transitioned());
    await getWorkflowEventBus().drain();

    expect(transitions.seen).toEqual(["TaskTransitioned"]);
    expect(nodes.seen).toEqual([]);
  });

  it("RE-registering replaces the previous set rather than double-delivering", async () => {
    const first = recorder("first", ["TaskTransitioned"]);
    registerWorkflowEventSubscribers([first]);
    const second = recorder("second", ["TaskTransitioned"]);
    registerWorkflowEventSubscribers([second]);

    expect(activeWorkflowEventSubscriberCount()).toBe(1);
    getWorkflowEventBus().emit(transitioned());
    await getWorkflowEventBus().drain();

    expect(first.seen).toEqual([]);
    expect(second.seen).toEqual(["TaskTransitioned"]);
  });

  it("a STALE cleanup handle cannot unsubscribe a later registration", async () => {
    // The silent failure this guards: an engine restart re-registers, then a
    // deferred cleanup captured before the restart fires and leaves the process
    // with no reactions and no error.
    const first = recorder("first", ["TaskTransitioned"]);
    const staleCleanup = registerWorkflowEventSubscribers([first]);

    const second = recorder("second", ["TaskTransitioned"]);
    registerWorkflowEventSubscribers([second]);

    staleCleanup();

    expect(activeWorkflowEventSubscriberCount()).toBe(1);
    getWorkflowEventBus().emit(transitioned());
    await getWorkflowEventBus().drain();
    expect(second.seen).toEqual(["TaskTransitioned"]);
  });

  it("the returned cleanup removes its OWN registration", async () => {
    const only = recorder("only", ["TaskTransitioned"]);
    const cleanup = registerWorkflowEventSubscribers([only]);
    cleanup();

    expect(activeWorkflowEventSubscriberCount()).toBe(0);
    getWorkflowEventBus().emit(transitioned());
    await getWorkflowEventBus().drain();
    expect(only.seen).toEqual([]);
  });
});
