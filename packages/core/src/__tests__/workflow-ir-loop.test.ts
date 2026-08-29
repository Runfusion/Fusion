import { describe, expect, it } from "vitest";
import {
  parseWorkflowIr,
  serializeWorkflowIr,
} from "../workflows/workflow-ir.js";
import type { WorkflowIrEdge, WorkflowIrNode, WorkflowIrV2 } from "../workflows/workflow-ir-types.js";

const columns: WorkflowIrV2["columns"] = [{ id: "work", name: "Work", traits: [] }];

function loopTemplate(): { nodes: WorkflowIrNode[]; edges: WorkflowIrEdge[] } {
  return {
    nodes: [
      { id: "ask", kind: "prompt", config: { prompt: "try" } },
      { id: "check", kind: "gate", config: { prompt: "done?" } },
    ],
    edges: [{ from: "ask", to: "check" }],
  };
}

function loopIr(config: Record<string, unknown> = {}): WorkflowIrV2 {
  return {
    version: "v2",
    name: "loop-test",
    columns,
    nodes: [
      { id: "start", kind: "start" },
      {
        id: "repeat",
        kind: "loop",
        config: {
          maxIterations: 3,
          exitWhen: { type: "output-contains", value: "DONE" },
          template: loopTemplate(),
          ...config,
        },
      },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "repeat" },
      { from: "repeat", to: "end" },
    ],
  };
}

describe("loop validation", () => {
  it("parses and round-trips a valid loop node", () => {
    const parsed = parseWorkflowIr(loopIr()) as WorkflowIrV2;
    const loop = parsed.nodes.find((n) => n.id === "repeat");

    expect(loop?.kind).toBe("loop");
    expect(parseWorkflowIr(serializeWorkflowIr(parsed))).toEqual(parsed);
  });

  it("rejects a loop with an empty template", () => {
    expect(() => parseWorkflowIr(loopIr({ template: { nodes: [], edges: [] } }))).toThrow(/non-empty/);
  });

  it("rejects duplicate template node ids", () => {
    const template = loopTemplate();
    template.nodes.push({ id: "ask", kind: "script" });

    expect(() => parseWorkflowIr(loopIr({ template }))).toThrow(/duplicate node ids/);
  });

  it("rejects template edges that leave the template", () => {
    const template = loopTemplate();
    template.edges.push({ from: "check", to: "end" });

    expect(() => parseWorkflowIr(loopIr({ template }))).toThrow(/references a node outside/);
  });

  it("rejects nested loop and foreach regions", () => {
    const template = loopTemplate();
    template.nodes.push({
      id: "nested",
      kind: "loop",
      config: {
        exitWhen: { type: "output-contains", value: "DONE" },
        template: loopTemplate(),
      },
    });
    template.edges.push({ from: "check", to: "nested" });

    expect(() => parseWorkflowIr(loopIr({ template }))).toThrow(/nested loop\/foreach/);
  });

  it("rejects loop nodes inside foreach templates", () => {
    const ir: WorkflowIrV2 = {
      version: "v2",
      name: "foreach-loop-test",
      columns,
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "steps",
          kind: "foreach",
          config: {
            source: "task-steps",
            template: {
              nodes: [
                {
                  id: "nested-loop",
                  kind: "loop",
                  config: {
                    exitWhen: { type: "output-contains", value: "DONE" },
                    template: loopTemplate(),
                  },
                },
              ],
              edges: [],
            },
          },
        },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "steps" },
        { from: "steps", to: "end" },
      ],
    };

    expect(() => parseWorkflowIr(ir)).toThrow(/nested loop\/foreach/);
  });

  it("rejects foreach-only seams and normal cycles inside loop templates", () => {
    const seamTemplate = loopTemplate();
    seamTemplate.nodes[0] = { id: "ask", kind: "prompt", config: { seam: "step-execute" } };
    expect(() => parseWorkflowIr(loopIr({ template: seamTemplate }))).toThrow(/only legal inside a foreach/);

    const cyclicTemplate = loopTemplate();
    cyclicTemplate.nodes.unshift({ id: "init", kind: "prompt", config: { prompt: "init" } });
    cyclicTemplate.nodes.push({ id: "finish", kind: "gate", config: { prompt: "finished?" } });
    cyclicTemplate.edges.unshift({ from: "init", to: "ask" });
    cyclicTemplate.edges.push({ from: "check", to: "ask", condition: "failure" });
    cyclicTemplate.edges.push({ from: "check", to: "finish", condition: "success" });
    expect(() => parseWorkflowIr(loopIr({ template: cyclicTemplate }))).toThrow(/illegal cycle/);
  });

  it("rejects an invalid exit condition", () => {
    expect(() => parseWorkflowIr(loopIr({ exitWhen: { type: "output-contains", value: "" } }))).toThrow(
      /exitWhen.value/,
    );
    expect(() => parseWorkflowIr(loopIr({ exitWhen: { type: "output-matches", pattern: "[" } }))).toThrow(
      /exitWhen.pattern is invalid/,
    );
    expect(() =>
      parseWorkflowIr(loopIr({ exitWhen: { type: "output-matches", pattern: "(a+)+" } })),
    ).toThrow(/potentially unsafe/);
  });

  it("clamps high maxIterations and rejects invalid budgets", () => {
    const parsed = parseWorkflowIr(loopIr({ maxIterations: 99 })) as WorkflowIrV2;
    expect(parsed.nodes.find((n) => n.id === "repeat")?.config?.maxIterations).toBe(50);

    expect(() => parseWorkflowIr(loopIr({ maxIterations: 0 }))).toThrow(/maxIterations/);
    expect(() => parseWorkflowIr(loopIr({ timeoutMs: 0 }))).toThrow(/timeoutMs/);
  });

  it("still rejects illegal top-level cycles", () => {
    const ir = loopIr();
    ir.edges.push({ from: "repeat", to: "start", condition: "failure" });

    expect(() => parseWorkflowIr(ir)).toThrow(/illegal cycle/);
  });
});
