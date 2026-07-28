// @vitest-environment node
/*
FNXC:WorkflowResolvedColumns 2026-07-27-16:05 (U10 / R8):
The open-PR backward-move guard compared positions with `COLUMNS.indexOf(...)`, the legacy enum.
A workflow that RENAMES its review/implementation lanes yields -1 for both, and
`isBackwardMoveBlockedByOpenPr` returns false the moment either index is negative — so the guard
did not reject the move, it stopped existing, with a green suite and an orphaned GitHub PR as the
only evidence. This is the "a converted guard silently stops firing" failure mode the program's
risk table names, reached here through a rename rather than a conversion.

The guard must order columns by the TASK'S OWN workflow, falling back to the legacy enum only
when no workflow IR resolves.
*/

import { describe, it, expect, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import express from "express";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

/** A workflow with the default lifecycle SHAPE but renamed column ids. */
const RENAMED_IR = {
  version: "v2",
  id: "wf-renamed",
  name: "Renamed Flow",
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "staging", name: "Staging", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "signoff", name: "Sign-off", traits: [{ trait: "merge-blocker" }, { trait: "human-review" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
  nodes: [{ id: "start", kind: "start", column: "backlog" }],
  edges: [],
};

function buildStore(options: {
  taskColumn: string;
  workflowId?: string;
  prState?: string | null;
}): { store: TaskStore; moveTask: ReturnType<typeof vi.fn> } {
  const moveTask = vi.fn(async (_id: string, column: string) => ({
    id: "FN-001",
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
  }));

  const store = {
    getRootDir: vi.fn(() => process.cwd()),
    getProjectScopedPluginMcpServers: vi.fn(async () => []),
    getTask: vi.fn(async () => ({ id: "FN-001", column: options.taskColumn, dependencies: [], steps: [], currentStep: 0 })),
    getSettings: vi.fn(async () => ({})),
    getTaskWorkflowSelection: vi.fn(() => (options.workflowId ? { workflowId: options.workflowId } : undefined)),
    getWorkflowDefinition: vi.fn(async (id: string) =>
      id === "wf-renamed" ? { id, name: "Renamed Flow", kind: "workflow", ir: RENAMED_IR } : null,
    ),
    getActivePrEntityBySource: vi.fn(async () =>
      options.prState ? { id: "PR-1", state: options.prState, sourceType: "task", sourceId: "FN-001" } : null,
    ),
    moveTask,
  } as unknown as TaskStore;

  return { store, moveTask };
}

async function postMove(store: TaskStore, column: string) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return REQUEST(app, "POST", "/api/tasks/FN-001/move", JSON.stringify({ column }), {
    "content-type": "application/json",
  });
}

describe("task move route — open-PR backward guard uses the task's own column order", () => {
  it("blocks a backward move between RENAMED columns while a PR is open", async () => {
    const { store, moveTask } = buildStore({
      taskColumn: "signoff",
      workflowId: "wf-renamed",
      prState: "open",
    });

    const res = await postMove(store, "building");

    expect(res.status).toBe(409);
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("allows a FORWARD move between renamed columns with a PR open", async () => {
    const { store, moveTask } = buildStore({
      taskColumn: "building",
      workflowId: "wf-renamed",
      prState: "open",
    });

    const res = await postMove(store, "signoff");

    expect(res.status).toBe(200);
    expect(moveTask).toHaveBeenCalledTimes(1);
  });

  it("allows a backward move between renamed columns once no PR is active", async () => {
    const { store, moveTask } = buildStore({
      taskColumn: "signoff",
      workflowId: "wf-renamed",
      prState: null,
    });

    const res = await postMove(store, "building");

    expect(res.status).toBe(200);
    expect(moveTask).toHaveBeenCalledTimes(1);
  });

  it("still blocks the legacy in-review → in-progress backward move (default workflow)", async () => {
    const { store, moveTask } = buildStore({ taskColumn: "in-review", prState: "open" });

    const res = await postMove(store, "in-progress");

    expect(res.status).toBe(409);
    expect(moveTask).not.toHaveBeenCalled();
  });
});
