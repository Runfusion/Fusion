import { describe, expect, it } from "vitest";
import { BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR, type WorkflowIr, type WorkflowIrNode } from "@fusion/core";
import { workflowNodeRequiresWorktree } from "../workflows/workflow-node-execution-needs.js";

/*
FNXC:CodingIdeasV2Workflow 2026-08-24-05:35:
The ratchet FN-175 did not have. `execute-workflow-graph.ts` refuses any write-capable node once a
Code Review APPROVE exists (`workspace-review-seal-required`), because a passed review seals the
tree so nothing unreviewed reaches main. builtin:review-gated-coding routes code-review straight
into two write-capable nodes, so every task on it deadlocks the moment the review approves — and
nothing caught it, because its only coverage asserted graph shape by hand rather than running the
production classifier over the graph.

This test runs the REAL classifier over the real success chain. It fails if anyone ever moves a
write-capable gate after the review again.
*/

/** The executed node for a gate: an optional-group runs its template's inner node. */
function executableNodes(node: WorkflowIrNode): Array<{ node: WorkflowIrNode; optionalGroupId?: string }> {
  const template = node.config?.template as { nodes?: WorkflowIrNode[] } | undefined;
  if (node.kind === "optional-group" && Array.isArray(template?.nodes)) {
    return template.nodes.map((inner) => ({ node: inner, optionalGroupId: node.id }));
  }
  return [{ node }];
}

function isWriteCapable(node: WorkflowIrNode): boolean {
  return executableNodes(node).some(({ node: executed, optionalGroupId }) =>
    workflowNodeRequiresWorktree(executed, { optionalGroupId }) || executed.kind === "code");
}

function successChainFrom(ir: WorkflowIr, start: string): WorkflowIrNode[] {
  const chain: WorkflowIrNode[] = [];
  const seen = new Set<string>();
  let current: string | undefined = start;
  while (current && !seen.has(current)) {
    seen.add(current);
    const edge = ir.edges.find((candidate) => candidate.from === current && candidate.condition === "success");
    if (!edge) break;
    const next = ir.nodes.find((node) => node.id === edge.to);
    if (next) chain.push(next);
    current = edge.to;
  }
  return chain;
}

describe("builtin:coding-ideas-v2 review seal", () => {
  const ir = BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR as WorkflowIr;

  it("has no write-capable node after Code Review", () => {
    const after = successChainFrom(ir, "code-review");
    // Guard the guard: an empty chain would make this assertion vacuously true. Everything the
    // review must cover now runs before it, so what remains downstream is the merge machinery.
    expect(after.map((node) => node.id)).toContain("merge-gate");

    const offenders = after.filter(isWriteCapable).map((node) => node.id);
    expect(offenders).toEqual([]);
  });

  /*
  FNXC:WorkflowReviewSeal 2026-08-25-10:20:
  The seal invariant became STRONGER, not weaker: the review lane now contains NO write-capable node
  at all, so there is nothing to order against Code Review.
  Previously two gates ran in in-review and had to be forced ahead of the review: a deterministic
  `verification` gate (classified write-capable only because the old predicate matched its display
  NAME), and `documentation-delivery`, which wrote repository docs. Verification is gone — Code
  Review runs the commands itself — and Documentation no longer touches the repository, so it may
  legally follow the review, which is the ordering its own author always intended.
  Assert the PREMISE too: an empty review lane would make this vacuously true.
  */
  it("runs no write-capable node anywhere in the review lane", () => {
    const reviewLane = ir.nodes.filter((node) => node.column === "in-review");
    expect(reviewLane.map((node) => node.id)).toEqual(expect.arrayContaining([
      "code-review", "documentation-delivery", "merge-gate",
    ]));

    /*
    `code-review` is itself write-capable and must stay so: the reviewer fixes findings inline, which
    happens BEFORE it issues its own verdict, so it cannot invalidate an approval that does not yet
    exist. The seal governs what runs AFTER the sealer — which is why it is the one exclusion here,
    and why the exclusion is named rather than filtered away silently.
    */
    const offenders = reviewLane.filter((node) => node.id !== "code-review" && isWriteCapable(node)).map((node) => node.id);
    expect(offenders, "no node other than the reviewer may write in the review lane").toEqual([]);
    expect(isWriteCapable(ir.nodes.find((node) => node.id === "code-review")!), "the reviewer keeps its inline-fix capability").toBe(true);
  });

  /*
  FNXC:WorkflowReviewSeal 2026-08-25-10:20:
  Documentation may follow the review ONLY because it cannot write the repository. If someone
  restores `toolMode: "coding"` here, the card silently regains the FN-175 shape: content mutating
  after the approval that is supposed to cover it. This is the assertion that catches that.
  */
  it("lets Documentation follow the review because it cannot write the repository", () => {
    const documentation = ir.nodes.find((node) => node.id === "documentation-delivery");
    expect(documentation, "documentation-delivery is missing").toBeDefined();
    expect(isWriteCapable(documentation!), "Documentation must not be write-capable if it runs after the review").toBe(false);

    const chain = successChainFrom(ir, "steps").map((node) => node.id);
    expect(chain.indexOf("code-review")).toBeLessThan(chain.indexOf("documentation-delivery"));
    expect(chain[chain.indexOf("documentation-delivery") + 1]).toBe("merge-gate");
  });
});
