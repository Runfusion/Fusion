/*
FNXC:WorkflowLifecycleColumns 2026-07-27-23:50 (Phase B / slice B2):

merger-ai decides two things by literal column id:

  1. runAiMerge's already-finalized short circuit once compared only with `done`.
     Under a renamed workflow this stops matching and the already-finalized card falls
     through to `getTaskMergeBlocker`, which throws
     `Cannot merge FN-1: task is in 'shipped', must be in 'in-review'`.

     Observed, not assumed — that is the actual failure these tests produced
     against the literal code. So the consequence is NOT a silent re-merge (a
     downstream literal happens to catch it); it is a hard error blaming the
     card's column, on a task whose real state is "already done, nothing to do".
     The correct outcome is a clean no-op. Note the safety net is itself a
     literal (`must be in 'in-review'`) living in core's `getTaskMergeBlocker`,
     outside this slice — so it is a coincidence of two bugs, not a design.

  2. Four "finalize blocked → return the card to the backlog" rebounds
     (`moveTask(taskId, "todo", …)`), all of which park work for operator review
     after a no-commits / no-landed-proof / vetoed-no-op guard fires. Under a
     workflow with no `todo` column those moves target a column that does not
     exist.

The tests below were written against the literal implementation and observed
FAILING first. The rebound target is the KTD-10 `resolveReboundTarget` ordering
already used by self-healing.ts:714 and (in this slice) mesh-lease-manager, not
a new rule.

Scope note, stated rather than implied: the four rebound CALL SITES are wired to
the shared resolver but are not each driven end-to-end here. Reaching them
requires a real git repo plus a full merge run (see merger-ai.test.ts), and the
project's standing rule is not to add slow tests when a narrower seam exists.
What is asserted here is the resolver those four sites now share; what is NOT
asserted is that each site is reachable under a renamed workflow. That gap is
reported in the PR rather than papered over.
*/
import { describe, expect, it, vi } from "vitest";
import "@fusion/core";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { runAiMerge, resolveFinalizeReboundColumn } from "../merge/merger-ai.js";

const WF = "custom:wf";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "t",
    description: "",
    column: "in-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

/** No `todo` or `done` — every active lifecycle role is renamed. */
function renamedIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "inbox", label: "Inbox", traits: [{ trait: "intake" }] },
      { id: "drafting", label: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "building", label: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "reviewing", label: "Reviewing", traits: [{ trait: "merge" }] },
      { id: "shipped", label: "Shipped", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function defaultIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "triage", label: "Triage", traits: [{ trait: "intake" }] },
      { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", label: "In Progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "in-review", label: "In Review", traits: [{ trait: "merge" }] },
      { id: "done", label: "Done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function storeWith(current: Task, ir: WorkflowIr | undefined): TaskStore {
  const selection = { workflowId: WF, stepIds: [] };
  return {
    getTask: vi.fn(async () => current),
    listTasks: vi.fn(async () => [current]),
    updateTask: vi.fn(async () => current),
    moveTask: vi.fn(async () => current),
    logEntry: vi.fn(async () => undefined),
    /*
    FNXC:MergeQueue 2026-08-09-22:51:
    A fake store that drives runAiMerge into the merger AI lane must expose emitUsageEvent because
    session telemetry is defensive in production. Stores rejected at the workspace guard do not reach it.
    */
    emitUsageEvent: vi.fn(async () => true),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => (ir ? { ir } : null)),
  } as unknown as TaskStore;
}

describe("merger-ai under a renamed column vocabulary", () => {
  describe("already-finalized short circuit", () => {
    it("short-circuits a card resting in the RENAMED complete column", async () => {
      /* Under the literal this threw "task is in 'shipped', must be in
         'in-review'" instead of reporting the card was already finalized. */
      const current = task({ column: "shipped" });
      const store = storeWith(current, renamedIr());

      const result = await runAiMerge(store, "/tmp/root", "FN-1");

      expect(result.noOp).toBe(true);
      expect(result.ok).toBe(true);
      expect(result.reason).toBe("already-finalized");
    });

    it("does NOT short-circuit a card still in the renamed merge lane", async () => {
      /* The negative half: otherwise a conversion that returned "finalized" for
         everything would pass the two tests above. */
      const current = task({ column: "reviewing" });
      const store = storeWith(current, renamedIr());

      // It must get PAST the guard — whatever it then fails on is not this
      // test's concern, only that it did not report already-finalized.
      const result = await runAiMerge(store, "/tmp/root", "FN-1").catch((e: unknown) => e);

      const reason = (result as { reason?: string })?.reason;
      expect(reason).not.toBe("already-finalized");
    });

    it.each(["done"] as const)(
      "still short-circuits the builtin workflow's %s column (regression floor)",
      async (column) => {
        const current = task({ column });
        const store = storeWith(current, defaultIr());

        const result = await runAiMerge(store, "/tmp/root", "FN-1");

        expect(result.noOp).toBe(true);
        expect(result.reason).toBe("already-finalized");
      },
    );

    it("still short-circuits Done when the workflow cannot be resolved", async () => {
      /* Conservative fallback — an unresolvable workflow must keep the legacy
         completion id rather than losing the guard entirely. Losing it would
         re-merge a finished card, which is the worse direction to fail. */
      const current = task({ column: "done" });
      const store = storeWith(current, undefined);

      const result = await runAiMerge(store, "/tmp/root", "FN-1");

      expect(result.reason).toBe("already-finalized");
    });

    function partialIr(columns: Array<Record<string, unknown>>): WorkflowIr {
      return {
        version: "v2",
        id: WF,
        nodes: [],
        edges: [],
        columns: [
          { id: "drafting", label: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
          { id: "reviewing", label: "Reviewing", traits: [{ trait: "merge" }] },
          ...columns,
        ],
      } as unknown as WorkflowIr;
    }

    it("uses the declared renamed complete column", async () => {
      const ir = partialIr([{ id: "shipped", label: "Shipped", traits: [{ trait: "complete" }] }]);
      const shipped = storeWith(task({ column: "shipped" }), ir);
      expect((await runAiMerge(shipped, "/tmp/root", "FN-1")).reason).toBe("already-finalized");
    });

    it("keeps the legacy Done fallback when a workflow declares no complete column", async () => {
      const done = storeWith(task({ column: "done" }), partialIr([]));
      expect((await runAiMerge(done, "/tmp/root", "FN-1")).reason).toBe("already-finalized");
    });

    it("does not treat a non-terminal column as finalized under a partial workflow", async () => {
      /* The negative half: a per-role fallback must not widen the guard into
         "anything not explicitly non-terminal is finalized". */
      const ir = partialIr([{ id: "shipped", label: "Shipped", traits: [{ trait: "complete" }] }]);
      const store = storeWith(task({ column: "reviewing" }), ir);

      const result = await runAiMerge(store, "/tmp/root", "FN-1").catch((e: unknown) => e);

      expect((result as { reason?: string })?.reason).not.toBe("already-finalized");
    });
  });

  describe("finalize-blocked rebound target", () => {
    it("returns a renamed review card to the workflow's WIP lane", async () => {
      const store = storeWith(task({ column: "reviewing" }), renamedIr());
      await expect(resolveFinalizeReboundColumn(store, "FN-1")).resolves.toBe("building");
    });

    it("returns builtin review work to in-progress instead of Planning", async () => {
      const store = storeWith(task(), defaultIr());
      await expect(resolveFinalizeReboundColumn(store, "FN-1")).resolves.toBe("in-progress");
    });

    it("contains the card in review when the workflow cannot be resolved", async () => {
      const store = storeWith(task(), undefined);
      await expect(resolveFinalizeReboundColumn(store, "FN-1")).resolves.toBe("in-progress");
    });

    it("contains the card in its live column when resolution throws", async () => {
      const store = {
        ...storeWith(task(), renamedIr()),
        getTaskWorkflowSelectionAsync: vi.fn(async () => {
          throw new Error("boom");
        }),
        getWorkflowDefinition: vi.fn(async () => {
          throw new Error("boom");
        }),
      } as unknown as TaskStore;

      await expect(resolveFinalizeReboundColumn(store, "FN-1")).resolves.toBe("in-progress");
    });
  });
});
