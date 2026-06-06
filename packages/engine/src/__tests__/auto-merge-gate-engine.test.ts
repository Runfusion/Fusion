// @vitest-environment node
//
// Company-model U7 — the auto-merge chokepoint (engine binding) + verdict-driven
// enqueue seam.
//
// Exercises the engine wrapper `resolveAutoMergeRoute` against a REAL flag-on
// TaskStore + a staffed company-template workflow (so IR resolution, the
// company-board flag, PR-node detection, the persisted verdict, and the
// manual-approval marker are all resolved from real state), plus the ReviewerGate
// `onVerdictPass` seam (entry-vs-verdict ordering: the enqueue fires on verdict
// pass, not on in-review entry).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TaskStore,
  parseWorkflowIr,
  COMPANY_BOARD_TEMPLATE_IR,
  MANUAL_APPROVAL_LOG_PREFIX,
  type WorkflowIr,
  type WorkflowIrColumn,
} from "@fusion/core";
import { resolveAutoMergeRoute, irIsPrMode } from "../auto-merge-gate-engine.js";
import { ReviewerGate, type ReviewerEvaluator } from "../reviewer-gate.js";

const LEAD = "agent-lead";
const EXECUTOR = "agent-executor";
const REVIEWER = "agent-reviewer";

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function staffedCompanyIr(template: WorkflowIr): WorkflowIr {
  if (template.version !== "v2") throw new Error("expected v2");
  const columns: WorkflowIrColumn[] = template.columns.map((c) => {
    if (c.role === "lead") return { ...c, agent: { agentId: LEAD, mode: "defer" as const } };
    if (c.role === "executor") return { ...c, agent: { agentId: EXECUTOR, mode: "defer" as const } };
    if (c.role === "reviewer") return { ...c, agent: { agentId: REVIEWER, mode: "defer" as const } };
    return c;
  });
  return parseWorkflowIr({ ...template, columns });
}

/** A staffed company IR with a `pr-create` node spliced between `merge` and `end`
 *  in the reviewer column — marks the board PR-mode (the unified PR entity drives
 *  merge). Re-wires the `merge → end` (success) edge through the new node so the
 *  graph stays a valid linear flow. */
function prModeCompanyIr(template: WorkflowIr): WorkflowIr {
  const staffed = staffedCompanyIr(template);
  if (staffed.version !== "v2") throw new Error("expected v2");
  const reviewerCol = staffed.columns.find((c) => c.role === "reviewer");
  const edges = staffed.edges
    // drop the success edge merge→end; route merge→pr-create→end instead.
    .filter((e) => !(e.from === "merge" && e.to === "end" && e.condition === "success"))
    .concat([
      { from: "merge", to: "pr-create-node", condition: "success" },
      { from: "pr-create-node", to: "end" },
    ]);
  return parseWorkflowIr({
    ...staffed,
    nodes: [...staffed.nodes, { id: "pr-create-node", kind: "pr-create", column: reviewerCol?.id }],
    edges,
  });
}

describe("U7 auto-merge-gate-engine", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;
  let companyWorkflowId: string;
  let prCompanyWorkflowId: string;

  async function setup(): Promise<void> {
    rootDir = makeTmpDir("kb-u7-amg-");
    globalDir = makeTmpDir("kb-u7-amg-global-");
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
    // autoMerge defaults to true (settings-schema); set the flag on.
    await store.updateGlobalSettings({
      experimentalFeatures: { workflowColumns: true, companyModel: true },
    });
    companyWorkflowId = (
      await store.createWorkflowDefinition({ name: "company", ir: staffedCompanyIr(COMPANY_BOARD_TEMPLATE_IR) })
    ).id;
    prCompanyWorkflowId = (
      await store.createWorkflowDefinition({ name: "company-pr", ir: prModeCompanyIr(COMPANY_BOARD_TEMPLATE_IR) })
    ).id;
  }

  async function teardown(): Promise<void> {
    store.close();
    await rm(rootDir, { recursive: true, force: true });
    await rm(globalDir, { recursive: true, force: true });
  }

  /** Create a task on a workflow and walk it (agent adjacent-forward) to in-review. */
  async function taskInReview(workflowId: string): Promise<string> {
    const task = await store.createTask({ description: "company task" });
    await store.selectTaskWorkflowAndReconcile(task.id, workflowId);
    for (const target of ["todo", "in-progress", "in-review"]) {
      await store.moveTask(task.id, target, { moveSource: "user", actor: { kind: "agent", agentId: EXECUTOR } });
    }
    return task.id;
  }

  const passEvaluator: ReviewerEvaluator = async () => ({ status: "pass", summary: "all good" });

  beforeEach(setup);
  afterEach(teardown);

  it("irIsPrMode detects pr-* nodes", () => {
    expect(irIsPrMode(staffedCompanyIr(COMPANY_BOARD_TEMPLATE_IR))).toBe(false);
    expect(irIsPrMode(prModeCompanyIr(COMPANY_BOARD_TEMPLATE_IR))).toBe(true);
  });

  it("company coding board: verdict pending → blocked; after pass → auto-enqueue", async () => {
    const id = await taskInReview(companyWorkflowId);

    // Entry: no verdict yet → blocked (verdict-driven, not entry-driven).
    const before = await resolveAutoMergeRoute({ store }, id);
    expect(before.route).toBe("blocked");

    // Drive the Reviewer → pass.
    const gate = new ReviewerGate({ store, evaluate: passEvaluator });
    expect((await gate.driveReviewForTask(id)).outcome).toBe("passed");

    const after = await resolveAutoMergeRoute({ store }, id);
    expect(after.route).toBe("auto-enqueue");
  });

  it("PR-mode company board: a passing verdict routes pr-subgraph (never the legacy queue)", async () => {
    const id = await taskInReview(prCompanyWorkflowId);
    const gate = new ReviewerGate({ store, evaluate: passEvaluator });
    expect((await gate.driveReviewForTask(id)).outcome).toBe("passed");

    const route = await resolveAutoMergeRoute({ store }, id);
    expect(route.route).toBe("pr-subgraph");
  });

  it("explicit manual-approval marker → manual-required, never auto", async () => {
    const id = await taskInReview(companyWorkflowId);
    const gate = new ReviewerGate({ store, evaluate: passEvaluator });
    await gate.driveReviewForTask(id);
    // Stamp the explicit manual-approval marker on the task log.
    await store.logEntry(id, `${MANUAL_APPROVAL_LOG_PREFIX}pass)`, "manually approved");

    const route = await resolveAutoMergeRoute({ store }, id);
    expect(route.route).toBe("manual-required");
  });

  it("entry-vs-verdict ordering: onVerdictPass fires the enqueue on pass, not at entry", async () => {
    const enqueued: string[] = [];
    const gate = new ReviewerGate({
      store,
      evaluate: passEvaluator,
      onVerdictPass: async (taskId) => {
        const routing = await resolveAutoMergeRoute({ store }, taskId);
        if (routing.route === "auto-enqueue") enqueued.push(taskId);
      },
    });

    const id = await taskInReview(companyWorkflowId);
    // At entry, before the drive, nothing has been enqueued.
    expect(enqueued).toEqual([]);

    expect((await gate.driveReviewForTask(id)).outcome).toBe("passed");
    expect(enqueued).toEqual([id]);
  });

  it("PR-mode onVerdictPass does NOT enqueue the legacy queue", async () => {
    const enqueued: string[] = [];
    const gate = new ReviewerGate({
      store,
      evaluate: passEvaluator,
      onVerdictPass: async (taskId) => {
        const routing = await resolveAutoMergeRoute({ store }, taskId);
        if (routing.route === "auto-enqueue") enqueued.push(taskId);
      },
    });
    const id = await taskInReview(prCompanyWorkflowId);
    expect((await gate.driveReviewForTask(id)).outcome).toBe("passed");
    expect(enqueued).toEqual([]); // routed to pr-subgraph, never the legacy queue
  });

  it("two-task differential: pass enqueues, fail does not", async () => {
    const passId = await taskInReview(companyWorkflowId);
    const failId = await taskInReview(companyWorkflowId);

    await new ReviewerGate({ store, evaluate: passEvaluator }).driveReviewForTask(passId);
    await new ReviewerGate({
      store,
      evaluate: async () => ({ status: "fail", summary: "nope" }),
    }).driveReviewForTask(failId);

    expect((await resolveAutoMergeRoute({ store }, passId)).route).toBe("auto-enqueue");
    // The fail task was moved backward out of in-review by the gate; its route is
    // not auto-enqueue regardless.
    expect((await resolveAutoMergeRoute({ store }, failId)).route).not.toBe("auto-enqueue");
  });

  it("flag off: degrades to global×override only (verdict never consulted)", async () => {
    await store.updateGlobalSettings({
      experimentalFeatures: { workflowColumns: true, companyModel: false },
    });
    const id = await taskInReview(companyWorkflowId);
    // Flag off → not a company board for gating; global on + no override → auto-enqueue
    // even though there is NO verdict (verdict is never consulted).
    const route = await resolveAutoMergeRoute({ store }, id);
    expect(route.route).toBe("auto-enqueue");
  });
});
