import { describe, expect, it } from "vitest";
import {
  parseWorkflowIr,
  serializeWorkflowIr,
  downgradeIrToV1IfPure,
  WorkflowIrError,
  DEFAULT_WORKFLOW_COLUMN_IDS,
} from "../workflows/workflow-ir.js";
import type {
  WorkflowIr,
  WorkflowIrV1,
  WorkflowIrV2,
  WorkflowIrNode,
  WorkflowIrEdge,
} from "../workflows/workflow-ir-types.js";
import { BUILTIN_WORKFLOWS } from "../workflows/builtin-workflows.js";

function v2(
  columns: WorkflowIrV2["columns"],
  nodes: WorkflowIrNode[],
  edges: WorkflowIrEdge[],
): WorkflowIrV2 {
  return { version: "v2", name: "test", columns, nodes, edges };
}

const startEnd: WorkflowIrNode[] = [
  { id: "start", kind: "start" },
  { id: "end", kind: "end" },
];

describe("parseWorkflowIr — v2 columns & placement", () => {
  it("parses a v2 graph with columns, placement and a hold node", () => {
    const ir = v2(
      [
        { id: "intake", name: "Intake", traits: [{ trait: "intake" }] },
        { id: "work", name: "Work", traits: [] },
      ],
      [
        { id: "start", kind: "start", column: "intake" },
        { id: "wait", kind: "hold", column: "intake", config: { release: "manual" } },
        { id: "end", kind: "end", column: "work" },
      ],
      [
        { from: "start", to: "wait" },
        { from: "wait", to: "end" },
      ],
    );
    const parsed = parseWorkflowIr(ir);
    expect(parsed.version).toBe("v2");
    expect(parsed).toEqual(ir);
  });

  it("rejects a node referencing an undefined column id", () => {
    const ir = v2(
      [{ id: "only", name: "Only", traits: [] }],
      [
        { id: "start", kind: "start", column: "only" },
        { id: "end", kind: "end", column: "ghost" },
      ],
      [{ from: "start", to: "end" }],
    );
    expect(() => parseWorkflowIr(ir)).toThrow(WorkflowIrError);
    expect(() => parseWorkflowIr(ir)).toThrow(/undefined column 'ghost'/);
  });

  it("rejects a dangling top-level edge with an unknown target node", () => {
    const ir = v2(
      [{ id: "only", name: "Only", traits: [] }],
      [
        { id: "start", kind: "start", column: "only" },
        { id: "a", kind: "prompt", column: "only" },
        { id: "end", kind: "end", column: "only" },
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "end" },
        { from: "a", to: "ghost" },
      ],
    );

    expect(() => parseWorkflowIr(ir)).toThrow(WorkflowIrError);
    expect(() => parseWorkflowIr(ir)).toThrow(
      /Workflow edge 'a' -> 'ghost' references undefined node 'ghost'/,
    );
  });

  it("rejects a dangling top-level edge with an unknown source node", () => {
    const ir = v2(
      [{ id: "only", name: "Only", traits: [] }],
      [
        { id: "start", kind: "start", column: "only" },
        { id: "a", kind: "prompt", column: "only" },
        { id: "end", kind: "end", column: "only" },
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "end" },
        { from: "ghost", to: "a" },
      ],
    );

    expect(() => parseWorkflowIr(ir)).toThrow(WorkflowIrError);
    expect(() => parseWorkflowIr(ir)).toThrow(
      /Workflow edge 'ghost' -> 'a' references undefined node 'ghost'/,
    );
  });

  it("does not false-positive on valid top-level edges or legal rework-region edges", () => {
    const validIr = v2(
      [{ id: "only", name: "Only", traits: [] }],
      [
        { id: "start", kind: "start", column: "only" },
        { id: "a", kind: "prompt", column: "only" },
        { id: "end", kind: "end", column: "only" },
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "end" },
      ],
    );
    const reworkIr = v2(
      [{ id: "only", name: "Only", traits: [] }],
      [
        { id: "start", kind: "start", column: "only" },
        {
          id: "head",
          kind: "hold",
          column: "only",
          config: { release: "external-event", reworkRegion: true, maxReworkCycles: 3 },
        },
        { id: "body", kind: "prompt", column: "only" },
        { id: "end", kind: "end", column: "only" },
      ],
      [
        { from: "start", to: "head" },
        { from: "head", to: "body", condition: "outcome:go" },
        { from: "head", to: "end", condition: "outcome:rework-exhausted" },
        { from: "body", to: "head", condition: "outcome:again", kind: "rework" },
      ],
    );

    expect(() => parseWorkflowIr(validIr)).not.toThrow();
    expect(() => parseWorkflowIr(reworkIr)).not.toThrow();
  });

  it("rejects duplicate column ids within a workflow", () => {
    const ir = v2(
      [
        { id: "dup", name: "A", traits: [] },
        { id: "dup", name: "B", traits: [] },
      ],
      startEnd,
      [{ from: "start", to: "end" }],
    );
    expect(() => parseWorkflowIr(ir)).toThrow(/duplicate column id 'dup'/);
  });

  it("validates optional node thinkingLevel values", () => {
    const valid = v2(
      [{ id: "only", name: "Only", traits: [] }],
      [
        { id: "start", kind: "start", column: "only" },
        { id: "a", kind: "prompt", column: "only", config: { thinkingLevel: "high" } },
        { id: "review", kind: "step-review", column: "only", config: { type: "code", thinkingLevel: "low" } },
        { id: "end", kind: "end", column: "only" },
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "review" },
        { from: "review", to: "end", condition: "outcome:approve" },
        { from: "review", to: "end", condition: "outcome:revise" },
      ],
    );
    expect(() => parseWorkflowIr(valid)).not.toThrow();

    const absent = v2(
      [{ id: "only", name: "Only", traits: [] }],
      [
        { id: "start", kind: "start", column: "only" },
        { id: "a", kind: "prompt", column: "only" },
        { id: "end", kind: "end", column: "only" },
      ],
      [{ from: "start", to: "a" }, { from: "a", to: "end" }],
    );
    expect(() => parseWorkflowIr(absent)).not.toThrow();

    const invalid = v2(
      [{ id: "only", name: "Only", traits: [] }],
      [
        { id: "start", kind: "start", column: "only" },
        { id: "a", kind: "prompt", column: "only", config: { thinkingLevel: "ultra" } },
        { id: "end", kind: "end", column: "only" },
      ],
      [{ from: "start", to: "a" }, { from: "a", to: "end" }],
    );
    expect(() => parseWorkflowIr(invalid)).toThrow(WorkflowIrError);
    expect(() => parseWorkflowIr(invalid)).toThrow(/Workflow node 'a' thinkingLevel must be one of/);
  });

  it("rejects duplicate top-level node ids before Map de-duplication can mask them", () => {
    const ir = v2(
      [{ id: "only", name: "Only", traits: [] }],
      [
        { id: "start", kind: "start", column: "only" },
        { id: "dup", kind: "prompt", column: "only" },
        { id: "dup", kind: "script", column: "only" },
        { id: "end", kind: "end", column: "only" },
      ],
      [
        { from: "start", to: "dup" },
        { from: "dup", to: "end" },
      ],
    );

    expect(() => parseWorkflowIr(ir)).toThrow(WorkflowIrError);
    expect(() => parseWorkflowIr(ir)).toThrow(/Workflow IR has duplicate node id 'dup'/);
  });
});

// FNXC:WorkflowOptionalGroup 2026-06-21-18:00:
// The legacy `optionalSteps` declaration field is retired. A legacy persisted
// `optionalSteps` key on an old v2 row is now TOLERATED — no longer validated or
// required — so old rows still parse as v2 (optional steps are graph-native
// `optional-group` nodes now).
describe("parseWorkflowIr — legacy optionalSteps tolerated", () => {
  const columns = DEFAULT_WORKFLOW_COLUMN_IDS.map((id) => ({ id, name: id, traits: [] }));
  const base = (): WorkflowIrV2 => v2(
    columns,
    [
      { id: "start", kind: "start", column: "todo" },
      { id: "end", kind: "end", column: "todo" },
    ],
    [{ from: "start", to: "end" }],
  );

  it("parses a legacy v2 row carrying an optionalSteps key without throwing", () => {
    const ir = {
      ...base(),
      // Legacy declaration shapes — including ones the old validator rejected —
      // are now ignored, not validated.
      optionalSteps: [
        { templateId: "browser-verification" },
        { defaultOn: "yes" },
        "nope",
      ],
    } as unknown as WorkflowIr;

    expect(() => parseWorkflowIr(ir)).not.toThrow();
    const parsed = parseWorkflowIr(ir);
    expect(parsed.version).toBe("v2");
    // The key passes through untouched (round-trips through serialize/parse).
    expect(JSON.parse(serializeWorkflowIr(parsed))).toEqual(ir);
  });

  it("upgrades v1 graphs without optionalSteps", () => {
    const parsed = parseWorkflowIr({
      version: "v1",
      name: "legacy",
      nodes: startEnd,
      edges: [{ from: "start", to: "end" }],
    });
    expect(parsed.version).toBe("v2");
    if (parsed.version !== "v2") throw new Error("expected v2");
    expect((parsed as { optionalSteps?: unknown }).optionalSteps).toBeUndefined();
  });
});

describe("parseWorkflowIr — v1 upgrade", () => {
  const v1: WorkflowIrV1 = {
    version: "v1",
    name: "legacy",
    nodes: [
      { id: "start", kind: "start" },
      { id: "execute", kind: "prompt", config: { seam: "execute" } },
      { id: "review", kind: "prompt", config: { seam: "review" } },
      { id: "merge", kind: "prompt", config: { seam: "merge" } },
      { id: "custom", kind: "prompt", config: { name: "Plan" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "execute" },
      { from: "execute", to: "review", condition: "success" },
      { from: "review", to: "merge", condition: "success" },
      { from: "merge", to: "custom", condition: "success" },
      { from: "custom", to: "end" },
    ],
  };

  it("upgrades a v1 graph to v2 with synthesized default columns", () => {
    const parsed = parseWorkflowIr(v1);
    expect(parsed.version).toBe("v2");
    if (parsed.version !== "v2") throw new Error("expected v2");
    expect(parsed.columns.map((c) => c.id)).toEqual([...DEFAULT_WORKFLOW_COLUMN_IDS]);
  });

  it("places nodes by seam (execute→in-progress, review/merge→in-review, others→todo)", () => {
    const parsed = parseWorkflowIr(v1);
    if (parsed.version !== "v2") throw new Error("expected v2");
    const byId = new Map(parsed.nodes.map((n) => [n.id, n]));
    expect(byId.get("execute")?.column).toBe("in-progress");
    expect(byId.get("review")?.column).toBe("in-review");
    expect(byId.get("merge")?.column).toBe("in-review");
    expect(byId.get("custom")?.column).toBe("todo");
    expect(byId.get("start")?.column).toBe("todo");
  });

  it("upgrade is idempotent (round-trips through serialize unchanged)", () => {
    const once = parseWorkflowIr(v1);
    const twice = parseWorkflowIr(serializeWorkflowIr(once));
    expect(twice).toEqual(once);
  });

  it("v1 fixtures still parse (back-compat)", () => {
    const minimal: WorkflowIr = {
      version: "v1",
      name: "min",
      nodes: startEnd,
      edges: [{ from: "start", to: "end" }],
    };
    expect(() => parseWorkflowIr(minimal)).not.toThrow();
  });
});

describe("downgradeIrToV1IfPure — rollback compat (#1405)", () => {
  const pureV1: WorkflowIrV1 = {
    version: "v1",
    name: "legacy",
    nodes: [
      { id: "start", kind: "start" },
      { id: "execute", kind: "prompt", config: { seam: "execute" } },
      { id: "review", kind: "prompt", config: { seam: "review" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "execute" },
      { from: "execute", to: "review", condition: "success" },
      { from: "review", to: "end", condition: "success" },
    ],
  };

  it("downgrades an upgraded pure-v1 graph back to the v1 shape", () => {
    const upgraded = parseWorkflowIr(pureV1);
    expect(upgraded.version).toBe("v2");
    const down = downgradeIrToV1IfPure(upgraded);
    expect(down.version).toBe("v1");
    // No synthesized `column` fields leak into the v1 shape.
    expect(down.nodes.every((n) => n.column === undefined)).toBe(true);
    // Lossless: a v2 binary re-upgrades it to the identical v2 graph.
    expect(parseWorkflowIr(serializeWorkflowIr(down))).toEqual(upgraded);
  });

  it("pre-v2 binaries (version-only guard) accept the downgraded shape", () => {
    const down = downgradeIrToV1IfPure(parseWorkflowIr(pureV1));
    expect(down.version).toBe("v1");
    // Simulate the pre-v2 hard reject of version !== 'v1'.
    expect(() => {
      if (down.version !== "v1") throw new WorkflowIrError("unsupported version");
    }).not.toThrow();
  });

  it("keeps v2 when a v2-only node kind is present", () => {
    const ir = v2(
      DEFAULT_WORKFLOW_COLUMN_IDS.map((id) => ({ id, name: id, traits: [] })),
      [
        { id: "start", kind: "start", column: "todo" },
        { id: "wait", kind: "hold", column: "todo", config: { release: "manual" } },
        { id: "end", kind: "end", column: "todo" },
      ],
      [
        { from: "start", to: "wait" },
        { from: "wait", to: "end" },
      ],
    );
    expect(downgradeIrToV1IfPure(parseWorkflowIr(ir)).version).toBe("v2");
  });

  it("keeps v2 when columns are customized (rename / extra / applied trait)", () => {
    const customName = v2(
      DEFAULT_WORKFLOW_COLUMN_IDS.map((id) => ({ id, name: id === "todo" ? "Backlog" : id, traits: [] })),
      [
        { id: "start", kind: "start", column: "todo" },
        { id: "end", kind: "end", column: "todo" },
      ],
      [{ from: "start", to: "end" }],
    );
    expect(downgradeIrToV1IfPure(parseWorkflowIr(customName)).version).toBe("v2");

    const withTrait = v2(
      DEFAULT_WORKFLOW_COLUMN_IDS.map((id) => ({
        id,
        name: id,
        traits: id === "todo" ? [{ trait: "intake" }] : [],
      })),
      [
        { id: "start", kind: "start", column: "todo" },
        { id: "end", kind: "end", column: "todo" },
      ],
      [{ from: "start", to: "end" }],
    );
    expect(downgradeIrToV1IfPure(parseWorkflowIr(withTrait)).version).toBe("v2");
  });

  it("keeps v2 when a node is placed off its default seam column", () => {
    const custom = v2(
      DEFAULT_WORKFLOW_COLUMN_IDS.map((id) => ({ id, name: id, traits: [] })),
      [
        { id: "start", kind: "start", column: "todo" },
        // execute seam defaults to in-progress; place it in done instead.
        { id: "exec", kind: "prompt", column: "done", config: { seam: "execute" } },
        { id: "end", kind: "end", column: "todo" },
      ],
      [
        { from: "start", to: "exec" },
        { from: "exec", to: "end" },
      ],
    );
    expect(downgradeIrToV1IfPure(parseWorkflowIr(custom)).version).toBe("v2");
  });

  it("returns a v1 input unchanged", () => {
    expect(downgradeIrToV1IfPure(pureV1)).toBe(pureV1);
  });
});

describe("parseWorkflowIr — notify nodes", () => {
  const cols = [{ id: "c", name: "C", traits: [] }];

  function notifyIr(config: Record<string, unknown> | undefined): WorkflowIrV2 {
    return v2(
      cols,
      [
        { id: "start", kind: "start", column: "c" },
        { id: "notify", kind: "notify", column: "c", config },
        { id: "end", kind: "end", column: "c" },
      ],
      [
        { from: "start", to: "notify" },
        { from: "notify", to: "end" },
      ],
    );
  }

  it("accepts a notify node with an event and optional templates", () => {
    expect(() =>
      parseWorkflowIr(
        notifyIr({
          event: "workflow-notify",
          title: "{{taskTitle}}",
          message: "Task {{taskId}} reached {{workflowName}}",
        }),
      ),
    ).not.toThrow();
  });

  it("accepts omitted message and title", () => {
    expect(() => parseWorkflowIr(notifyIr({ event: "custom-event" }))).not.toThrow();
  });

  it("rejects a notify node missing its event", () => {
    expect(() => parseWorkflowIr(notifyIr(undefined))).toThrow(
      /notify node 'notify' must declare a non-empty event/,
    );
  });

  it("rejects an empty notify event", () => {
    expect(() => parseWorkflowIr(notifyIr({ event: "   " }))).toThrow(/non-empty event/);
  });

  it("rejects non-string optional templates", () => {
    expect(() => parseWorkflowIr(notifyIr({ event: "workflow-notify", message: 42 }))).toThrow(
      /message must be a string/,
    );
    expect(() => parseWorkflowIr(notifyIr({ event: "workflow-notify", title: false }))).toThrow(
      /title must be a string/,
    );
  });

  it("keeps v2 when a notify node is present", () => {
    const parsed = parseWorkflowIr(notifyIr({ event: "workflow-notify" }));
    expect(downgradeIrToV1IfPure(parsed).version).toBe("v2");
  });
});

describe("parseWorkflowIr — ask-user / exit-gate nodes (FN-7579)", () => {
  const cols = [{ id: "c", name: "C", traits: [] }];

  it("accepts a well-formed graph using both new kinds", () => {
    const ir = v2(
      cols,
      [
        { id: "start", kind: "start", column: "c" },
        { id: "ask", kind: "ask-user", column: "c", config: { question: "Looks good?" } },
        { id: "exit", kind: "exit-gate", column: "c" },
        { id: "end", kind: "end", column: "c" },
      ],
      [
        { from: "start", to: "ask" },
        { from: "ask", to: "exit" },
        { from: "exit", to: "end" },
      ],
    );
    expect(() => parseWorkflowIr(ir)).not.toThrow();
  });

  it("keeps v2 when ask-user/exit-gate nodes are present (v2-only, not in V1_NODE_KINDS)", () => {
    const ir = v2(
      cols,
      [
        { id: "start", kind: "start", column: "c" },
        { id: "ask", kind: "ask-user", column: "c" },
        { id: "exit", kind: "exit-gate", column: "c" },
        { id: "end", kind: "end", column: "c" },
      ],
      [
        { from: "start", to: "ask" },
        { from: "ask", to: "exit" },
        { from: "exit", to: "end" },
      ],
    );
    const parsed = parseWorkflowIr(ir);
    expect(downgradeIrToV1IfPure(parsed).version).toBe("v2");
  });

  it("rejects an ask-user node with an empty question", () => {
    const ir = v2(
      cols,
      [
        { id: "start", kind: "start", column: "c" },
        { id: "ask", kind: "ask-user", column: "c", config: { question: "   " } },
        { id: "end", kind: "end", column: "c" },
      ],
      [
        { from: "start", to: "ask" },
        { from: "ask", to: "end" },
      ],
    );
    expect(() => parseWorkflowIr(ir)).toThrow(/ask-user node 'ask' question must be a non-empty string/);
  });

  it("accepts an ask-user node with no question (falls back to the default prompt)", () => {
    const ir = v2(
      cols,
      [
        { id: "start", kind: "start", column: "c" },
        { id: "ask", kind: "ask-user", column: "c" },
        { id: "end", kind: "end", column: "c" },
      ],
      [
        { from: "start", to: "ask" },
        { from: "ask", to: "end" },
      ],
    );
    expect(() => parseWorkflowIr(ir)).not.toThrow();
  });

  it("rejects an exit-gate node that cannot reach the terminal end node (stranded)", () => {
    const ir = v2(
      cols,
      [
        { id: "start", kind: "start", column: "c" },
        { id: "exit", kind: "exit-gate", column: "c" },
        { id: "dead", kind: "prompt", column: "c" },
        { id: "end", kind: "end", column: "c" },
      ],
      [
        { from: "start", to: "exit" },
        { from: "exit", to: "dead" },
        { from: "start", to: "end" },
      ],
    );
    expect(() => parseWorkflowIr(ir)).toThrow(/exit-gate node 'exit' must have a path to the terminal 'end' node/);
  });

  it("accepts a brainstorming loop composition: ask-user -> exit-gate (approved) or back to ask-user (refine)", () => {
    const ir = v2(
      cols,
      [
        { id: "start", kind: "start", column: "c" },
        {
          id: "ask",
          kind: "ask-user",
          column: "c",
          config: { question: "Anything to refine?", reworkRegion: true },
        },
        {
          id: "exit",
          kind: "exit-gate",
          column: "c",
          config: { condition: { type: "output-contains", value: "looks good" } },
        },
        { id: "end", kind: "end", column: "c" },
      ],
      [
        { from: "start", to: "ask" },
        { from: "ask", to: "exit" },
        { from: "exit", to: "end" },
        { from: "exit", to: "ask", kind: "rework" },
      ],
    );
    expect(() => parseWorkflowIr(ir)).not.toThrow();
  });
});

describe("parseWorkflowIr — hold release kinds", () => {
  const holdCols = [{ id: "c", name: "C", traits: [] }];
  function holdIr(release: unknown): WorkflowIrV2 {
    return v2(
      holdCols,
      [
        { id: "start", kind: "start", column: "c" },
        { id: "h", kind: "hold", column: "c", config: { release } },
        { id: "end", kind: "end", column: "c" },
      ],
      [
        { from: "start", to: "h" },
        { from: "h", to: "end" },
      ],
    );
  }

  it.each(["manual", "timer", "capacity", "dependency", "external-event"])(
    "accepts hold release '%s'",
    (release) => {
      expect(() => parseWorkflowIr(holdIr(release))).not.toThrow();
    },
  );

  it("rejects an unknown hold release kind", () => {
    expect(() => parseWorkflowIr(holdIr("teleport"))).toThrow(/unknown release kind 'teleport'/);
  });

  it("rejects a hold node missing its release config", () => {
    expect(() => parseWorkflowIr(holdIr(undefined))).toThrow(/unknown release kind/);
  });
});

describe("parseWorkflowIr — top-level rework region (U6/U9)", () => {
  const cols = [{ id: "c", name: "C", traits: [] }];

  // start → head(reworkRegion) → body → rework back to head; head also has a
  // forward `outcome:rework-exhausted` edge out of the loop. This is the PR
  // review-loop shape (await-review → pr-respond → rework back), generalized.
  function reworkIr(headConfig: Record<string, unknown> | undefined): WorkflowIrV2 {
    return v2(
      cols,
      [
        { id: "start", kind: "start", column: "c" },
        { id: "head", kind: "hold", column: "c", config: { release: "external-event", ...headConfig } },
        { id: "body", kind: "prompt", column: "c" },
        { id: "end", kind: "end", column: "c" },
      ],
      [
        { from: "start", to: "head" },
        { from: "head", to: "body", condition: "outcome:go" },
        { from: "head", to: "end", condition: "outcome:rework-exhausted" },
        { from: "body", to: "head", condition: "outcome:again", kind: "rework" },
      ],
    );
  }

  it("accepts a top-level rework edge into a reworkRegion head", () => {
    expect(() => parseWorkflowIr(reworkIr({ reworkRegion: true, maxReworkCycles: 5 }))).not.toThrow();
  });

  it("rejects a top-level rework edge whose head is not a reworkRegion", () => {
    expect(() => parseWorkflowIr(reworkIr(undefined))).toThrow(/only legal inside a foreach template/);
  });
});

describe("parseWorkflowIr — split/join parallelism (KTD-11)", () => {
  const cols = [{ id: "c", name: "C", traits: [] }];

  function p(nodes: WorkflowIrNode[], edges: WorkflowIrEdge[]): WorkflowIrV2 {
    return v2(cols, nodes, edges);
  }

  it("parses a balanced split → two branches → join", () => {
    const ir = p(
      [
        { id: "start", kind: "start", column: "c" },
        { id: "split", kind: "split", column: "c" },
        { id: "a", kind: "prompt", column: "c" },
        { id: "b", kind: "prompt", column: "c" },
        { id: "join", kind: "join", column: "c", config: { mode: "all" } },
        { id: "end", kind: "end", column: "c" },
      ],
      [
        { from: "start", to: "split" },
        { from: "split", to: "a" },
        { from: "split", to: "b" },
        { from: "a", to: "join" },
        { from: "b", to: "join" },
        { from: "join", to: "end" },
      ],
    );
    expect(() => parseWorkflowIr(ir)).not.toThrow();
  });

  it("parses one nested level of split/join", () => {
    const ir = p(
      [
        { id: "start", kind: "start", column: "c" },
        { id: "s1", kind: "split", column: "c" },
        { id: "a", kind: "prompt", column: "c" },
        { id: "s2", kind: "split", column: "c" },
        { id: "n1", kind: "prompt", column: "c" },
        { id: "n2", kind: "prompt", column: "c" },
        { id: "j2", kind: "join", column: "c", config: { mode: "all" } },
        { id: "j1", kind: "join", column: "c", config: { mode: "all" } },
        { id: "end", kind: "end", column: "c" },
      ],
      [
        { from: "start", to: "s1" },
        { from: "s1", to: "a" },
        { from: "s1", to: "s2" },
        { from: "a", to: "j1" },
        { from: "s2", to: "n1" },
        { from: "s2", to: "n2" },
        { from: "n1", to: "j2" },
        { from: "n2", to: "j2" },
        { from: "j2", to: "j1" },
        { from: "j1", to: "end" },
      ],
    );
    expect(() => parseWorkflowIr(ir)).not.toThrow();
  });

  it("rejects a split without a reachable matching join", () => {
    const ir = p(
      [
        { id: "start", kind: "start", column: "c" },
        { id: "split", kind: "split", column: "c" },
        { id: "a", kind: "prompt", column: "c" },
        { id: "b", kind: "prompt", column: "c" },
        { id: "end", kind: "end", column: "c" },
      ],
      [
        { from: "start", to: "split" },
        { from: "split", to: "a" },
        { from: "split", to: "b" },
        { from: "a", to: "end" },
        { from: "b", to: "end" },
      ],
    );
    expect(() => parseWorkflowIr(ir)).toThrow(/no reachable matching join/);
  });

  it("rejects an execute seam node inside a branch (seam-in-branch)", () => {
    const ir = p(
      [
        { id: "start", kind: "start", column: "c" },
        { id: "split", kind: "split", column: "c" },
        { id: "exec", kind: "prompt", column: "c", config: { seam: "execute" } },
        { id: "b", kind: "prompt", column: "c" },
        { id: "join", kind: "join", column: "c", config: { mode: "all" } },
        { id: "end", kind: "end", column: "c" },
      ],
      [
        { from: "start", to: "split" },
        { from: "split", to: "exec" },
        { from: "split", to: "b" },
        { from: "exec", to: "join" },
        { from: "b", to: "join" },
        { from: "join", to: "end" },
      ],
    );
    expect(() => parseWorkflowIr(ir)).toThrow(/seam 'execute'.*forbidden inside a parallel branch/);
  });

  it("rejects a merge seam node inside a branch (seam-in-branch)", () => {
    const ir = p(
      [
        { id: "start", kind: "start", column: "c" },
        { id: "split", kind: "split", column: "c" },
        { id: "mg", kind: "prompt", column: "c", config: { seam: "merge" } },
        { id: "b", kind: "prompt", column: "c" },
        { id: "join", kind: "join", column: "c", config: { mode: "all" } },
        { id: "end", kind: "end", column: "c" },
      ],
      [
        { from: "start", to: "split" },
        { from: "split", to: "mg" },
        { from: "split", to: "b" },
        { from: "mg", to: "join" },
        { from: "b", to: "join" },
        { from: "join", to: "end" },
      ],
    );
    expect(() => parseWorkflowIr(ir)).toThrow(/seam 'merge'.*forbidden inside a parallel branch/);
  });

  it("rejects quorum(n) with n exceeding the branch count", () => {
    const ir = p(
      [
        { id: "start", kind: "start", column: "c" },
        { id: "split", kind: "split", column: "c" },
        { id: "a", kind: "prompt", column: "c" },
        { id: "b", kind: "prompt", column: "c" },
        { id: "join", kind: "join", column: "c", config: { mode: { quorum: 3 } } },
        { id: "end", kind: "end", column: "c" },
      ],
      [
        { from: "start", to: "split" },
        { from: "split", to: "a" },
        { from: "split", to: "b" },
        { from: "a", to: "join" },
        { from: "b", to: "join" },
        { from: "join", to: "end" },
      ],
    );
    expect(() => parseWorkflowIr(ir)).toThrow(/quorum\(3\) exceeds the split's 2 branches/);
  });

  it("accepts quorum(n) with n within the branch count", () => {
    const ir = p(
      [
        { id: "start", kind: "start", column: "c" },
        { id: "split", kind: "split", column: "c" },
        { id: "a", kind: "prompt", column: "c" },
        { id: "b", kind: "prompt", column: "c" },
        { id: "join", kind: "join", column: "c", config: { mode: { quorum: 2 } } },
        { id: "end", kind: "end", column: "c" },
      ],
      [
        { from: "start", to: "split" },
        { from: "split", to: "a" },
        { from: "split", to: "b" },
        { from: "a", to: "join" },
        { from: "b", to: "join" },
        { from: "join", to: "end" },
      ],
    );
    expect(() => parseWorkflowIr(ir)).not.toThrow();
  });
});

describe("parseWorkflowIr — version & shape guards", () => {
  it("rejects an unknown version", () => {
    expect(() => parseWorkflowIr({ version: "v3", name: "x", nodes: startEnd, edges: [] } as unknown as WorkflowIr)).toThrow(
      /version must be v1 or v2/,
    );
  });

  it("rejects missing start nodes", () => {
    const ir = v2([{ id: "c", name: "C", traits: [] }], [{ id: "end", kind: "end", column: "c" }], []);
    expect(() => parseWorkflowIr(ir)).toThrow(WorkflowIrError);
    expect(() => parseWorkflowIr(ir)).toThrow(/exactly one start and one end/);
  });

  it("rejects missing end nodes", () => {
    const ir = v2([{ id: "c", name: "C", traits: [] }], [{ id: "start", kind: "start", column: "c" }], []);
    expect(() => parseWorkflowIr(ir)).toThrow(WorkflowIrError);
    expect(() => parseWorkflowIr(ir)).toThrow(/exactly one start and one end/);
  });

  it("rejects illegal non-rework cycles", () => {
    const ir = v2(
      [{ id: "c", name: "C", traits: [] }],
      [
        { id: "start", kind: "start", column: "c" },
        { id: "a", kind: "prompt", column: "c" },
        { id: "b", kind: "prompt", column: "c" },
        { id: "end", kind: "end", column: "c" },
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    );

    expect(() => parseWorkflowIr(ir)).toThrow(WorkflowIrError);
    expect(() => parseWorkflowIr(ir)).toThrow(/illegal cycle.*edge 'b' -> 'a'/);
  });

  it("rejects unreachable required top-level nodes with the offending node id", () => {
    const ir = v2(
      [{ id: "c", name: "C", traits: [] }],
      [
        { id: "start", kind: "start", column: "c" },
        { id: "reachable", kind: "prompt", column: "c" },
        { id: "orphan", kind: "prompt", column: "c" },
        { id: "end", kind: "end", column: "c" },
      ],
      [
        { from: "start", to: "reachable" },
        { from: "reachable", to: "end" },
      ],
    );

    expect(() => parseWorkflowIr(ir)).toThrow(WorkflowIrError);
    expect(() => parseWorkflowIr(ir)).toThrow(/Workflow node 'orphan' is not reachable from the start node/);
  });

  it("rejects invalid parse-steps artifact references with the offending node and artifact", () => {
    const ir = v2(
      [{ id: "c", name: "C", traits: [] }],
      [
        { id: "start", kind: "start", column: "c" },
        { id: "parse", kind: "parse-steps", column: "c", config: { artifact: "missing.md", parser: "step-headings" } },
        { id: "end", kind: "end", column: "c" },
      ],
      [
        { from: "start", to: "parse" },
        { from: "parse", to: "end" },
      ],
    );

    expect(() => parseWorkflowIr(ir)).toThrow(WorkflowIrError);
    expect(() => parseWorkflowIr(ir)).toThrow(/parse-steps node 'parse' references artifact 'missing.md'/);
  });

  it("parses valid v2 graphs and every built-in workflow without false rejection", () => {
    const valid = v2(
      [{ id: "c", name: "C", traits: [] }],
      [
        { id: "start", kind: "start", column: "c" },
        { id: "custom", kind: "prompt", column: "c" },
        { id: "end", kind: "end", column: "c" },
      ],
      [
        { from: "start", to: "custom" },
        { from: "custom", to: "end" },
      ],
    );

    expect(() => parseWorkflowIr(valid)).not.toThrow();
    for (const workflow of BUILTIN_WORKFLOWS) {
      expect(() => parseWorkflowIr(workflow.ir)).not.toThrow();
    }
  });
});
