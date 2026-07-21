/*
FNXC:WorkflowValidation 2026-07-18-22:35:
U2 — workflow IR validation hardening. Two axes:
  1. Save-time HARD ERRORS: node → nonexistent column; merge-blocker column with
     no reachable merge-class node; (route-level) column-delete-with-occupants;
     the creation-column rule (intake-else-first).
  2. CAPABILITY FLOOR: validation must PERMIT the operator's benchmark shape —
     review nodes in a hold column, bounded revise/retry caps as node config,
     a backward remediation edge across a column boundary, and a completion-
     summary node ordered after a review node in the same column. Anything the
     editor can express but validation rejects (or vice versa) is a U2 bug.
*/
import { describe, expect, it } from "vitest";

import {
  BUILTIN_CODING_WORKFLOW_IR,
  parseWorkflowIr,
  resolveCreationColumn,
} from "../index.js";
import type { WorkflowIr } from "../workflow-ir-types.js";
import { planReviewOptionalGroupNode } from "../builtin-plan-review-group.js";
import { completionSummaryNode } from "../builtin-completion-summary-node.js";
import { computeRemovedOccupiedColumns } from "../workflow-reconciliation.js";

// ── Save-time hard errors ─────────────────────────────────────────────────────

describe("workflow IR validation — node → nonexistent column (hard error)", () => {
  it("rejects a node assigned to a column the workflow does not declare", () => {
    const ir: WorkflowIr = {
      version: "v2",
      name: "bad-column",
      columns: [{ id: "todo", name: "Todo", traits: [{ trait: "intake" }] }],
      nodes: [
        { id: "start", kind: "start", column: "todo" },
        { id: "work", kind: "prompt", column: "nonexistent" },
        { id: "end", kind: "end", column: "todo" },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "end", condition: "success" },
      ],
    };
    expect(() => parseWorkflowIr(ir)).toThrow(/undefined column 'nonexistent'/);
  });
});

describe("workflow IR validation — merge-blocker reachability (hard error)", () => {
  const columns = [
    { id: "in-review", name: "In review", traits: [{ trait: "merge-blocker" }, { trait: "human-review" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ];

  it("rejects a merge-blocker column with no reachable merge-class node", () => {
    const ir: WorkflowIr = {
      version: "v2",
      name: "blocker-without-merge",
      columns,
      nodes: [
        { id: "start", kind: "start", column: "in-review" },
        { id: "review", kind: "prompt", column: "in-review" },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "review" },
        { from: "review", to: "end", condition: "success" },
      ],
    };
    expect(() => parseWorkflowIr(ir)).toThrow(/merge-blocker trait but the graph has\s+no reachable merge-class node/);
  });

  it("passes when a merge-class node is reachable from start", () => {
    const ir: WorkflowIr = {
      version: "v2",
      name: "blocker-with-merge",
      columns,
      nodes: [
        { id: "start", kind: "start", column: "in-review" },
        { id: "merge-gate", kind: "merge-gate", column: "in-review", config: { gate: "auto-merge" } },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "merge-gate" },
        { from: "merge-gate", to: "end", condition: "success" },
      ],
    };
    expect(() => parseWorkflowIr(ir)).not.toThrow();
  });

  it("does not fire for a merge-less docs-only workflow (no merge-blocker trait)", () => {
    const ir: WorkflowIr = {
      version: "v2",
      name: "docs-only",
      columns: [
        { id: "todo", name: "Todo", traits: [{ trait: "intake" }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "todo" },
        { id: "write", kind: "prompt", column: "todo" },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "write" },
        { from: "write", to: "end", condition: "success" },
      ],
    };
    expect(() => parseWorkflowIr(ir)).not.toThrow();
  });
});

describe("workflow IR validation — column-delete-with-occupants (route-level guard)", () => {
  it("computeRemovedOccupiedColumns surfaces per-column occupant counts", () => {
    const existing: WorkflowIr = {
      version: "v2",
      name: "before",
      columns: [
        { id: "todo", name: "Todo", traits: [{ trait: "intake" }] },
        { id: "review", name: "Review", traits: [] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [{ id: "start", kind: "start", column: "todo" }],
      edges: [],
    };
    const next: WorkflowIr = { ...existing, columns: [existing.columns![0], existing.columns![2]] };
    const removed = computeRemovedOccupiedColumns(existing, next, new Map([["review", 3]]));
    expect(removed).toEqual([{ columnId: "review", count: 3 }]);
  });

  it("does not flag a removed column that holds no occupants", () => {
    const existing: WorkflowIr = {
      version: "v2",
      name: "before",
      columns: [
        { id: "todo", name: "Todo", traits: [{ trait: "intake" }] },
        { id: "review", name: "Review", traits: [] },
      ],
      nodes: [{ id: "start", kind: "start", column: "todo" }],
      edges: [],
    };
    const next: WorkflowIr = { ...existing, columns: [existing.columns![0]] };
    expect(computeRemovedOccupiedColumns(existing, next, new Map([["review", 0]]))).toEqual([]);
  });
});

describe("workflow IR validation — creation column rule (intake-else-first)", () => {
  it("resolves the intake-flagged column when present", () => {
    const ir: WorkflowIr = {
      version: "v2",
      name: "with-intake",
      columns: [
        { id: "ideas", name: "Ideas", traits: [] },
        { id: "todo", name: "Todo", traits: [{ trait: "intake" }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [{ id: "start", kind: "start", column: "todo" }],
      edges: [],
    };
    expect(resolveCreationColumn(ir)?.id).toBe("todo");
  });

  it("falls back to the first column when no intake column exists (documented default)", () => {
    const ir: WorkflowIr = {
      version: "v2",
      name: "no-intake",
      columns: [
        { id: "backlog", name: "Backlog", traits: [] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [{ id: "start", kind: "start", column: "backlog" }],
      edges: [],
    };
    expect(resolveCreationColumn(ir)?.id).toBe("backlog");
  });

  it("returns undefined for a v1 / column-less IR", () => {
    const v1: WorkflowIr = {
      version: "v1",
      name: "legacy",
      nodes: [{ id: "start", kind: "start" }],
      edges: [],
    };
    expect(resolveCreationColumn(v1)).toBeUndefined();
  });
});

// ── Capability floor: validation MUST permit the benchmark shape ───────────────

describe("workflow IR validation — capability floor (benchmark shape permitted)", () => {
  it("passes the full built-in coding workflow (optional-group reviews, bounded caps, remediation edges, summary-after-review)", () => {
    // BUILTIN_CODING_WORKFLOW_IR is already parsed+validated; re-parsing proves the
    // canonical full-lifecycle shape survives U2's added rules unchanged (R8).
    expect(() => parseWorkflowIr(BUILTIN_CODING_WORKFLOW_IR)).not.toThrow();
  });

  it("permits a Plan Review optional-group node placed in a HOLD column (Plan Review in Todo)", () => {
    const ir: WorkflowIr = {
      version: "v2",
      name: "review-in-hold",
      columns: [
        { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
        { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "todo" },
        // The real Plan Review node builder, placed in the hold column.
        planReviewOptionalGroupNode("todo"),
        { id: "execute", kind: "prompt", column: "in-progress" },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "plan-review" },
        { from: "plan-review", to: "execute", condition: "success" },
        { from: "execute", to: "end", condition: "success" },
      ],
    };
    expect(() => parseWorkflowIr(ir)).not.toThrow();
  });

  it("permits bounded revise/retry caps as node config (replan cap, code-review cycles, merge retries)", () => {
    const ir: WorkflowIr = {
      version: "v2",
      name: "bounded-caps",
      columns: [
        { id: "in-review", name: "In review", traits: [{ trait: "merge-blocker" }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "in-review" },
        // merge retries = 3 as a retry-backoff cap.
        { id: "merge-gate", kind: "merge-gate", column: "in-review", config: { gate: "auto-merge" } },
        { id: "merge-retry", kind: "retry-backoff", column: "in-review", config: { policy: "merge", maxAttempts: 3 } },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "merge-gate" },
        { from: "merge-gate", to: "merge-retry", condition: "failure" },
        { from: "merge-gate", to: "end", condition: "success" },
        { from: "merge-retry", to: "end", condition: "success" },
      ],
    };
    expect(() => parseWorkflowIr(ir)).not.toThrow();
  });

  it("permits a remediation edge that moves the card BACKWARD across a column boundary (In-review → In-progress)", () => {
    const ir: WorkflowIr = {
      version: "v2",
      name: "backward-remediation",
      columns: [
        { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
        { id: "in-review", name: "In review", traits: [{ trait: "human-review" }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "in-progress" },
        { id: "execute", kind: "prompt", column: "in-progress" },
        { id: "review", kind: "prompt", column: "in-review" },
        { id: "fix", kind: "prompt", column: "in-progress" }, // remediation node in the backward column
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "execute" },
        { from: "execute", to: "review", condition: "success" },
        // The distinctive benchmark capability: a REVISE edge routing the card
        // backward from the In-review column to a node in the In-progress column.
        { from: "review", to: "fix", condition: "outcome:revise" },
        { from: "review", to: "end", condition: "success" },
        { from: "fix", to: "end", condition: "success" },
      ],
    };
    expect(() => parseWorkflowIr(ir)).not.toThrow();
  });

  it("permits a completion-summary node ordered AFTER a review node within the same column", () => {
    const ir: WorkflowIr = {
      version: "v2",
      name: "summary-after-review",
      columns: [
        { id: "in-review", name: "In review", traits: [{ trait: "human-review" }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "in-review" },
        { id: "review", kind: "prompt", column: "in-review" },
        completionSummaryNode("in-review"), // same column, ordered after review
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "review" },
        { from: "review", to: "completion-summary", condition: "success" },
        { from: "completion-summary", to: "end", condition: "success" },
      ],
    };
    expect(() => parseWorkflowIr(ir)).not.toThrow();
    // The summary node keeps its identity (engine keys behavior off it).
    const parsed = parseWorkflowIr(ir);
    expect(parsed.nodes.some((n) => n.id === "completion-summary")).toBe(true);
  });
});
