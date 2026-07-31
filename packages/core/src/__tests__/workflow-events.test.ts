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
import { createWorkflowEventBus, emitWorkflowLifecycleEvent, getWorkflowEventBus, resetWorkflowEventBusForTesting } from "../workflow-events.js";
import {
  findWorkflowEventShapeViolations,
  isIdsOnlyWorkflowEvent,
  MAX_ID_VALUE_LENGTH,
  IMPLEMENTATION_EXITS,
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

  /* The VALUE-shape half. Asserted on DECLARED keys on purpose: an undeclared
     key is refused by the allow-list first, which would mask a value-rule
     regression behind an `unknown-key` verdict. */
  it("rejects an object BODY on a declared key — the spread-a-row mistake", () => {
    const violations = findWorkflowEventShapeViolations({
      ...transitioned(),
      to: { id: "in-review", name: "In review" },
    });
    expect(violations).toEqual([{ path: "to", reason: "object-body" }]);
  });

  it("rejects PROSE on a declared key — the attach-the-message mistake", () => {
    const long = "x".repeat(MAX_ID_VALUE_LENGTH + 1);
    expect(findWorkflowEventShapeViolations({ ...transitioned(), moveSource: long }))
      .toEqual([{ path: "moveSource", reason: "prose-string" }]);
    // A multi-line value is prose regardless of length — stack traces are short lines.
    expect(findWorkflowEventShapeViolations({ ...transitioned(), moveSource: "line one\nline two" }))
      .toEqual([{ path: "moveSource", reason: "prose-string" }]);
  });

  /*
  FNXC:WorkflowEvents 2026-07-27-15:50 (U3, PR #2467 review):
  The half that value-shape checking alone MISSES. `error: "auth failed"`,
  `prompt: "summarize"`, and `modelId` are all short single-line scalars — they
  pass every value rule and would still reach a plugin subscriber. The per-type
  key allow-list is what stops them, so it gets its own cases.
  */
  it("rejects an unknown KEY even when its value is a perfectly good scalar", () => {
    expect(findWorkflowEventShapeViolations({ ...transitioned(), error: "auth failed" }))
      .toEqual([{ path: "error", reason: "unknown-key" }]);
    expect(findWorkflowEventShapeViolations({ ...transitioned(), modelId: "claude-opus-5" }))
      .toEqual([{ path: "modelId", reason: "unknown-key" }]);
    expect(findWorkflowEventShapeViolations({ ...transitioned(), prompt: "summarize" }))
      .toEqual([{ path: "prompt", reason: "unknown-key" }]);
  });

  it("scopes the allow-list PER TYPE — a valid key on one event is unknown on another", () => {
    // `outcome` belongs to NodeCompleted, not to TaskTransitioned.
    expect(findWorkflowEventShapeViolations({ ...transitioned(), outcome: "success" }))
      .toEqual([{ path: "outcome", reason: "unknown-key" }]);
    expect(findWorkflowEventShapeViolations({
      type: "NodeCompleted", taskId: "FN-3", at: "2026-07-27T00:00:00.000Z",
      nodeId: "execute", outcome: "success",
    })).toEqual([]);
  });

  /*
  FNXC:WorkflowEvents 2026-07-27-17:10 (U3, PR #2467 review — required-key half):
  ALLOWED_EVENT_KEYS is a CEILING; this is the FLOOR. Without it a payload
  missing `taskId` validated clean and got delivered, and a subscriber keying
  derived state on `event.taskId` would write under `undefined` rather than
  fail — the quiet-corruption mode this seam is supposed to be immune to.
  One case per declared event type, so adding a type without its required keys
  fails here rather than shipping an unvalidated payload.
  */
  it("rejects a payload missing a COMMON required key", () => {
    const { taskId: _taskId, ...noTaskId } = transitioned() as Record<string, unknown>;
    expect(findWorkflowEventShapeViolations(noTaskId))
      .toEqual([{ path: "taskId", reason: "missing-required-key" }]);

    const { at: _at, ...noAt } = transitioned() as Record<string, unknown>;
    expect(findWorkflowEventShapeViolations(noAt))
      .toEqual([{ path: "at", reason: "missing-required-key" }]);
  });

  it("treats an EXPLICITLY undefined required key as missing, not as present", () => {
    // `{ taskId: maybeId }` where maybeId is undefined is the same bug as
    // omitting the key; the emitters' conditional spreads produce the other form.
    expect(findWorkflowEventShapeViolations({ ...transitioned(), taskId: undefined }))
      .toEqual([{ path: "taskId", reason: "missing-required-key" }]);
  });

  it("enforces the per-type required keys for every declared event type", () => {
    const complete: Record<string, Record<string, unknown>> = {
      TaskTransitioned: { type: "TaskTransitioned", taskId: "FN-1", at: "t", from: "todo", to: "in-progress" },
      NodeEntered: { type: "NodeEntered", taskId: "FN-1", at: "t", nodeId: "execute" },
      NodeCompleted: { type: "NodeCompleted", taskId: "FN-1", at: "t", nodeId: "execute", outcome: "success" },
      RunSuspended: { type: "RunSuspended", taskId: "FN-1", at: "t", nodeId: "execute", reason: "capacity" },
      RunResumed: { type: "RunResumed", taskId: "FN-1", at: "t", nodeId: "execute" },
    };
    const typeSpecificRequired: Record<string, string[]> = {
      TaskTransitioned: ["from", "to"],
      NodeEntered: ["nodeId"],
      NodeCompleted: ["nodeId", "outcome"],
      RunSuspended: ["nodeId", "reason"],
      RunResumed: ["nodeId"],
    };

    for (const [type, payload] of Object.entries(complete)) {
      // The complete payload is clean...
      expect(findWorkflowEventShapeViolations(payload)).toEqual([]);
      // ...and dropping any one type-specific required key is a violation.
      for (const key of typeSpecificRequired[type]) {
        const { [key]: _dropped, ...incomplete } = payload;
        expect(findWorkflowEventShapeViolations(incomplete))
          .toEqual([{ path: key, reason: "missing-required-key" }]);
      }
    }
  });

  it("keeps genuinely OPTIONAL keys optional — column, fromColumn/toColumn, runId, workflowId", () => {
    // `column` is absent for a columnless node (`end`); `fromColumn`/`toColumn`
    // for a suspension with no crossing; `runId`/`workflowId` are legitimately
    // unresolvable at some emit sites. None may be forced into the floor.
    expect(findWorkflowEventShapeViolations({ type: "NodeEntered", taskId: "FN-1", at: "t", nodeId: "end" })).toEqual([]);
    expect(findWorkflowEventShapeViolations({ type: "RunSuspended", taskId: "FN-1", at: "t", nodeId: "n", reason: "capacity" })).toEqual([]);
  });

  it("reports BOTH an unknown key and a missing required key on one payload", () => {
    const { to: _to, ...noTo } = transitioned() as Record<string, unknown>;
    expect(findWorkflowEventShapeViolations({ ...noTo, error: "boom" })).toEqual([
      { path: "error", reason: "unknown-key" },
      { path: "to", reason: "missing-required-key" },
    ]);
  });

  it("rejects an unrecognised event TYPE outright rather than validating its fields", () => {
    // An out-of-band type has no declared payload, so it gets no implicit
    // permission to invent one.
    expect(findWorkflowEventShapeViolations({ type: "TaskExploded", taskId: "FN-4", at: "x" }))
      .toEqual([{ path: "type", reason: "unknown-type" }]);
  });

  it("allows an array of ids but rejects an array of objects", () => {
    // Arrays are validated element-wise for any key the type declares; an
    // UNDECLARED array key is refused by the allow-list before that runs, which
    // is why both halves are asserted here.
    expect(findWorkflowEventShapeViolations({ ...transitioned(), diffs: [{ field: "column" }] }))
      .toEqual([{ path: "diffs", reason: "unknown-key" }]);
  });

  it("REFUSES a violating payload at the emit boundary so it never reaches a subscriber", async () => {
    const bus = createWorkflowEventBus();
    const subscriber = vi.fn();
    bus.subscribe(subscriber, { name: "plugin" });

    bus.emit({ ...transitioned(), to: { id: "in-review" } } as unknown as WorkflowLifecycleEvent);
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

/*
FNXC:WorkflowEvents 2026-07-28-22:30 (U8, PR #2507 review — greptile):
The `exit` key carries a CLOSED vocabulary, and the closed-ness is enforced at the emit boundary
rather than only in the type. The type protects TypeScript producers; the boundary protects the
ones that can actually cause the silent failure — a JS caller, a plugin, or a future seam
emitting an id nobody routes, where the symptom is a card that quietly does not advance.
*/
describe("closed-vocabulary values (exit)", () => {
  const base = { type: "NodeCompleted", taskId: "FN-1", at: "2026-07-28T00:00:00.000Z", nodeId: "execute", outcome: "success" };

  it("accepts every declared exit id", () => {
    for (const exit of IMPLEMENTATION_EXITS) {
      expect(findWorkflowEventShapeViolations({ ...base, exit })).toEqual([]);
    }
  });

  it("refuses an exit id that is not in the vocabulary", () => {
    /* A perfectly good scalar — which is exactly why value-shape checking alone is not enough. */
    expect(findWorkflowEventShapeViolations({ ...base, exit: "review-handoff-invented" })).toEqual([
      { path: "exit", reason: "unknown-enum-value" },
    ]);
  });

  it("still accepts NodeCompleted with no exit at all", () => {
    expect(findWorkflowEventShapeViolations(base)).toEqual([]);
  });

  it("drops an event carrying an unrouted exit rather than delivering it", () => {
    /* End to end through the bus: a violating payload must never reach a subscriber. */
    resetWorkflowEventBusForTesting();
    const seen: unknown[] = [];
    getWorkflowEventBus().subscribe((e) => { seen.push(e); }, { name: "closed-vocab" });
    emitWorkflowLifecycleEvent({ ...base, exit: "not-a-real-exit" } as never);
    emitWorkflowLifecycleEvent({ ...base, exit: "complete" } as never);
    return getWorkflowEventBus().drain().then(() => {
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ exit: "complete" });
      resetWorkflowEventBusForTesting();
    });
  });
});
