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

  it("returns the unchanged routing outcome — announcing must not reroute", async () => {
    const { primitives, ctx } = harness({ taskDone: false, modifiedFiles: [], exit: "review-handoff-pending-review" });

    const result = await primitives.runCodingSession(ctx, TASK, { worktreePath: "/tmp/wt", branchName: "b" } as never);

    expect(result).toMatchObject({ outcome: "failure", value: "implementation-incomplete" });
  });

  /*
  The rule, asserted rather than remembered. `createDefaultNodeHandlers` prefers the primitives
  handler whenever primitives are supplied; `executeWorkflowGraph` always supplies them. If that
  preference is ever inverted or made conditional, every behavior wired to the primitives path
  silently stops running — the same failure that put the announcement on a dead seam.
  */
  it("prompt-node dispatch prefers the PRIMITIVES handler, so seam-only wiring is dead", () => {
    const handlers = readFileSync(new URL("../workflow-node-handlers.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    expect(handlers).toMatch(/deps\?\.primitives\s*\?\s*createPrimitivePromptLikeHandler/);

    const executor = readFileSync(new URL("../executor.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    expect(executor).toContain("primitives: this.createAuthoritativeWorkflowPrimitives(settings)");
  });
});
