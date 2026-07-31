/*
FNXC:WorkflowExecutionOwnership 2026-07-29-16:40 (U8 / R4, R5, R12):

The exit announcement was wired into `createAuthoritativeWorkflowSeams.execute` — which is NOT
the handler production runs. `createDefaultNodeHandlers` picks the PRIMITIVES prompt-like handler
whenever `deps.primitives` is set, and `executeWorkflowGraph` always sets it, so the legacy-seams
prompt handler is unreachable for prompt nodes. Everything wired only there is dead code that
type-checks, passes its own unit tests against the seam object, and never runs.

That is why this file exists at all: a seam-level test cannot tell the two apart. These assert the
announcement on the LIVE primitive, and — more importantly — assert the wiring rule itself, so the
next person adding behavior to a seam finds out from a red test rather than from an operator.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Settings, TaskDetail } from "@fusion/core";
import {
  getWorkflowEventBus,
  resetWorkflowEventBusForTesting,
  type WorkflowLifecycleEvent,
} from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createDefaultNodeHandlers } from "../workflow-node-handlers.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

const TASK = { id: "FN-PRIM-EXIT", column: "in-progress", steps: [], paused: false } as unknown as TaskDetail;

function harness(phase: { taskDone: boolean; modifiedFiles: string[]; exit?: string }) {
  const store = createMockStore();
  store.getTask.mockResolvedValue(TASK);
  const executor = new TaskExecutor(store, "/tmp/test");
  vi.spyOn(executor as never as { runImplementationPhase: () => unknown }, "runImplementationPhase")
    .mockResolvedValue(phase);
  const primitives = executor.createAuthoritativeWorkflowPrimitives({} as Settings);
  const ctx = { run: {}, node: { node: { id: "execute", kind: "prompt" }, context: {} } } as never;
  return { executor, primitives, ctx };
}

function captured(): { events: WorkflowLifecycleEvent[]; drain: () => Promise<void> } {
  const events: WorkflowLifecycleEvent[] = [];
  getWorkflowEventBus().subscribe((e) => { events.push(e); }, { name: "prim-exit" });
  return { events, drain: () => getWorkflowEventBus().drain() };
}

describe("the LIVE implementation primitive announces the exit", () => {
  beforeEach(() => { resetExecutorMocks(); resetWorkflowEventBusForTesting(); });
  afterEach(() => resetWorkflowEventBusForTesting());

  it("emits NodeCompleted with the exit from runCodingSession", async () => {
    const { primitives, ctx } = harness({ taskDone: false, modifiedFiles: [], exit: "review-handoff-pending-review" });
    const bus = captured();

    await primitives.runCodingSession(ctx, TASK, { worktreePath: "/tmp/wt", branchName: "b" } as never);
    await bus.drain();

    const completed = bus.events.filter((e) => e.type === "NodeCompleted");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ taskId: TASK.id, outcome: "failure", exit: "review-handoff-pending-review" });
  });

  it("emits success without an exit for an ordinary completion", async () => {
    const { primitives, ctx } = harness({ taskDone: true, modifiedFiles: [] });
    const bus = captured();

    await primitives.runCodingSession(ctx, TASK, { worktreePath: "/tmp/wt", branchName: "b" } as never);
    await bus.drain();

    const completed = bus.events.filter((e) => e.type === "NodeCompleted");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ outcome: "success" });
    expect(completed[0]).not.toHaveProperty("exit");
  });

  it("routes the pending-review ending, and leaves every other ending's value alone", async () => {
    /*
    This pin was "announcing must not reroute" while exits were reporting-only. The pending-review
    ending is now a ROUTED outcome, so the row changed deliberately — declared here rather than
    discovered. Every other ending keeps `implementation-incomplete`, which is what proves the
    move is narrow.
    */
    const moved = await (harness({ taskDone: false, modifiedFiles: [], exit: "review-handoff-pending-review" })
      .primitives.runCodingSession({ run: {}, node: { node: { id: "execute", kind: "prompt" }, context: {} } } as never, TASK, { worktreePath: "/tmp/wt", branchName: "b" } as never));
    expect(moved).toMatchObject({ outcome: "failure", value: "review-pending" });

    const unmoved = await (harness({ taskDone: false, modifiedFiles: [], exit: "review-handoff-paused-after-completion" })
      .primitives.runCodingSession({ run: {}, node: { node: { id: "execute", kind: "prompt" }, context: {} } } as never, TASK, { worktreePath: "/tmp/wt", branchName: "b" } as never));
    expect(unmoved).toMatchObject({ outcome: "failure", value: "implementation-incomplete" });
  });

  /*
  The rule, asserted rather than remembered. `createDefaultNodeHandlers` prefers the primitives
  handler whenever primitives are supplied; `executeWorkflowGraph` always supplies them. If that
  preference is ever inverted or made conditional, every behavior wired to the primitives path
  silently stops running — the same failure that put the announcement on a dead seam.
  */
  /*
  FNXC:WorkflowExecutionOwnership 2026-07-29-21:10 (U8 / R12, PR #2578 review — greptile):
  BEHAVIOURAL, not textual. The first version grepped for `deps?.primitives ? createPrimitive...`
  and for the executor's wiring string. Those fragments can both survive while an earlier fallback,
  an extracted dispatch helper, or a reordered condition stops selecting the primitive handler —
  so the ratchet would stay green through exactly the regression it exists to catch, which is the
  same "proves syntax, not behaviour" mistake that put a shipped behaviour on a dead seam.

  This builds the real handler map from spied seams AND spied primitives and asserts, per seam,
  which one ran. It fails if dispatch ever stops preferring primitives, however that happens.
  */
  it("dispatches every seam through the PRIMITIVES handler, never the legacy seams", async () => {
    const calls: string[] = [];
    const seamSpy = (name: string) => async () => { calls.push(`seam:${name}`); return { outcome: "success" as const }; };
    const seams = {
      planning: seamSpy("planning"),
      execute: seamSpy("execute"),
      review: seamSpy("review"),
      "review-handoff": seamSpy("review-handoff"),
      merge: seamSpy("merge"),
      schedule: seamSpy("schedule"),
      stepExecute: seamSpy("step-execute"),
    } as never;
    const primitives = {
      prepareWorktree: async () => { calls.push("prim:prepareWorktree"); return { outcome: "success", data: { worktreePath: "/tmp/wt", branchName: "b" } }; },
      runPlanningSession: async () => { calls.push("prim:runPlanningSession"); return { outcome: "success" }; },
      runCodingSession: async () => { calls.push("prim:runCodingSession"); return { outcome: "success", value: "implemented" }; },
      requestReviewHandoff: async () => { calls.push("prim:requestReviewHandoff"); return { outcome: "success" }; },
      requestReview: async () => { calls.push("prim:requestReview"); return { outcome: "success" }; },
      requestMerge: async () => { calls.push("prim:requestMerge"); return { outcome: "success" }; },
      scheduleWork: async () => { calls.push("prim:scheduleWork"); return { outcome: "success" }; },
      runTaskStep: async () => { calls.push("prim:runTaskStep"); return { outcome: "success" }; },
    } as never;

    const handlers = createDefaultNodeHandlers(seams, undefined, { primitives });
    for (const seam of ["planning", "execute", "review", "review-handoff", "merge", "schedule"]) {
      await handlers.prompt!(
        { id: `${seam}-node`, kind: "prompt", column: "in-progress", config: { seam } } as never,
        { task: { id: "FN-DISPATCH" }, context: {} } as never,
      ).catch(() => undefined);
    }

    /* The assertion that matters: no seam function ran, for any seam name. */
    expect(calls.filter((c) => c.startsWith("seam:"))).toEqual([]);
    expect(calls.some((c) => c.startsWith("prim:"))).toBe(true);
  });
});

/*
FNXC:WorkflowExecutionOwnership 2026-07-29-20:20 (U8 / R4, R12, PR #2590 review — greptile):
The compat path for user-authored graphs, and the shape that proved the first version of it could
not fire. `graphFailureValue` reads only the LAST visited node's value; a custom graph may route
its generic `failure` edge THROUGH another node, whose value then becomes terminal. The
pending-review ending is still recorded in the run context, so that is where it is read from.

Without this the card falls to the terminal park — `status: failed` on work that was only WAITING
for a reviewer, which is exactly the merge-queue deadlock the inline handoff existed to prevent.
*/
describe("compat park for graphs that do not route review-pending", () => {
  beforeEach(() => { resetExecutorMocks(); resetWorkflowEventBusForTesting(); });
  afterEach(() => resetWorkflowEventBusForTesting());

  function failureRun(overrides: Record<string, unknown>) {
    return {
      disposition: "failed" as const,
      outcome: "failure" as const,
      visitedNodeIds: ["execute", "cleanup"],
      context: overrides,
    };
  }

  function parkHarness() {
    const store = createMockStore();
    const live = { id: "FN-COMPAT", column: "in-progress", status: null, error: null, steps: [], log: [], paused: false, userPaused: false } as unknown as TaskDetail;
    store.getTask.mockResolvedValue(live);
    store.handoffToReview = vi.fn().mockImplementation(async (id: string) => store.moveTask(id, "in-review"));
    return { store, live, executor: new TaskExecutor(store, "/tmp/test") };
  }

  it("parks in review when the walk ended on a node that recorded no verdict of its own", async () => {
    /* The compat shape: the generic failure edge passes through a node that reports nothing, so
       the run's last word is still the implementation node's `review-pending`. */
    const { store, live, executor } = parkHarness();

    await (executor as never as { handleGraphFailure: (t: unknown, r: unknown) => Promise<void> })
      .handleGraphFailure(live, failureRun({ "node:execute:value": "review-pending" }));

    expect(store.handoffToReview).toHaveBeenCalledWith("FN-COMPAT", expect.anything());
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-COMPAT",
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
  });

  it("does NOT park when a LATER node reported its own failure (stale value must not mask it)", async () => {
    /*
    FNXC PR #2590 review (greptile, 2nd): the run context is shared for the whole walk, so a graph
    that continues past a pending-review node and then dies downstream still carries the earlier
    value. Parking on that would hide a real failure behind a wait — the opposite over-reach from
    the first finding, and worse, because the operator sees a card waiting for a reviewer who has
    nothing to review.
    */
    const { store, live, executor } = parkHarness();

    await (executor as never as { handleGraphFailure: (t: unknown, r: unknown) => Promise<void> })
      .handleGraphFailure(live, failureRun({
        "node:execute:value": "review-pending",
        "node:cleanup:value": "verification-failed",
      }));

    expect(store.handoffToReview).not.toHaveBeenCalled();
    /*
    FNXC:WorkflowExecutionOwnership 2026-07-30-10:40 (PR #2599 review — coderabbit):
    Assert the DISPOSITION, not only the absence of a park. "No review handoff" passes just as
    well for a run that silently did nothing, which is the failure mode this whole file exists to
    catch. Verified against the real path rather than assumed: both cases reach the terminal sink
    and park with the failure of the node that actually ended the walk.
    */
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-COMPAT",
      expect.objectContaining({ status: "failed", error: expect.stringContaining("terminated with failure at node 'cleanup'") }),
      undefined,
    );
  });

  it("does NOT park for an ordinary failure with no pending-review value anywhere", async () => {
    /* The guard must stay narrow — a genuine execute failure still belongs to the terminal sink. */
    const { store, live, executor } = parkHarness();

    await (executor as never as { handleGraphFailure: (t: unknown, r: unknown) => Promise<void> })
      .handleGraphFailure(live, failureRun({ "node:execute:value": "implementation-incomplete" }));

    expect(store.handoffToReview).not.toHaveBeenCalled();
    /*
    FNXC:WorkflowExecutionOwnership 2026-07-30-10:40 (PR #2599 review — coderabbit):
    Assert the DISPOSITION, not only the absence of a park. "No review handoff" passes just as
    well for a run that silently did nothing, which is the failure mode this whole file exists to
    catch. Verified against the real path rather than assumed: both cases reach the terminal sink
    and park with the failure of the node that actually ended the walk.
    */
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-COMPAT",
      expect.objectContaining({ status: "failed", error: expect.stringContaining("terminated with failure at node 'cleanup'") }),
      undefined,
    );
  });
});

/*
FNXC:WorkflowExecutionOwnership 2026-07-30-10:55 (PR #2599 review — coderabbit, major):
A visited node id is not always the context key its value lives under. A foreach instance
(`steps#0:step-execute`) records under the CONTAINER key `node:steps:value`. The default coding
workflow IS a foreach, so a backward walk reading `node:<visitedId>:value` directly misses the
pending-review ending on exactly the shape it was written for — and then keeps walking, adopting
some earlier node's value as the run's verdict.
*/
describe("compat detection resolves foreach and optional-group context keys", () => {
  beforeEach(() => { resetExecutorMocks(); resetWorkflowEventBusForTesting(); });
  afterEach(() => resetWorkflowEventBusForTesting());

  function parkHarness() {
    const store = createMockStore();
    const live = { id: "FN-FE", column: "in-progress", status: null, error: null, steps: [], log: [], paused: false, userPaused: false } as unknown as TaskDetail;
    store.getTask.mockResolvedValue(live);
    store.handoffToReview = vi.fn().mockImplementation(async (id: string) => store.moveTask(id, "in-review"));
    return { store, live, executor: new TaskExecutor(store, "/tmp/test") };
  }

  it("finds a FOREACH instance's ending under its container key", async () => {
    const { store, live, executor } = parkHarness();

    await (executor as never as { handleGraphFailure: (t: unknown, r: unknown) => Promise<void> })
      .handleGraphFailure(live, {
        disposition: "failed" as const,
        outcome: "failure" as const,
        /* The walk must END elsewhere, or `graphFailureValue`'s own resolution answers first and
           the backward walk is never exercised — which is how my first version of this test
           passed with the fix reverted. */
        visitedNodeIds: ["steps#0:step-execute", "cleanup"],
        context: { "node:steps:value": "review-pending" },
      });

    expect(store.handoffToReview).toHaveBeenCalledWith("FN-FE", expect.anything());
  });

  it("finds an OPTIONAL-GROUP template ending under the group key", async () => {
    const { store, live, executor } = parkHarness();

    await (executor as never as { handleGraphFailure: (t: unknown, r: unknown) => Promise<void> })
      .handleGraphFailure(live, {
        disposition: "failed" as const,
        outcome: "failure" as const,
        visitedNodeIds: ["group::template", "cleanup"],
        context: { "node:group:value": "review-pending" },
      });

    expect(store.handoffToReview).toHaveBeenCalledWith("FN-FE", expect.anything());
  });
});
