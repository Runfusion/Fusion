import { describe, expect, it } from "vitest";
import {
  parseWorkflowIr,
  serializeWorkflowIr,
  downgradeIrToV1IfPure,
  WorkflowIrError,
} from "../workflows/workflow-ir.js";
import type {
  WorkflowIrEdge,
  WorkflowIrNode,
  WorkflowIrV2,
} from "../workflows/workflow-ir-types.js";

// Step-inversion (U1) — foreach / step-review / parse-steps / code / rework /
// fields validation.

const defaultColumns: WorkflowIrV2["columns"] = [
  { id: "todo", name: "todo", traits: [] },
  { id: "in-progress", name: "in-progress", traits: [] },
];

function v2(
  nodes: WorkflowIrNode[],
  edges: WorkflowIrEdge[],
  extra: Partial<WorkflowIrV2> = {},
): WorkflowIrV2 {
  return { version: "v2", name: "test", columns: defaultColumns, nodes, edges, ...extra };
}

/** A minimal valid foreach template: step-execute → step-review(approve→exit). */
function stepTemplate(): { nodes: WorkflowIrNode[]; edges: WorkflowIrEdge[] } {
  return {
    nodes: [
      { id: "se", kind: "prompt", config: { seam: "step-execute" } },
      { id: "rev", kind: "step-review", config: { type: "code" } },
      { id: "exit", kind: "prompt" },
    ],
    edges: [
      { from: "se", to: "rev" },
      { from: "rev", to: "exit", condition: "outcome:approve" },
      { from: "rev", to: "se", condition: "outcome:revise", kind: "rework" },
    ],
  };
}

/** A graph: start → parse-steps → foreach → end. */
function graphWithForeach(
  foreachConfig: Record<string, unknown>,
  extra: Partial<WorkflowIrV2> = {},
): WorkflowIrV2 {
  return v2(
    [
      { id: "start", kind: "start" },
      { id: "ps", kind: "parse-steps", config: { artifact: "PROMPT.md", parser: "step-headings" } },
      { id: "fe", kind: "foreach", config: { source: "task-steps", template: stepTemplate(), ...foreachConfig } },
      { id: "end", kind: "end" },
    ],
    [
      { from: "start", to: "ps" },
      { from: "ps", to: "fe" },
      { from: "fe", to: "end" },
    ],
    extra,
  );
}

describe("foreach validation", () => {
  it("parses a valid foreach dominated by parse-steps", () => {
    const ir = parseWorkflowIr(graphWithForeach({})) as WorkflowIrV2;
    expect(ir.version).toBe("v2");
    const fe = ir.nodes.find((n) => n.id === "fe")!;
    expect(fe.kind).toBe("foreach");
  });

  it("rejects foreach with empty template", () => {
    const ir = graphWithForeach({ template: { nodes: [], edges: [] } });
    expect(() => parseWorkflowIr(ir)).toThrow(/non-empty/);
  });

  it("rejects template with two entry nodes", () => {
    const tmpl = {
      nodes: [
        { id: "a", kind: "prompt", config: { seam: "step-execute" } },
        { id: "b", kind: "prompt" },
      ] as WorkflowIrNode[],
      edges: [] as WorkflowIrEdge[],
    };
    expect(() => parseWorkflowIr(graphWithForeach({ template: tmpl }))).toThrow(
      /exactly one entry/,
    );
  });

  it("rejects template with two exit nodes", () => {
    const tmpl = {
      nodes: [
        { id: "a", kind: "prompt", config: { seam: "step-execute" } },
        { id: "b", kind: "prompt" },
        { id: "c", kind: "prompt" },
      ] as WorkflowIrNode[],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
      ] as WorkflowIrEdge[],
    };
    expect(() => parseWorkflowIr(graphWithForeach({ template: tmpl }))).toThrow(
      /exactly one (entry|exit)/,
    );
  });

  it("rejects nested foreach in a template", () => {
    const tmpl = {
      nodes: [
        { id: "inner", kind: "foreach", config: { source: "task-steps", template: stepTemplate() } },
      ] as WorkflowIrNode[],
      edges: [] as WorkflowIrEdge[],
    };
    expect(() => parseWorkflowIr(graphWithForeach({ template: tmpl }))).toThrow(
      /nested (loop\/)?foreach/,
    );
  });

  it("rejects step-execute at the top level", () => {
    const ir = v2(
      [
        { id: "start", kind: "start" },
        { id: "se", kind: "prompt", config: { seam: "step-execute" } },
        { id: "end", kind: "end" },
      ],
      [
        { from: "start", to: "se" },
        { from: "se", to: "end" },
      ],
    );
    expect(() => parseWorkflowIr(ir)).toThrow(/only legal inside a foreach template/);
  });

  it("rejects step-execute inside a split branch (extends SEAM_FORBIDDEN_IN_BRANCH)", () => {
    const tmpl = {
      nodes: [
        { id: "split", kind: "split" },
        { id: "se", kind: "prompt", config: { seam: "step-execute" } },
        { id: "other", kind: "prompt" },
        { id: "join", kind: "join" },
      ] as WorkflowIrNode[],
      edges: [
        { from: "split", to: "se" },
        { from: "split", to: "other" },
        { from: "se", to: "join" },
        { from: "other", to: "join" },
      ] as WorkflowIrEdge[],
    };
    expect(() => parseWorkflowIr(graphWithForeach({ template: tmpl }))).toThrow(
      /step-execute.*forbidden inside a parallel branch/,
    );
  });

  it("rejects a rework edge crossing the template boundary", () => {
    const tmpl = stepTemplate();
    // Point the rework edge at a node outside the template.
    tmpl.edges = tmpl.edges.map((e) =>
      e.kind === "rework" ? { ...e, to: "end" } : e,
    );
    expect(() => parseWorkflowIr(graphWithForeach({ template: tmpl }))).toThrow(
      /both endpoints inside the same template/,
    );
  });

  it("rejects a top-level rework edge", () => {
    const ir = v2(
      [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "end", kind: "end" },
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "end" },
        { from: "end", to: "a", kind: "rework" },
      ],
    );
    expect(() => parseWorkflowIr(ir)).toThrow(/only legal inside a foreach template/);
  });

  it("rejects foreach not dominated by a parse-steps node", () => {
    const ir = v2(
      [
        { id: "start", kind: "start" },
        { id: "fe", kind: "foreach", config: { source: "task-steps", template: stepTemplate() } },
        { id: "end", kind: "end" },
      ],
      [
        { from: "start", to: "fe" },
        { from: "fe", to: "end" },
      ],
    );
    expect(() => parseWorkflowIr(ir)).toThrow(/must be dominated by a parse-steps node/);
  });

  it("rejects foreach when parse-steps is only on one branch (not all paths)", () => {
    // start → split into (ps→join) and (direct→join), join → fe.
    const ir = v2(
      [
        { id: "start", kind: "start" },
        { id: "split", kind: "split" },
        { id: "ps", kind: "parse-steps", config: { artifact: "PROMPT.md", parser: "step-headings" } },
        { id: "direct", kind: "prompt" },
        { id: "join", kind: "join" },
        { id: "fe", kind: "foreach", config: { source: "task-steps", template: stepTemplate() } },
        { id: "end", kind: "end" },
      ],
      [
        { from: "start", to: "split" },
        { from: "split", to: "ps" },
        { from: "split", to: "direct" },
        { from: "ps", to: "join" },
        { from: "direct", to: "join" },
        { from: "join", to: "fe" },
        { from: "fe", to: "end" },
      ],
    );
    expect(() => parseWorkflowIr(ir)).toThrow(/must be dominated by a parse-steps node/);
  });
});

describe("foreach mode / isolation / concurrency", () => {
  it("rejects parallel + shared", () => {
    expect(() =>
      parseWorkflowIr(graphWithForeach({ mode: "parallel", isolation: "shared" })),
    ).toThrow(/cannot combine mode 'parallel' with isolation 'shared'/);
  });

  it("accepts parallel + worktree", () => {
    expect(() =>
      parseWorkflowIr(graphWithForeach({ mode: "parallel", isolation: "worktree", concurrency: 4 })),
    ).not.toThrow();
  });

  it("rejects concurrency on sequential mode", () => {
    expect(() =>
      parseWorkflowIr(graphWithForeach({ mode: "sequential", concurrency: 2 })),
    ).toThrow(/concurrency is only valid in 'parallel' mode/);
  });

  it("rejects concurrency out of range", () => {
    expect(() =>
      parseWorkflowIr(graphWithForeach({ mode: "parallel", isolation: "worktree", concurrency: 9 })),
    ).toThrow(/concurrency must be an integer in 1\.\.8/);
    expect(() =>
      parseWorkflowIr(graphWithForeach({ mode: "parallel", isolation: "worktree", concurrency: 0 })),
    ).toThrow(/concurrency must be an integer in 1\.\.8/);
  });
});

describe("foreach maxReworkCycles clamp", () => {
  it("rejects maxReworkCycles < 1", () => {
    expect(() => parseWorkflowIr(graphWithForeach({ maxReworkCycles: 0 }))).toThrow(
      /maxReworkCycles must be an integer >= 1/,
    );
  });

  it("clamps maxReworkCycles > 10 to 10", () => {
    const ir = parseWorkflowIr(graphWithForeach({ maxReworkCycles: 99 })) as WorkflowIrV2;
    const fe = ir.nodes.find((n) => n.id === "fe")!;
    expect((fe.config as { maxReworkCycles: number }).maxReworkCycles).toBe(10);
  });

  it("keeps maxReworkCycles <= 10 unchanged", () => {
    const ir = parseWorkflowIr(graphWithForeach({ maxReworkCycles: 5 })) as WorkflowIrV2;
    const fe = ir.nodes.find((n) => n.id === "fe")!;
    expect((fe.config as { maxReworkCycles: number }).maxReworkCycles).toBe(5);
  });
});

describe("step-review verdict routing", () => {
  function templateWithReview(reviewEdges: WorkflowIrEdge[]): WorkflowIrV2 {
    const tmpl = {
      nodes: [
        { id: "se", kind: "prompt", config: { seam: "step-execute" } },
        { id: "rev", kind: "step-review", config: { type: "plan" } },
        { id: "exit", kind: "prompt" },
      ] as WorkflowIrNode[],
      edges: [{ from: "se", to: "rev" }, ...reviewEdges],
    };
    return graphWithForeach({ template: tmpl });
  }

  it("rejects step-review missing approve routing", () => {
    expect(() =>
      parseWorkflowIr(
        templateWithReview([
          { from: "rev", to: "se", condition: "outcome:revise", kind: "rework" },
          { from: "rev", to: "exit", condition: "outcome:other" },
        ]),
      ),
    ).toThrow(/must route outcome:approve/);
  });

  it("rejects step-review missing revise routing", () => {
    expect(() =>
      parseWorkflowIr(
        templateWithReview([{ from: "rev", to: "exit", condition: "outcome:approve" }]),
      ),
    ).toThrow(/must route outcome:revise/);
  });

  it("accepts approve+revise routing (rethink optional)", () => {
    expect(() =>
      parseWorkflowIr(
        templateWithReview([
          { from: "rev", to: "exit", condition: "outcome:approve" },
          { from: "rev", to: "se", condition: "outcome:revise", kind: "rework" },
        ]),
      ),
    ).not.toThrow();
  });

  it("rejects a verdict-authoring step-review inside a split branch (advisory-only)", () => {
    const tmpl = {
      nodes: [
        { id: "se", kind: "prompt", config: { seam: "step-execute" } },
        { id: "split", kind: "split" },
        { id: "advrev", kind: "step-review", config: { type: "code" } },
        { id: "other", kind: "prompt" },
        { id: "join", kind: "join" },
        { id: "exit", kind: "prompt" },
      ] as WorkflowIrNode[],
      edges: [
        { from: "se", to: "split" },
        { from: "split", to: "advrev" },
        { from: "split", to: "other" },
        // advisory review illegally carries approve routing
        { from: "advrev", to: "join", condition: "outcome:approve" },
        { from: "other", to: "join" },
        { from: "join", to: "exit" },
      ] as WorkflowIrEdge[],
    };
    expect(() => parseWorkflowIr(graphWithForeach({ template: tmpl }))).toThrow(
      /advisory-only/,
    );
  });

  it("accepts an advisory step-review inside a split branch without verdict routing", () => {
    const tmpl = {
      nodes: [
        { id: "se", kind: "prompt", config: { seam: "step-execute" } },
        { id: "split", kind: "split" },
        { id: "advrev", kind: "step-review", config: { type: "code" } },
        { id: "other", kind: "prompt" },
        { id: "join", kind: "join" },
        { id: "rev", kind: "step-review", config: { type: "code" } },
        { id: "exit", kind: "prompt" },
      ] as WorkflowIrNode[],
      edges: [
        { from: "se", to: "split" },
        { from: "split", to: "advrev" },
        { from: "split", to: "other" },
        { from: "advrev", to: "join" },
        { from: "other", to: "join" },
        { from: "join", to: "rev" },
        { from: "rev", to: "exit", condition: "outcome:approve" },
        { from: "rev", to: "se", condition: "outcome:revise", kind: "rework" },
      ] as WorkflowIrEdge[],
    };
    expect(() => parseWorkflowIr(graphWithForeach({ template: tmpl }))).not.toThrow();
  });
});

describe("parse-steps validation", () => {
  it("rejects parse-steps with empty parser", () => {
    const ir = graphWithForeach({});
    (ir.nodes.find((n) => n.id === "ps")!.config as Record<string, unknown>).parser = "";
    expect(() => parseWorkflowIr(ir)).toThrow(/non-empty parser/);
  });

  it("rejects parse-steps referencing an undeclared artifact", () => {
    const ir = graphWithForeach({}, { artifacts: [{ key: "OTHER.md" }] });
    expect(() => parseWorkflowIr(ir)).toThrow(/undeclared artifact 'PROMPT.md'/);
  });

  it("accepts parse-steps referencing a declared artifact", () => {
    const ir = graphWithForeach({}, { artifacts: [{ key: "PROMPT.md", role: "step-source" }] });
    expect(() => parseWorkflowIr(ir)).not.toThrow();
  });

  it("allows only PROMPT.md when no artifacts are declared", () => {
    const ir = graphWithForeach({});
    (ir.nodes.find((n) => n.id === "ps")!.config as Record<string, unknown>).artifact = "SPEC.md";
    expect(() => parseWorkflowIr(ir)).toThrow(/only 'PROMPT.md' is allowed/);
  });
});

describe("code node validation", () => {
  function graphWithCode(config: Record<string, unknown>): WorkflowIrV2 {
    return v2(
      [
        { id: "start", kind: "start" },
        { id: "c", kind: "code", config },
        { id: "end", kind: "end" },
      ],
      [
        { from: "start", to: "c" },
        { from: "c", to: "end" },
      ],
    );
  }

  it("rejects empty source", () => {
    expect(() => parseWorkflowIr(graphWithCode({ source: "" }))).toThrow(/non-empty source/);
  });

  it("rejects source over 64KB", () => {
    expect(() => parseWorkflowIr(graphWithCode({ source: "x".repeat(65537) }))).toThrow(
      /exceeds 65536/,
    );
  });

  it("accepts valid source and timeout", () => {
    expect(() =>
      parseWorkflowIr(graphWithCode({ source: "export default async () => ({})", timeoutMs: 30000 })),
    ).not.toThrow();
  });

  it("rejects timeoutMs out of range", () => {
    expect(() => parseWorkflowIr(graphWithCode({ source: "x", timeoutMs: 999 }))).toThrow(
      /timeoutMs must be an integer in 1000\.\.300000/,
    );
    expect(() => parseWorkflowIr(graphWithCode({ source: "x", timeoutMs: 300001 }))).toThrow(
      /timeoutMs must be an integer in 1000\.\.300000/,
    );
  });
});

describe("fields validation", () => {
  function graphWithFields(fields: unknown): WorkflowIrV2 {
    return v2(
      [
        { id: "start", kind: "start" },
        { id: "end", kind: "end" },
      ],
      [{ from: "start", to: "end" }],
      { fields: fields as WorkflowIrV2["fields"] },
    );
  }

  it("accepts well-formed fields", () => {
    expect(() =>
      parseWorkflowIr(
        graphWithFields([
          { id: "sev", name: "Severity", type: "enum", options: [{ value: "lo", label: "Low" }] },
          { id: "note", name: "Note", type: "text", render: { placement: "detail", widget: "textarea" } },
        ]),
      ),
    ).not.toThrow();
  });

  it("rejects duplicate field ids", () => {
    expect(() =>
      parseWorkflowIr(
        graphWithFields([
          { id: "a", name: "A", type: "string" },
          { id: "a", name: "A2", type: "number" },
        ]),
      ),
    ).toThrow(/duplicate field id 'a'/);
  });

  it("rejects unknown field type", () => {
    expect(() => parseWorkflowIr(graphWithFields([{ id: "a", name: "A", type: "color" }]))).toThrow(
      /unknown type 'color'/,
    );
  });

  it("requires options on enum/multi-enum", () => {
    expect(() => parseWorkflowIr(graphWithFields([{ id: "a", name: "A", type: "enum" }]))).toThrow(
      /must declare non-empty options/,
    );
    expect(() =>
      parseWorkflowIr(graphWithFields([{ id: "a", name: "A", type: "multi-enum", options: [] }])),
    ).toThrow(/must declare non-empty options/);
  });

  it("rejects options on non-enum types", () => {
    expect(() =>
      parseWorkflowIr(
        graphWithFields([{ id: "a", name: "A", type: "string", options: [{ value: "x", label: "X" }] }]),
      ),
    ).toThrow(/must not declare options/);
  });

  it("rejects bad render placement / widget", () => {
    expect(() =>
      parseWorkflowIr(graphWithFields([{ id: "a", name: "A", type: "string", render: { placement: "footer" } }])),
    ).toThrow(/render.placement 'footer' is not allowed/);
    expect(() =>
      parseWorkflowIr(graphWithFields([{ id: "a", name: "A", type: "string", render: { widget: "slider" } }])),
    ).toThrow(/render.widget 'slider' is not allowed/);
  });
});

describe("downgradeIrToV1IfPure refuses step-inversion features", () => {
  it("returns v2 unchanged for a graph with a foreach", () => {
    const ir = parseWorkflowIr(graphWithForeach({})) as WorkflowIrV2;
    expect(downgradeIrToV1IfPure(ir).version).toBe("v2");
  });

  it("returns v2 unchanged when fields/artifacts are declared even with pure-v1 nodes", () => {
    const ir = v2(
      [
        { id: "start", kind: "start", column: "todo" },
        { id: "end", kind: "end", column: "todo" },
      ],
      [{ from: "start", to: "end" }],
      { fields: [{ id: "a", name: "A", type: "string" }] },
    );
    expect(downgradeIrToV1IfPure(ir).version).toBe("v2");
  });
});

describe("JSON round-trip stability", () => {
  it("re-parses a serialized foreach graph identically", () => {
    const ir = parseWorkflowIr(graphWithForeach({ maxReworkCycles: 3 })) as WorkflowIrV2;
    const serialized = serializeWorkflowIr(ir);
    const reparsed = parseWorkflowIr(serialized) as WorkflowIrV2;
    expect(serializeWorkflowIr(reparsed)).toBe(serialized);
  });
});

describe("illegal cycle detection (rework exemption)", () => {
  it("still rejects a non-rework cycle at the top level", () => {
    const ir = v2(
      [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "b", kind: "prompt" },
        { id: "end", kind: "end" },
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "a" },
        { from: "a", to: "end" },
      ],
    );
    expect(() => parseWorkflowIr(ir)).toThrow(/illegal cycle/);
  });

  it("does not complain about the rework cycle inside a foreach template", () => {
    // graphWithForeach's template has a rework edge rev → se; should parse fine.
    expect(() => parseWorkflowIr(graphWithForeach({}))).not.toThrow();
  });
});
