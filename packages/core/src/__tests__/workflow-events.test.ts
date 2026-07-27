/*
FNXC:WorkflowEvents 2026-07-27-12:40 (U3 / R5, R6 — workflow-owned lifecycle):
The invariants everything downstream assumes about the post-commit bus. Written
test-first per the unit's execution note, because these are properties later
units BUILD ON rather than merely benefit from — a subscriber author who assumes
isolation and gets none writes a plugin that can fail a lifecycle transition.

Four properties are load-bearing:
  ISOLATION   — a throwing subscriber cannot stop the others or reach the caller.
  ORDERING    — two seams on one task deliver in the order they committed.
  IDS-ONLY    — a payload carrying prose or an object body is REFUSED at emit, so
                it never reaches a plugin subscriber or a log sink.
  LOSSINESS   — dropping every subscriber changes nothing, which is what makes
                "reactions are non-authoritative" checkable rather than aspirational.

The outbox half of R5 (durable work survives a crash between commit and emit, and
its at-least-once redelivery) is proven against a REAL PostgreSQL work-item table
in `workflow-events-outbox.pg.test.ts` — a hand-written fake of the lease
predicate would only prove the fake redelivers.
*/
import { describe, expect, it, vi } from "vitest";
import { createWorkflowEventBus } from "../workflow-events.js";
import {
  findWorkflowEventShapeViolations,
  isIdsOnlyWorkflowEvent,
  MAX_ID_VALUE_LENGTH,
  type WorkflowLifecycleEvent,
} from "../types/workflow-events.js";

function transitioned(overrides: Partial<WorkflowLifecycleEvent> = {}): WorkflowLifecycleEvent {
  return {
    type: "TaskTransitioned",
    taskId: "FN-1",
    at: "2026-07-27T00:00:00.000Z",
    from: "todo",
    to: "in-progress",
    ...overrides,
  } as WorkflowLifecycleEvent;
}

describe("workflow event bus — isolation (R5)", () => {
  it("a throwing subscriber does not reach the emitter and does not stop the others", async () => {
    const bus = createWorkflowEventBus();
    const before = vi.fn();
    const after = vi.fn();
    bus.subscribe(before, { name: "before" });
    bus.subscribe(() => { throw new Error("subscriber exploded"); }, { name: "boom" });
    bus.subscribe(after, { name: "after" });

    // The emitter is on a post-commit path: the transition has already committed,
    // so a throw here would be a lifecycle fault caused by a reaction.
    expect(() => bus.emit(transitioned())).not.toThrow();
    await bus.drain();

    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("isolates a REJECTING async subscriber the same way as a throwing sync one", async () => {
    const bus = createWorkflowEventBus();
    const after = vi.fn();
    bus.subscribe(async () => { throw new Error("async boom"); }, { name: "async-boom" });
    bus.subscribe(after, { name: "after" });

    bus.emit(transitioned());
    await expect(bus.drain()).resolves.toBeUndefined();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("a subscriber unsubscribing mid-delivery does not corrupt the event in flight", async () => {
    const bus = createWorkflowEventBus();
    const seen: string[] = [];
    let offSecond: (() => void) | undefined;
    bus.subscribe(() => { seen.push("first"); offSecond?.(); }, { name: "first" });
    offSecond = bus.subscribe(() => { seen.push("second"); }, { name: "second" });

    bus.emit(transitioned());
    await bus.drain();
    // The snapshot taken at delivery still includes `second` for THIS event…
    expect(seen).toEqual(["first", "second"]);

    seen.length = 0;
    bus.emit(transitioned());
    await bus.drain();
    // …and excludes it for the next one.
    expect(seen).toEqual(["first"]);
  });
});

describe("workflow event bus — ordering (R5)", () => {
  it("delivers two seams on one task in commit order even when subscribers are async", async () => {
    const bus = createWorkflowEventBus();
    const order: string[] = [];
    bus.subscribe(async (event) => {
      // A slow first delivery must not let the second overtake it — this is the
      // property that lets a subscriber maintain derived state without its own
      // sequencing.
      if ((event as { to?: string }).to === "in-progress") {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      order.push(`${(event as { from?: string }).from}->${(event as { to?: string }).to}`);
    }, { name: "recorder" });

    bus.emit(transitioned({ from: "todo", to: "in-progress" } as Partial<WorkflowLifecycleEvent>));
    bus.emit(transitioned({ from: "in-progress", to: "in-review" } as Partial<WorkflowLifecycleEvent>));
    await bus.drain();

    expect(order).toEqual(["todo->in-progress", "in-progress->in-review"]);
  });
});

describe("workflow event payloads — ids/outcomes only (R5)", () => {
  it("accepts the real event shapes", () => {
    expect(isIdsOnlyWorkflowEvent(transitioned({ nodeId: "execute", moveSource: "engine" } as Partial<WorkflowLifecycleEvent>))).toBe(true);
    expect(isIdsOnlyWorkflowEvent({
      type: "RunSuspended", taskId: "FN-2", at: "2026-07-27T00:00:00.000Z",
      nodeId: "execute", reason: "capacity", fromColumn: "todo", toColumn: "in-progress",
    })).toBe(true);
  });

  it("rejects an object BODY — the spread-a-task-row mistake", () => {
    const violations = findWorkflowEventShapeViolations({
      ...transitioned(),
      task: { id: "FN-1", title: "Fix the thing", description: "…" },
    });
    expect(violations).toEqual([{ path: "task", reason: "object-body" }]);
  });

  it("rejects PROSE — the attach-the-error-message mistake", () => {
    const long = "x".repeat(MAX_ID_VALUE_LENGTH + 1);
    expect(findWorkflowEventShapeViolations({ ...transitioned(), error: long }))
      .toEqual([{ path: "error", reason: "prose-string" }]);
    // A multi-line value is prose regardless of length — stack traces are short lines.
    expect(findWorkflowEventShapeViolations({ ...transitioned(), error: "line one\nline two" }))
      .toEqual([{ path: "error", reason: "prose-string" }]);
  });

  it("allows an array of ids but rejects an array of objects", () => {
    expect(findWorkflowEventShapeViolations({ ...transitioned(), blockedBy: ["FN-2", "FN-3"] })).toEqual([]);
    expect(findWorkflowEventShapeViolations({ ...transitioned(), diffs: [{ field: "column" }] }))
      .toEqual([{ path: "diffs[0]", reason: "object-body" }]);
  });

  it("REFUSES a violating payload at the emit boundary so it never reaches a subscriber", async () => {
    const bus = createWorkflowEventBus();
    const subscriber = vi.fn();
    bus.subscribe(subscriber, { name: "plugin" });

    bus.emit({ ...transitioned(), task: { id: "FN-1" } } as unknown as WorkflowLifecycleEvent);
    await bus.drain();

    // Degrades rather than throws: the emitter is post-commit, so a shape bug
    // must not surface as a lifecycle failure.
    expect(subscriber).not.toHaveBeenCalled();
  });
});

describe("workflow event bus — reactions are non-authoritative (R5, KTD-3)", () => {
  it("emitting with ZERO subscribers is a no-op that cannot throw", () => {
    const bus = createWorkflowEventBus();
    expect(bus.subscriberCount()).toBe(0);
    expect(() => bus.emit(transitioned())).not.toThrow();
  });

  it("clear() drops every subscriber, so 'drop all subscribers' is expressible", async () => {
    const bus = createWorkflowEventBus();
    const subscriber = vi.fn();
    bus.subscribe(subscriber, { name: "one" });
    bus.clear();
    expect(bus.subscriberCount()).toBe(0);

    bus.emit(transitioned());
    await bus.drain();
    expect(subscriber).not.toHaveBeenCalled();
  });

  it("unsubscribe is idempotent — a double-off cannot remove someone else", async () => {
    const bus = createWorkflowEventBus();
    const survivor = vi.fn();
    const off = bus.subscribe(vi.fn(), { name: "leaving" });
    bus.subscribe(survivor, { name: "survivor" });
    off();
    off();
    expect(bus.subscriberCount()).toBe(1);

    bus.emit(transitioned());
    await bus.drain();
    expect(survivor).toHaveBeenCalledTimes(1);
  });
});
