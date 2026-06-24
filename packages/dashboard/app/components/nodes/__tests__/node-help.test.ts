import { describe, expect, it } from "vitest";
import { effectiveNodeKind, nodeHelpFor, nodeHelpForData } from "../node-help";
import type { WorkflowFlowNodeData } from "../WorkflowNodeTypes";

/** All editor kinds plus the graph-only IR kinds the help registry must cover.
 *  Kept inline (not imported from core) so a missing entry fails loudly here. */
const EDITOR_KINDS = [
  "start",
  "end",
  "prompt",
  "script",
  "gate",
  "merge",
  "hold",
  "split",
  "join",
  "foreach",
  "loop",
  "optional-group",
  "step-review",
  "parse-steps",
  "code",
  "notify",
] as const;

const GRAPH_ONLY_KINDS = [
  "merge-gate",
  "merge-attempt",
  "manual-merge-hold",
  "retry-backoff",
  "recovery-router",
  "branch-group-member-integration",
  "branch-group-promotion",
  "pr-create",
  "pr-respond",
  "pr-merge",
] as const;

describe("nodeHelpFor", () => {
  it("returns help for every editor node kind", () => {
    for (const kind of EDITOR_KINDS) {
      const help = nodeHelpFor(kind);
      expect(help, `missing help for editor kind ${kind}`).not.toBeNull();
      // Every node documents what it does and its I/O + edges.
      expect(help!.title).toBeTruthy();
      expect(help!.summary).toBeTruthy();
      expect(help!.inputs).toBeTruthy();
      expect(help!.outputs).toBeTruthy();
      expect(help!.edges).toBeTruthy();
    }
  });

  it("returns help for every graph-only policy node kind, flagged engine-managed", () => {
    for (const kind of GRAPH_ONLY_KINDS) {
      const help = nodeHelpFor(kind);
      expect(help, `missing help for graph-only kind ${kind}`).not.toBeNull();
      expect(help!.graphOnly).toBe(true);
    }
  });

  it("editor kinds are not flagged engine-managed", () => {
    for (const kind of EDITOR_KINDS) {
      expect(nodeHelpFor(kind)!.graphOnly).toBeFalsy();
    }
  });

  it("returns null for an unknown kind", () => {
    expect(nodeHelpFor("not-a-kind")).toBeNull();
  });

  it("describes branch-group promotion's single-managed-PR idempotency", () => {
    const help = nodeHelpFor("branch-group-promotion")!;
    expect(help.summary).toMatch(/single managed PR/i);
    expect(help.summary).toMatch(/never creates a second PR/i);
    expect(help.edges).toMatch(/merge attempt/i);
  });

  it("distinguishes member integration (off-switch exempt) from promotion (gated)", () => {
    expect(nodeHelpFor("branch-group-member-integration")!.summary).toMatch(/even when global auto-merge is off/i);
    expect(nodeHelpFor("branch-group-promotion")!.summary).toMatch(/[Gg]ated by group\/global auto-merge/);
  });

  it("merge gate documents its auto-on / auto-off routing", () => {
    const help = nodeHelpFor("merge-gate")!;
    expect(help.edges).toMatch(/auto-on/);
    expect(help.edges).toMatch(/auto-off/);
  });
});

describe("effectiveNodeKind / nodeHelpForData", () => {
  function data(kind: WorkflowFlowNodeData["kind"], irKind?: string): WorkflowFlowNodeData {
    return { kind, label: kind, ...(irKind ? { irKind } : {}) };
  }

  it("prefers the preserved IR kind over the collapsed editor kind", () => {
    // A branch-group-promotion node renders as a generic "merge" shape but
    // preserves its IR kind so the help stays specific.
    const d = data("merge", "branch-group-promotion");
    expect(effectiveNodeKind(d)).toBe("branch-group-promotion");
    expect(nodeHelpForData(d)!.title).toBe("Branch group · promotion");
  });

  it("falls back to the editor kind when no IR kind is preserved", () => {
    const d = data("merge");
    expect(effectiveNodeKind(d)).toBe("merge");
    expect(nodeHelpForData(d)!.title).toBe("Merge boundary");
  });
});
