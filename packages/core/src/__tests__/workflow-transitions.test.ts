// @vitest-environment node
//
// Company-model U3: actor-aware movement rules (R5, AE4) and the company-board
// column-placement rules (R1/R2). These exercise the pure validators directly;
// the legacy default-workflow adjacency parity is covered by
// transition-parity.test.ts (untouched here).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  validateCompanyBoardMove,
  resolveAllowedColumns,
  type MoveActor,
} from "../workflow-transitions.js";
import { validateCompanyBoardColumnEdit, CompanyBoardColumnEditError } from "../workflow-reconciliation.js";
import { COMPANY_BOARD_TEMPLATE_IR } from "../company-board-template.js";
import { parseWorkflowIr } from "../workflow-ir.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";
import type { TaskStore } from "../store.js";
import type { WorkflowIr, WorkflowIrColumn } from "../workflow-ir-types.js";

const LEAD = "agent-lead";
const EXECUTOR = "agent-executor";
const REVIEWER = "agent-reviewer";

/** A company board IR with the three role columns staffed (so role resolution
 *  works) — mirrors what board-team-seed produces. */
function staffedCompanyIr(): WorkflowIr {
  if (COMPANY_BOARD_TEMPLATE_IR.version !== "v2") throw new Error("expected v2");
  const columns: WorkflowIrColumn[] = COMPANY_BOARD_TEMPLATE_IR.columns.map((c) => {
    if (c.role === "lead") return { ...c, agent: { agentId: LEAD, mode: "defer" } };
    if (c.role === "executor") return { ...c, agent: { agentId: EXECUTOR, mode: "defer" } };
    if (c.role === "reviewer") return { ...c, agent: { agentId: REVIEWER, mode: "defer" } };
    return c;
  });
  return parseWorkflowIr({ ...COMPANY_BOARD_TEMPLATE_IR, columns });
}

const human: MoveActor = { kind: "human" };
const asExecutor: MoveActor = { kind: "agent", agentId: EXECUTOR };
const asLead: MoveActor = { kind: "agent", agentId: LEAD };
const asReviewer: MoveActor = { kind: "agent", agentId: REVIEWER };

describe("U3 company-board movement rules (R5, AE4)", () => {
  const ir = staffedCompanyIr();

  it("AE4: executor-agent skip todo→in-review is rejected; human succeeds", () => {
    const rejection = validateCompanyBoardMove(ir, "todo", "in-review", asExecutor);
    expect(rejection?.reason).toBe("agent-skip-forward");
    // Same move by the human owner is unrestricted.
    expect(validateCompanyBoardMove(ir, "todo", "in-review", human)).toBeUndefined();
  });

  it("sequential: agent todo→in-progress (adjacent forward) succeeds", () => {
    expect(validateCompanyBoardMove(ir, "todo", "in-progress", asExecutor)).toBeUndefined();
  });

  it("backward: Reviewer in-review→in-progress succeeds", () => {
    expect(validateCompanyBoardMove(ir, "in-review", "in-progress", asReviewer)).toBeUndefined();
  });

  it("backward: Executor backward is rejected", () => {
    const rejection = validateCompanyBoardMove(ir, "in-review", "in-progress", asExecutor);
    expect(rejection?.reason).toBe("agent-backward-not-allowed");
  });

  it("backward: Lead may move to any earlier column", () => {
    expect(validateCompanyBoardMove(ir, "in-review", "todo", asLead)).toBeUndefined();
    expect(validateCompanyBoardMove(ir, "in-progress", "todo", asLead)).toBeUndefined();
  });

  it("non-company workflow is unaffected (validator no-ops)", () => {
    const plain = parseWorkflowIr({
      version: "v2",
      name: "plain",
      columns: [
        { id: "a", name: "A", traits: [] },
        { id: "b", name: "B", traits: [] },
        { id: "c", name: "C", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "a" },
        { id: "end", kind: "end", column: "c" },
      ],
      edges: [{ from: "start", to: "end" }],
    });
    // Even a skip move by an agent returns undefined on a non-company board.
    expect(validateCompanyBoardMove(plain, "a", "c", asExecutor)).toBeUndefined();
  });

  it("company board adjacency lets the human reach any column (skip allowed at graph level)", () => {
    // The all-to-all company adjacency is what keeps the human owner unrestricted;
    // the actor rule (above) is what narrows agents.
    const allowed = resolveAllowedColumns(ir, "todo");
    expect(allowed).toEqual(expect.arrayContaining(["in-progress", "in-review", "done", "archived"]));
    expect(allowed).not.toContain("todo");
  });
});

describe("U3 company-board column placement rules (R1/R2)", () => {
  const existing = staffedCompanyIr();
  if (existing.version !== "v2") throw new Error("expected v2");

  /** Splice a custom column into the company IR's columns at `index`. */
  function withCustomColumnAt(index: number): WorkflowIr {
    if (existing.version !== "v2") throw new Error("expected v2");
    const custom: WorkflowIrColumn = { id: "deploy", name: "Deploy", traits: [] };
    const columns = [...existing.columns];
    columns.splice(index, 0, custom);
    return { ...existing, columns };
  }

  function indexOf(id: string): number {
    if (existing.version !== "v2") throw new Error("expected v2");
    return existing.columns.findIndex((c) => c.id === id);
  }

  it("custom column between todo and in-review succeeds", () => {
    const next = withCustomColumnAt(indexOf("in-progress")); // after todo, before in-review
    expect(() => validateCompanyBoardColumnEdit(existing, next)).not.toThrow();
  });

  it("custom column after in-review (post-approval, before done) succeeds", () => {
    const next = withCustomColumnAt(indexOf("done")); // after in-review, before done
    expect(() => validateCompanyBoardColumnEdit(existing, next)).not.toThrow();
  });

  it("custom column before todo is rejected", () => {
    const next = withCustomColumnAt(0);
    try {
      validateCompanyBoardColumnEdit(existing, next);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(CompanyBoardColumnEditError);
      expect((err as CompanyBoardColumnEditError).reason).toBe("custom-column-before-todo");
    }
  });

  it("deleting a role column is rejected", () => {
    if (existing.version !== "v2") throw new Error("expected v2");
    const next = { ...existing, columns: existing.columns.filter((c) => c.id !== "in-review") };
    try {
      validateCompanyBoardColumnEdit(existing, next);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(CompanyBoardColumnEditError);
      expect((err as CompanyBoardColumnEditError).reason).toBe("role-column-deleted");
    }
  });

  it("renaming a role column is rejected", () => {
    if (existing.version !== "v2") throw new Error("expected v2");
    const next = {
      ...existing,
      columns: existing.columns.map((c) => (c.id === "todo" ? { ...c, name: "Inbox" } : c)),
    };
    try {
      validateCompanyBoardColumnEdit(existing, next);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(CompanyBoardColumnEditError);
      expect((err as CompanyBoardColumnEditError).reason).toBe("role-column-renamed");
    }
  });

  it("editing a role column's agent binding is allowed", () => {
    if (existing.version !== "v2") throw new Error("expected v2");
    const next = {
      ...existing,
      columns: existing.columns.map((c) =>
        c.id === "todo" ? { ...c, agent: { agentId: "new-lead", mode: "defer" as const } } : c,
      ),
    };
    expect(() => validateCompanyBoardColumnEdit(existing, next)).not.toThrow();
  });

  it("a non-company existing workflow is untouched (validator no-ops)", () => {
    const plain = parseWorkflowIr({
      version: "v2",
      name: "plain",
      columns: [
        { id: "todo", name: "Todo", traits: [] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "todo" },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [{ from: "start", to: "end" }],
    });
    // Deleting "todo" from a non-company workflow does not trip the role rules.
    const next = parseWorkflowIr({
      version: "v2",
      name: "plain",
      columns: [{ id: "done", name: "Done", traits: [{ trait: "complete" }] }],
      nodes: [
        { id: "start", kind: "start", column: "done" },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [{ from: "start", to: "end" }],
    });
    expect(() => validateCompanyBoardColumnEdit(plain, next)).not.toThrow();
  });
});

describe("U3 actor threading through moveTask (flag-on store, AE4)", () => {
  const harness = createTaskStoreTestHarness();
  let store: TaskStore;
  let companyWorkflowId: string;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
    await store.updateGlobalSettings({
      experimentalFeatures: { workflowColumns: true, companyModel: true },
    });
    // A saved custom workflow carrying the company template + staffed role
    // columns, so the move seam resolves a company board IR (and role identity).
    const def = await store.createWorkflowDefinition({
      name: "company",
      ir: staffedCompanyIr(),
    });
    companyWorkflowId = def.id;
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  /** A task selecting the company workflow, parked in `todo`. */
  async function companyTask(): Promise<string> {
    const task = await store.createTask({ description: "company task" });
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await store.selectTaskWorkflowAndReconcile(task.id, companyWorkflowId);
    return task.id;
  }

  it("AE4: executor-agent move todo→in-review (skip) is rejected; human succeeds", async () => {
    const rejected = await companyTask();
    await expect(
      store.moveTask(rejected, "in-review", {
        moveSource: "user",
        actor: { kind: "agent", agentId: EXECUTOR },
      }),
    ).rejects.toThrow(/skip|advance one column/i);

    // Same move by the human owner succeeds (default actor is human; pass it
    // explicitly for clarity).
    const ok = await companyTask();
    const moved = await store.moveTask(ok, "in-review", {
      moveSource: "user",
      actor: { kind: "human" },
      allowDirectInReviewMove: true,
    });
    expect(moved.column).toBe("in-review");
  });

  it("sequential agent move todo→in-progress succeeds", async () => {
    const id = await companyTask();
    const moved = await store.moveTask(id, "in-progress", {
      moveSource: "user",
      actor: { kind: "agent", agentId: EXECUTOR },
    });
    expect(moved.column).toBe("in-progress");
  });

  it("default actor (omitted) is human — existing callers stay exempt", async () => {
    const id = await companyTask();
    // No actor supplied: behaves as the human owner, so a skip is allowed.
    const moved = await store.moveTask(id, "in-review", {
      moveSource: "user",
      allowDirectInReviewMove: true,
    });
    expect(moved.column).toBe("in-review");
  });

  it("save path rejects renaming a role column on a company board (server-side)", async () => {
    const ir = staffedCompanyIr();
    if (ir.version !== "v2") throw new Error("expected v2");
    // Rename keeps the column (and its nodes) valid, so the IR parses and the
    // placement validator is what fires (a delete would trip an earlier
    // node-references-undefined-column parse error — a different, also-valid
    // rejection; the pure-function suite covers the delete case directly).
    const renamed = {
      ...ir,
      columns: ir.columns.map((c) => (c.id === "in-review" ? { ...c, name: "QA" } : c)),
    };
    await expect(
      store.updateWorkflowDefinition(companyWorkflowId, { ir: renamed }),
    ).rejects.toThrow(/cannot be renamed/i);
  });

  it("save path rejects a custom column before todo (server-side)", async () => {
    const ir = staffedCompanyIr();
    if (ir.version !== "v2") throw new Error("expected v2");
    const custom: WorkflowIrColumn = { id: "inbox", name: "Inbox", traits: [] };
    const next = { ...ir, columns: [custom, ...ir.columns] };
    await expect(
      store.updateWorkflowDefinition(companyWorkflowId, { ir: next }),
    ).rejects.toThrow(/before the Todo column/i);
  });
});
