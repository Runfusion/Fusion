import { describe, expect, it } from "vitest";
import { renameScriptReferencesInWorkflowIr, scriptCatalogFromSettings } from "../task-store/script-ops.js";
import type { WorkflowIr } from "../workflows/workflow-ir-types.js";

describe("terminal script catalog helpers", () => {
  it("rewrites top-level and recursively nested script references without mutating the source", () => {
    const ir = {
      version: "v2",
      name: "Nested scripts",
      columns: [{ id: "todo", name: "Todo", traits: [] }],
      nodes: [
        { id: "top", kind: "script", column: "todo", config: { scriptName: "build" } },
        { id: "other", kind: "script", column: "todo", config: { scriptName: "test" } },
        {
          id: "foreach", kind: "foreach", column: "todo", config: { source: "task-steps", template: { nodes: [
            { id: "loop", kind: "loop", config: { template: { nodes: [
              { id: "optional", kind: "optional-group", config: { template: { nodes: [
                { id: "deep", kind: "script", config: { scriptName: "build" } },
              ], edges: [] } } },
            ], edges: [] }, exitWhen: { type: "output-contains", value: "done" } } },
          ], edges: [] } } },
      ],
      edges: [],
    } as unknown as WorkflowIr;

    const renamed = renameScriptReferencesInWorkflowIr(ir, "build", "Build production");
    expect(JSON.stringify(renamed)).not.toContain('"scriptName":"build"');
    expect(JSON.stringify(renamed).match(/"scriptName":"Build production"/g)).toHaveLength(2);
    expect(JSON.stringify(renamed)).toContain('"scriptName":"test"');
    expect(JSON.stringify(ir).match(/"scriptName":"build"/g)).toHaveLength(2);
  });

  it("reads legacy command maps and includes only populated descriptions", () => {
    expect(scriptCatalogFromSettings({ scripts: { build: "pnpm build" } })).toEqual([
      { name: "build", command: "pnpm build" },
    ]);
    expect(scriptCatalogFromSettings({
      scripts: { build: "pnpm build", test: "pnpm test" },
      scriptMetadata: { build: { description: "Production bundle" }, test: {} },
    })).toEqual([
      { name: "build", command: "pnpm build", description: "Production bundle" },
      { name: "test", command: "pnpm test" },
    ]);
  });
});
