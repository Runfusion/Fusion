import { describe, expect, it } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR } from "../builtin-coding-workflow-ir.js";
import { resolveWorkflowOptionalSteps } from "../workflow-optional-steps.js";
import type { WorkflowIr, WorkflowIrV2 } from "../workflow-ir-types.js";

const v1: WorkflowIr = {
  version: "v1",
  name: "legacy",
  nodes: [
    { id: "start", kind: "start" },
    { id: "end", kind: "end" },
  ],
  edges: [{ from: "start", to: "end" }],
};

function v2(optionalSteps?: WorkflowIrV2["optionalSteps"]): WorkflowIrV2 {
  return {
    version: "v2",
    name: "optional",
    columns: [{ id: "todo", name: "Todo", traits: [] }],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      { id: "end", kind: "end", column: "todo" },
    ],
    edges: [{ from: "start", to: "end" }],
    optionalSteps,
  };
}

describe("resolveWorkflowOptionalSteps", () => {
  it("resolves the builtin coding browser verification optional step", () => {
    expect(resolveWorkflowOptionalSteps(BUILTIN_CODING_WORKFLOW_IR)).toEqual([
      {
        templateId: "browser-verification",
        name: "Browser Verification",
        description: "Verify web application functionality using browser automation",
        icon: "globe",
        phase: "pre-merge",
        defaultOn: false,
      },
    ]);
  });

  it("skips unknown template ids", () => {
    expect(
      resolveWorkflowOptionalSteps(v2([
        { templateId: "missing" },
        { templateId: "browser-verification" },
      ])),
    ).toHaveLength(1);
  });

  it("returns an empty array for v1 and v2 workflows without optional steps", () => {
    expect(resolveWorkflowOptionalSteps(v1)).toEqual([]);
    expect(resolveWorkflowOptionalSteps(v2())).toEqual([]);
  });

  it("preserves declaration order and resolves plugin templates", () => {
    const result = resolveWorkflowOptionalSteps(
      v2([
        { templateId: "plugin:demo:first", defaultOn: true },
        { templateId: "browser-verification" },
      ]),
      [
        {
          id: "plugin:demo:first",
          name: "Plugin First",
          description: "Plugin optional verification",
          prompt: "Run plugin verification",
          category: "Quality",
          icon: "plug",
          phase: "post-merge",
        },
      ],
    );

    expect(result.map((step) => step.templateId)).toEqual([
      "plugin:demo:first",
      "browser-verification",
    ]);
    expect(result[0]).toMatchObject({
      name: "Plugin First",
      icon: "plug",
      phase: "post-merge",
      defaultOn: true,
    });
  });
});
