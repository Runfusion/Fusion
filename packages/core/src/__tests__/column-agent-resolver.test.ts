// @vitest-environment node
//
// column-agent plan U2 — the shared effective-agent resolver.
//
// Proves the full mode × own-settings matrix (KTD-2/KTD-5):
//   - override × own-settings present → column agent; override × bare → column.
//   - defer × own agentId → own; defer × complete model pair → own;
//     defer × lone provider (incomplete pair, no agentId) → column agent wins.
//   - no node.column / column without binding → own-settings or none.
//   - foreach instance inheritance + template-node own column wins.
//   - parseInstanceNodeId round-trip incl. templateNodeId containing ':'.
//   - two graphs differing only in binding diverge.

import { describe, expect, it } from "vitest";
import {
  instanceNodeId,
  parseInstanceNodeId,
  resolveColumnAgentBinding,
  resolveEffectiveAgent,
} from "../agents/column-agent-resolver.js";
import type {
  WorkflowColumnAgent,
  WorkflowIrEdge,
  WorkflowIrNode,
  WorkflowIrV2,
} from "../workflows/workflow-ir-types.js";

function v2(
  columns: WorkflowIrV2["columns"],
  nodes: WorkflowIrNode[],
  edges: WorkflowIrEdge[] = [],
): WorkflowIrV2 {
  return { version: "v2", name: "test", columns, nodes, edges };
}

const overrideBinding: WorkflowColumnAgent = { agentId: "col-agent", mode: "override" };
const deferBinding: WorkflowColumnAgent = { agentId: "col-agent", mode: "defer" };

describe("resolveEffectiveAgent — precedence matrix (U2)", () => {
  it("override × own settings present → column agent", () => {
    expect(
      resolveEffectiveAgent({
        binding: overrideBinding,
        ownAgentId: "own-agent",
        ownModelProvider: "anthropic",
        ownModelId: "claude-x",
      }),
    ).toEqual({ source: "column-agent", agentId: "col-agent" });
  });

  it("override × bare → column agent", () => {
    expect(resolveEffectiveAgent({ binding: overrideBinding })).toEqual({
      source: "column-agent",
      agentId: "col-agent",
    });
  });

  it("defer × own agentId only → own settings win", () => {
    expect(resolveEffectiveAgent({ binding: deferBinding, ownAgentId: "own-agent" })).toEqual({
      source: "own-settings",
    });
  });

  it("defer × complete own model pair only → own settings win", () => {
    expect(
      resolveEffectiveAgent({
        binding: deferBinding,
        ownModelProvider: "anthropic",
        ownModelId: "claude-x",
      }),
    ).toEqual({ source: "own-settings" });
  });

  it("defer × lone provider (incomplete pair, no agentId) → column agent wins", () => {
    // An incomplete pair does NOT count as own settings (KTD-5; matches
    // resolveExecutorSessionModel's both-present rule).
    expect(
      resolveEffectiveAgent({ binding: deferBinding, ownModelProvider: "anthropic" }),
    ).toEqual({ source: "column-agent", agentId: "col-agent" });
  });

  it("defer × lone modelId (incomplete pair, no agentId) → column agent wins", () => {
    // Symmetric incomplete-pair surface (FN-5893: assert the invariant across
    // ALL known surfaces, not only the provider-only reproduction).
    expect(resolveEffectiveAgent({ binding: deferBinding, ownModelId: "claude-x" })).toEqual({
      source: "column-agent",
      agentId: "col-agent",
    });
  });

  it("defer × bare → column agent wins", () => {
    expect(resolveEffectiveAgent({ binding: deferBinding })).toEqual({
      source: "column-agent",
      agentId: "col-agent",
    });
  });

  it("no binding × own settings → own-settings", () => {
    expect(resolveEffectiveAgent({ binding: undefined, ownAgentId: "own-agent" })).toEqual({
      source: "own-settings",
    });
  });

  it("no binding × bare → none", () => {
    expect(resolveEffectiveAgent({ binding: undefined })).toEqual({ source: "none" });
  });
});

describe("resolveColumnAgentBinding — lookup (U2)", () => {
  const ir = v2(
    [
      { id: "todo", name: "todo", traits: [] },
      { id: "review", name: "review", traits: [], agent: overrideBinding },
    ],
    [
      { id: "start", kind: "start", column: "todo" },
      { id: "work", kind: "prompt", column: "review", config: { prompt: "do" } },
      { id: "plain", kind: "prompt", column: "todo", config: { prompt: "do" } },
      { id: "nocol", kind: "prompt", config: { prompt: "do" } },
      { id: "end", kind: "end", column: "review" },
    ],
  );

  it("resolves the bound column's agent for a node declared in it", () => {
    expect(resolveColumnAgentBinding(ir, "work")).toEqual(overrideBinding);
  });

  it("returns undefined for a node in a column without a binding", () => {
    expect(resolveColumnAgentBinding(ir, "plain")).toBeUndefined();
  });

  it("returns undefined for a node with no declared column, even when other columns bind", () => {
    expect(resolveColumnAgentBinding(ir, "nocol")).toBeUndefined();
  });

  it("returns undefined for an unknown node id", () => {
    expect(resolveColumnAgentBinding(ir, "ghost")).toBeUndefined();
  });
});

describe("resolveColumnAgentBinding — foreach instance inheritance (U2)", () => {
  function foreachIr(opts: {
    foreachColumn?: string;
    templateNodeColumn?: string;
    reviewAgent?: WorkflowColumnAgent;
    todoAgent?: WorkflowColumnAgent;
  }): WorkflowIrV2 {
    return v2(
      [
        { id: "todo", name: "todo", traits: [], ...(opts.todoAgent ? { agent: opts.todoAgent } : {}) },
        { id: "review", name: "review", traits: [], ...(opts.reviewAgent ? { agent: opts.reviewAgent } : {}) },
      ],
      [
        { id: "start", kind: "start" },
        {
          id: "fe",
          kind: "foreach",
          ...(opts.foreachColumn ? { column: opts.foreachColumn } : {}),
          config: {
            source: "task-steps",
            template: {
              nodes: [
                {
                  id: "se",
                  kind: "prompt",
                  ...(opts.templateNodeColumn ? { column: opts.templateNodeColumn } : {}),
                  config: { seam: "step-execute" },
                },
                { id: "rev", kind: "step-review", config: { type: "code" } },
                { id: "exit", kind: "prompt" },
              ],
              edges: [],
            },
          },
        },
        { id: "end", kind: "end" },
      ],
    );
  }

  it("instance node inherits the enclosing foreach node's column binding", () => {
    const ir = foreachIr({ foreachColumn: "review", reviewAgent: overrideBinding });
    const nodeId = instanceNodeId("fe", 0, "se");
    expect(resolveColumnAgentBinding(ir, nodeId)).toEqual(overrideBinding);
  });

  it("template node's own declared column wins over inheritance", () => {
    const ir = foreachIr({
      foreachColumn: "review",
      reviewAgent: overrideBinding,
      templateNodeColumn: "todo",
      todoAgent: deferBinding,
    });
    const nodeId = instanceNodeId("fe", 1, "se");
    expect(resolveColumnAgentBinding(ir, nodeId)).toEqual(deferBinding);
  });

  it("instance node with no foreach column and no template column → no binding", () => {
    const ir = foreachIr({ reviewAgent: overrideBinding });
    const nodeId = instanceNodeId("fe", 0, "se");
    expect(resolveColumnAgentBinding(ir, nodeId)).toBeUndefined();
  });

  it("skips a candidate whose templateNodeId doesn't exist under the foreach", () => {
    // PR #1432 review: a bogus prefix candidate can name a real foreach while its
    // parsed templateNodeId resolves to nothing — it must be skipped, not treated
    // as inheriting the foreach's column.
    const ir = foreachIr({ foreachColumn: "review", reviewAgent: overrideBinding });
    expect(resolveColumnAgentBinding(ir, instanceNodeId("fe", 0, "nope"))).toBeUndefined();
  });

  it("resolves bindings when the foreach node id itself contains '#'", () => {
    // The instance-id format is delimiter-ambiguous; the resolver validates each
    // candidate split against real foreach nodes instead of trusting the first '#'
    // (PR #1432 review).
    const ir = foreachIr({ foreachColumn: "review", reviewAgent: overrideBinding });
    const fe = ir.nodes.find((n) => n.id === "fe");
    if (!fe) throw new Error("fixture foreach missing");
    fe.id = "fe#a";
    const nodeId = instanceNodeId("fe#a", 0, "se");
    expect(nodeId).toBe("fe#a#0:se");
    expect(resolveColumnAgentBinding(ir, nodeId)).toEqual(overrideBinding);
  });
});

describe("instanceNodeId / parseInstanceNodeId round-trip (U2)", () => {
  it("round-trips a simple instance id", () => {
    const id = instanceNodeId("fe", 3, "se");
    expect(id).toBe("fe#3:se");
    expect(parseInstanceNodeId(id)).toEqual({
      foreachNodeId: "fe",
      stepIndex: 3,
      templateNodeId: "se",
    });
  });

  it("round-trips when the templateNodeId itself contains ':'", () => {
    // Defensive: split on the FIRST ':' of the remainder, keep the rest.
    const id = instanceNodeId("fe", 2, "ns:inner:node");
    expect(id).toBe("fe#2:ns:inner:node");
    expect(parseInstanceNodeId(id)).toEqual({
      foreachNodeId: "fe",
      stepIndex: 2,
      templateNodeId: "ns:inner:node",
    });
  });

  it("returns undefined for non-instance ids", () => {
    expect(parseInstanceNodeId("plain")).toBeUndefined();
    expect(parseInstanceNodeId("fe#3")).toBeUndefined();
    expect(parseInstanceNodeId("fe#:se")).toBeUndefined();
    expect(parseInstanceNodeId("fe#x:se")).toBeUndefined();
  });
});

describe("two graphs differing only in binding diverge (U2)", () => {
  function graph(reviewAgent?: WorkflowColumnAgent): WorkflowIrV2 {
    return v2(
      [
        { id: "todo", name: "todo", traits: [] },
        { id: "review", name: "review", traits: [], ...(reviewAgent ? { agent: reviewAgent } : {}) },
      ],
      [
        { id: "start", kind: "start", column: "todo" },
        { id: "work", kind: "prompt", column: "review", config: { prompt: "do" } },
        { id: "end", kind: "end", column: "review" },
      ],
    );
  }

  it("the effective agent diverges when only the binding differs", () => {
    const bound = graph(overrideBinding);
    const unbound = graph();
    // Same node, same own settings, different graph binding → different verdict.
    const own = { ownAgentId: "task-agent" } as const;
    const boundResult = resolveEffectiveAgent({
      binding: resolveColumnAgentBinding(bound, "work"),
      ...own,
    });
    const unboundResult = resolveEffectiveAgent({
      binding: resolveColumnAgentBinding(unbound, "work"),
      ...own,
    });
    expect(boundResult).toEqual({ source: "column-agent", agentId: "col-agent" });
    expect(unboundResult).toEqual({ source: "own-settings" });
    expect(boundResult).not.toEqual(unboundResult);
  });
});
