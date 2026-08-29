import { afterEach, describe, expect, it } from "vitest";
import {
  downgradeIrToV1IfPure,
  parseWorkflowIr,
} from "../workflows/workflow-ir.js";
import {
  __resetWorkflowExtensionRegistryForTests,
  getWorkflowExtensionRegistry,
} from "../workflows/workflow-extension-registry.js";
import { WORKFLOW_EXTENSION_SCHEMA_VERSION } from "../workflows/workflow-extension-types.js";
import type { WorkflowIrV2 } from "../workflows/workflow-ir-types.js";

function ir(overrides: Partial<WorkflowIrV2> = {}): WorkflowIrV2 {
  return {
    version: "v2",
    name: "extensions",
    columns: [{ id: "todo", name: "todo", traits: [] }],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      { id: "end", kind: "end", column: "todo" },
    ],
    edges: [{ from: "start", to: "end" }],
    ...overrides,
  };
}

describe("workflow IR extension metadata", () => {
  afterEach(() => {
    __resetWorkflowExtensionRegistryForTests();
  });

  it("accepts registered plugin-namespaced column and node extension metadata", () => {
    getWorkflowExtensionRegistry().register("workflow-pack", {
      extensionId: "role",
      name: "Role",
      kind: "column-metadata",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "failClosed",
    });
    getWorkflowExtensionRegistry().register("workflow-pack", {
      extensionId: "node-handler",
      name: "Node handler",
      kind: "node-handler",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "failClosed",
    });

    const parsed = parseWorkflowIr(ir({
      columns: [
        {
          id: "todo",
          name: "todo",
          traits: [],
          extensions: {
            "plugin:workflow-pack:role": { role: "lead" },
          },
        },
      ],
      nodes: [
        {
          id: "start",
          kind: "start",
          column: "todo",
          extensions: {
            "plugin:workflow-pack:node-handler": { handler: "plan" },
          },
        },
        { id: "end", kind: "end", column: "todo" },
      ],
    }));

    expect(parsed.version).toBe("v2");
    if (parsed.version !== "v2") throw new Error("expected v2");
    expect(parsed.columns[0].extensions?.["plugin:workflow-pack:role"]).toEqual({ role: "lead" });
    expect(parsed.nodes[0].extensions?.["plugin:workflow-pack:node-handler"]).toEqual({ handler: "plan" });
  });

  it("rejects unknown plugin-namespaced extension metadata keys", () => {
    expect(() =>
      parseWorkflowIr(ir({
        nodes: [
          {
            id: "start",
            kind: "start",
            column: "todo",
            extensions: { "plugin:workflow-pack:missing": {} },
          },
          { id: "end", kind: "end", column: "todo" },
        ],
      })),
    ).toThrow(/Workflow node 'start' extension key 'plugin:workflow-pack:missing' is not registered/);
  });

  it("rejects extension metadata keys outside the plugin namespace", () => {
    expect(() =>
      parseWorkflowIr(ir({
        columns: [
          {
            id: "todo",
            name: "todo",
            traits: [],
            extensions: { role: { role: "lead" } },
          },
        ],
      })),
    ).toThrow(/must be plugin-namespaced/);
  });

  it("rejects non-object extension metadata values", () => {
    getWorkflowExtensionRegistry().register("workflow-pack", {
      extensionId: "node-handler",
      name: "Node handler",
      kind: "node-handler",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "failClosed",
    });

    expect(() =>
      parseWorkflowIr(ir({
        nodes: [
          {
            id: "start",
            kind: "start",
            column: "todo",
            extensions: { "plugin:workflow-pack:node-handler": "plan" as never },
          },
          { id: "end", kind: "end", column: "todo" },
        ],
      })),
    ).toThrow(/metadata must be an object/);
  });

  it("requires enum extension fields to declare enumValues", () => {
    getWorkflowExtensionRegistry().register("workflow-pack", {
      extensionId: "role",
      name: "Role",
      kind: "column-metadata",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "failClosed",
      configSchema: { fields: [{ key: "role", type: "enum" }] },
    });

    expect(() =>
      parseWorkflowIr(ir({
        columns: [
          {
            id: "todo",
            name: "todo",
            traits: [],
            extensions: { "plugin:workflow-pack:role": { role: "lead" } },
          },
        ],
      })),
    ).toThrow(/field 'role' is enum but has no enumValues defined/);
  });

  it("rejects enum extension field values outside enumValues", () => {
    getWorkflowExtensionRegistry().register("workflow-pack", {
      extensionId: "role",
      name: "Role",
      kind: "column-metadata",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "failClosed",
      configSchema: { fields: [{ key: "role", type: "enum", enumValues: ["lead", "executor"] }] },
    });

    expect(() =>
      parseWorkflowIr(ir({
        columns: [
          {
            id: "todo",
            name: "todo",
            traits: [],
            extensions: { "plugin:workflow-pack:role": { role: "reviewer" } },
          },
        ],
      })),
    ).toThrow(/must be one of: lead, executor/);
  });

  it("keeps v2 when otherwise-pure workflows carry extension metadata", () => {
    getWorkflowExtensionRegistry().register("workflow-pack", {
      extensionId: "role",
      name: "Role",
      kind: "column-metadata",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "failClosed",
    });

    const parsed = parseWorkflowIr(ir({
      columns: [
        {
          id: "triage",
          name: "triage",
          traits: [],
          extensions: { "plugin:workflow-pack:role": { role: "lead" } },
        },
        { id: "todo", name: "todo", traits: [] },
        { id: "in-progress", name: "in-progress", traits: [] },
        { id: "in-review", name: "in-review", traits: [] },
        { id: "done", name: "done", traits: [] },
        { id: "archived", name: "archived", traits: [] },
      ],
    }));

    expect(downgradeIrToV1IfPure(parsed).version).toBe("v2");
  });
});
