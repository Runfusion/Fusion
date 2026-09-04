import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

const { listWorkflowRows } = vi.hoisted(() => ({
  listWorkflowRows: vi.fn(),
}));

vi.mock("../async-stores/async-workflow-store.js", () => ({ listWorkflowRows }));

import { readAllWorkflowDefinitionsImpl } from "../task-store/workflow-definitions.js";
import type { TaskStore } from "../store.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../workflows/builtin-coding-workflow-ir.js";
import { BUILTIN_WORKFLOWS } from "../workflows/builtin-workflows.js";
import type { WorkflowRow } from "../async-stores/async-workflow-store.js";

function workflowRow(description: string, ir = BUILTIN_CODING_WORKFLOW_IR): WorkflowRow {
  return {
    id: "WF-READ-THROUGH",
    name: "Read-through workflow",
    description,
    icon: "🔄",
    ir: JSON.stringify(ir),
    layout: JSON.stringify({ nodes: { "plan-task": { x: 12, y: 34 } } }),
    kind: "workflow",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function createStore(): TaskStore {
  return {
    getAsyncLayer: () => ({ projectId: "workflow-read-through" }),
    toWorkflowDefinition: (row: WorkflowRow) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      icon: row.icon ?? undefined,
      ir: JSON.parse(row.ir),
      layout: JSON.parse(row.layout),
      kind: row.kind ?? "workflow",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
    parseWorkflowLayout: (raw: string) => JSON.parse(raw),
  } as unknown as TaskStore;
}

describe("readAllWorkflowDefinitionsImpl", () => {
  it("re-reads custom rows on every call", async () => {
    const rows = [workflowRow("unchanged")];
    listWorkflowRows.mockImplementation(async () => rows);
    const store = createStore();

    const first = await readAllWorkflowDefinitionsImpl(store);
    const second = await readAllWorkflowDefinitionsImpl(store);

    expect(listWorkflowRows).toHaveBeenCalledTimes(2);
    expect(first).toEqual(second);
  });

  it("observes an out-of-band edit without mutating the prior result", async () => {
    const rows = [workflowRow("plugin workflow v0.75.0")];
    listWorkflowRows.mockImplementation(async () => rows);
    const store = createStore();

    const first = await readAllWorkflowDefinitionsImpl(store);
    const updatedIr = structuredClone(BUILTIN_CODING_WORKFLOW_IR);
    updatedIr.title = "Updated workflow IR";
    rows[0] = workflowRow("plugin workflow v0.79.0", updatedIr);
    const second = await readAllWorkflowDefinitionsImpl(store);

    const firstCustom = first.find((definition) => definition.id === "WF-READ-THROUGH");
    const secondCustom = second.find((definition) => definition.id === "WF-READ-THROUGH");
    expect(firstCustom?.description).toBe("plugin workflow v0.75.0");
    expect(firstCustom?.ir.title).not.toBe("Updated workflow IR");
    expect(secondCustom?.description).toBe("plugin workflow v0.79.0");
    expect(secondCustom?.ir).toEqual(updatedIr);
  });

  it("returns builtins in catalog order when no custom rows exist", async () => {
    listWorkflowRows.mockResolvedValue([]);

    expect(await readAllWorkflowDefinitionsImpl(createStore())).toEqual(BUILTIN_WORKFLOWS);
  });

  it("does not retain the removed per-instance cache construct", async () => {
    const sources = await Promise.all([
      readFile(new URL("../store.ts", import.meta.url), "utf8"),
      readFile(new URL("../task-store/workflow-definitions.ts", import.meta.url), "utf8"),
      readFile(new URL("../task-store/workflow-ops.ts", import.meta.url), "utf8"),
      readFile(new URL("../task-store/project-store-ops.ts", import.meta.url), "utf8"),
    ]);

    expect(sources.join("\n")).not.toContain("workflowDefinitionsCache");
  });
});
