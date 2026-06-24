import { describe, expect, it } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR } from "../builtin-coding-workflow-ir.js";
import { BUILTIN_STEPWISE_CODING_WORKFLOW_IR } from "../builtin-stepwise-coding-workflow-ir.js";
import {
  resolveDefaultOnOptionalGroupIds,
  resolveWorkflowOptionalSteps,
} from "../workflow-optional-steps.js";
import type {
  WorkflowIr,
  WorkflowIrNode,
  WorkflowIrV2,
  WorkflowOptionalGroupConfig,
} from "../workflow-ir-types.js";

const v1: WorkflowIr = {
  version: "v1",
  name: "legacy",
  nodes: [
    { id: "start", kind: "start" },
    { id: "end", kind: "end" },
  ],
  edges: [{ from: "start", to: "end" }],
};

/** Build an optional-group node with a trivial single-prompt template. */
function optionalGroupNode(
  id: string,
  config: Partial<WorkflowOptionalGroupConfig>,
): WorkflowIrNode {
  return {
    id,
    kind: "optional-group",
    column: "todo",
    config: {
      ...config,
      template: config.template ?? {
        nodes: [{ id: `${id}-inner`, kind: "prompt" }],
        edges: [],
      },
    } satisfies WorkflowOptionalGroupConfig,
  };
}

function v2(extraNodes: WorkflowIrNode[] = []): WorkflowIrV2 {
  return {
    version: "v2",
    name: "optional",
    columns: [{ id: "todo", name: "Todo", traits: [] }],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      ...extraNodes,
      { id: "end", kind: "end", column: "todo" },
    ],
    edges: [{ from: "start", to: "end" }],
  };
}

describe("resolveWorkflowOptionalSteps (optional-group nodes)", () => {
  it("resolves two optional-group nodes with names + defaultOn from node config", () => {
    const ir = v2([
      optionalGroupNode("og-browser", { name: "Browser Verification", defaultOn: false }),
      optionalGroupNode("og-security", { name: "Security Audit", defaultOn: true }),
    ]);

    expect(resolveWorkflowOptionalSteps(ir)).toEqual([
      {
        templateId: "og-browser",
        name: "Browser Verification",
        description: "",
        phase: "pre-merge",
        defaultOn: false,
      },
      {
        templateId: "og-security",
        name: "Security Audit",
        description: "",
        phase: "pre-merge",
        defaultOn: true,
      },
    ]);
  });

  it("falls back to the node id when the group config omits a name", () => {
    const ir = v2([optionalGroupNode("og-unnamed", { defaultOn: true })]);
    const [resolved] = resolveWorkflowOptionalSteps(ir);
    expect(resolved.templateId).toBe("og-unnamed");
    expect(resolved.name).toBe("og-unnamed");
    expect(resolved.defaultOn).toBe(true);
  });

  it("returns an empty array for v1 and v2 workflows without optional-group nodes", () => {
    expect(resolveWorkflowOptionalSteps(v1)).toEqual([]);
    expect(resolveWorkflowOptionalSteps(v2())).toEqual([]);
  });

  it("ignores a malformed (config-less) optional-group node without crashing", () => {
    // A stale/partial optional-group node must not throw; it resolves to a
    // defaultOn:false entry keyed by its id rather than breaking workflow loading.
    const ir = v2([{ id: "og-bare", kind: "optional-group", column: "todo" }]);
    expect(resolveWorkflowOptionalSteps(ir)).toEqual([
      {
        templateId: "og-bare",
        name: "og-bare",
        description: "",
        phase: "pre-merge",
        defaultOn: false,
      },
    ]);
  });

  it("resolves the built-in coding/stepwise browser-verification optional-group (U6)", () => {
    // U6 migrated both built-ins: `browser-verification` is now an optional-group
    // node (default OFF), so the resolver advertises exactly one toggle entry per
    // built-in, keyed by the group node id `browser-verification`.
    const expected = [
      {
        templateId: "browser-verification",
        name: "Browser Verification",
        description: "",
        phase: "pre-merge" as const,
        defaultOn: false,
      },
    ];
    expect(resolveWorkflowOptionalSteps(BUILTIN_CODING_WORKFLOW_IR)).toEqual(expected);
    expect(resolveWorkflowOptionalSteps(BUILTIN_STEPWISE_CODING_WORKFLOW_IR)).toEqual(expected);
  });
});

describe("resolveDefaultOnOptionalGroupIds (task-creation seeding)", () => {
  it("returns exactly the defaultOn:true group ids", () => {
    const ir = v2([
      optionalGroupNode("og-off", { defaultOn: false }),
      optionalGroupNode("og-on-a", { defaultOn: true }),
      optionalGroupNode("og-on-b", { defaultOn: true }),
    ]);
    expect(resolveDefaultOnOptionalGroupIds(ir)).toEqual(["og-on-a", "og-on-b"]);
  });

  it("seeds an empty set when no optional-group has defaultOn (or none exist)", () => {
    expect(resolveDefaultOnOptionalGroupIds(v2())).toEqual([]);
    expect(
      resolveDefaultOnOptionalGroupIds(v2([optionalGroupNode("og-off", { defaultOn: false })])),
    ).toEqual([]);
    expect(resolveDefaultOnOptionalGroupIds(v1)).toEqual([]);
  });
});
