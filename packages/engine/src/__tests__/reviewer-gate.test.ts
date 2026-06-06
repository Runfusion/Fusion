// @vitest-environment node
//
// Company-model U6 — the Reviewer absorbs the Validator (task-keyed verdict).
//
// Uses a REAL flag-on TaskStore + a staffed company-template workflow so the
// done-transition gate (store.moveTask block 2c) and the ReviewerGate drive flow
// are exercised end-to-end. The AI assertion evaluation is stubbed via the
// ReviewerGate `evaluate` seam so the tests are deterministic and offline.
//
// Covers the U6 plan scenarios:
//  - AE1 (verdict half): enter in-review → run starts under Reviewer identity →
//    pass persisted → an AGENT done-move is allowed.
//  - fail → task moved backward to in-progress as the Reviewer actor with
//    feedback attached; re-entering in-review starts a fresh run (round +1).
//  - rework budget exhausted → parks in in-review with a persisted diagnostic;
//    no further automatic backward move.
//  - write-once: a second complete on a terminal run rejected; pass by a
//    non-reviewer identity rejected (store-level — see core store test); here we
//    assert the gate blocks an agent done-move while the verdict is pending.
//  - AE6 (inverted): a human drag in-review→done is REJECTED by the strict human
//    movement matrix, regardless of the verdict (no human drag out of in-review).
//  - orphaned running run → reaped to error; sweep re-drives a fresh run.
//  - flag off: no reviewer runs fire on in-review entry.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TaskStore,
  parseWorkflowIr,
  COMPANY_BOARD_TEMPLATE_IR,
  type WorkflowIr,
  type WorkflowIrColumn,
} from "@fusion/core";
import {
  ReviewerGate,
  REVIEWER_NEEDS_ATTENTION_LOG_PREFIX,
  REVIEWER_FAIL_FEEDBACK_LOG_PREFIX,
  type ReviewerEvaluator,
} from "../reviewer-gate.js";

const LEAD = "agent-lead";
const EXECUTOR = "agent-executor";
const REVIEWER = "agent-reviewer";

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A staffed company IR — mirrors board-team-seed. */
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

describe("ReviewerGate — task-keyed verdict gating (U6)", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;
  let companyWorkflowId: string;

  async function setup(): Promise<void> {
    rootDir = makeTmpDir("kb-engine-reviewer-gate-");
    globalDir = makeTmpDir("kb-engine-reviewer-gate-global-");
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
    await store.updateGlobalSettings({
      experimentalFeatures: { workflowColumns: true, companyModel: true },
    });
    // R6: every company board keeps the full merge machinery — one template.
    const def = await store.createWorkflowDefinition({
      name: "company",
      ir: staffedCompanyIr(COMPANY_BOARD_TEMPLATE_IR),
    });
    companyWorkflowId = def.id;
  }

  async function teardown(): Promise<void> {
    store.close();
    await rm(rootDir, { recursive: true, force: true });
    await rm(globalDir, { recursive: true, force: true });
  }

  /** Create a task on the company workflow and walk it to in-review. The human
   *  matrix forbids dragging into the working pipeline, so we advance via agent
   *  adjacent-forward moves (todo→in-progress→in-review), as the engine would. */
  async function taskInReview(): Promise<string> {
    const task = await store.createTask({ description: "company task" });
    await store.selectTaskWorkflowAndReconcile(task.id, companyWorkflowId);
    // A fresh task lands on the `idea` intake column; walk it forward one column
    // at a time via agent adjacent-forward moves (idea→todo→in-progress→in-review).
    for (const target of ["todo", "in-progress", "in-review"]) {
      await store.moveTask(task.id, target, {
        moveSource: "user",
        actor: { kind: "agent", agentId: EXECUTOR },
      });
    }
    return task.id;
  }

  const passEvaluator: ReviewerEvaluator = async () => ({ status: "pass", summary: "all good" });
  const failEvaluator: ReviewerEvaluator = async () => ({
    status: "fail",
    summary: "needs work",
    failureReasons: [{ title: "missing test", message: "no coverage" }],
  });

  afterEach(async () => {
    await teardown();
  });

  it("AE1: pass verdict persists under Reviewer identity and unblocks the agent done-move", async () => {
    await setup();
    const id = await taskInReview();
    const gate = new ReviewerGate({ store, evaluate: passEvaluator });
    const result = await gate.driveReviewForTask(id);
    expect(result.outcome).toBe("passed");

    const verdict = store.getTaskReviewerStore().getLatestVerdict(id);
    expect(verdict?.status).toBe("pass");
    expect(verdict?.reviewerAgentId).toBe(REVIEWER);

    // An AGENT (the Reviewer) may now move the task forward out of in-review.
    const moved = await store.moveTask(id, "done", {
      moveSource: "user",
      actor: { kind: "agent", agentId: REVIEWER },
    });
    expect(moved.column).toBe("done");
  });

  it("agent done-move is rejected while the verdict is pending (gate consulted)", async () => {
    await setup();
    const id = await taskInReview();
    // No run driven yet → no verdict. An agent cannot leave in-review.
    await expect(
      store.moveTask(id, "done", { moveSource: "user", actor: { kind: "agent", agentId: REVIEWER } }),
    ).rejects.toThrow(/Reviewer must pass|verdict/i);
  });

  it("fail → moves backward to in-progress as Reviewer actor with feedback; re-entry increments the round", async () => {
    await setup();
    const id = await taskInReview();
    const gate = new ReviewerGate({ store, evaluate: failEvaluator });
    const result = await gate.driveReviewForTask(id);
    expect(result.outcome).toBe("failed-moved-backward");

    const task = await store.getTask(id);
    expect(task.column).toBe("in-progress");
    // Feedback attached to the task log.
    expect(task.log.some((e) => e.action.startsWith(REVIEWER_FAIL_FEEDBACK_LOG_PREFIX))).toBe(true);

    const rs = store.getTaskReviewerStore();
    expect(rs.getLatestVerdict(id)?.status).toBe("fail");
    expect(rs.getLatestVerdict(id)?.reworkRound).toBe(0);

    // Re-enter in-review (as human) and re-drive → a fresh run at round 1.
    await store.moveTask(id, "in-review", { moveSource: "user", actor: { kind: "agent", agentId: EXECUTOR } });
    await gate.driveReviewForTask(id);
    const runs = rs.listRunsForTask(id);
    expect(runs).toHaveLength(2);
    expect(runs.some((r) => r.reworkRound === 1)).toBe(true);
  });

  it("rework budget exhausted → parks in in-review with a persisted diagnostic; no further backward move", async () => {
    await setup();
    const id = await taskInReview();
    const gate = new ReviewerGate({ store, evaluate: failEvaluator, maxReworkCycles: 2 });

    // Round 0: fail → moved backward.
    expect((await gate.driveReviewForTask(id)).outcome).toBe("failed-moved-backward");
    await store.moveTask(id, "in-review", { moveSource: "user", actor: { kind: "agent", agentId: EXECUTOR } });

    // Round 1: budget (2) reached → park, NO backward move.
    const second = await gate.driveReviewForTask(id);
    expect(second.outcome).toBe("failed-budget-exhausted");

    const task = await store.getTask(id);
    expect(task.column).toBe("in-review");
    expect(task.log.some((e) => e.action.startsWith(REVIEWER_NEEDS_ATTENTION_LOG_PREFIX))).toBe(true);
  });

  it("AE6 (inverted): a human drag in-review→done is rejected by the strict movement matrix", async () => {
    await setup();
    const id = await taskInReview();
    // No verdict yet. The human matrix forbids any move out of in-review — the
    // rejection comes from the actor-rule layer (not the verdict gate), so it
    // fires regardless of verdict state.
    await expect(
      store.moveTask(id, "done", { moveSource: "user", actor: { kind: "human" } }),
    ).rejects.toThrow(/Human moves are limited/i);
    const pending = await store.getTask(id);
    expect(pending.column).toBe("in-review");

    // Even WITH a passing verdict, the human still cannot drag it out.
    const gate = new ReviewerGate({ store, evaluate: passEvaluator });
    await gate.driveReviewForTask(id);
    await expect(
      store.moveTask(id, "done", { moveSource: "user", actor: { kind: "human" } }),
    ).rejects.toThrow(/Human moves are limited/i);
    expect((await store.getTask(id)).column).toBe("in-review");
  });

  it("orphaned running run → reaped to error; sweep re-drives a fresh run", async () => {
    await setup();
    const id = await taskInReview();
    const rs = store.getTaskReviewerStore();
    // Simulate an orphaned in-flight run (owner crashed mid-run).
    const orphan = rs.startReviewerRun(id, { boardId: store.getTaskBoardId(id) ?? "", reviewerAgentId: REVIEWER });
    expect(rs.hasRunningRun(id)).toBe(true);

    const gate = new ReviewerGate({ store, evaluate: passEvaluator });
    // Use a future `now` so the orphan looks stale (maxAge 1ms).
    const recovery = await gate.recoverOrphanedReviewerRuns(1, Date.now() + 10_000);
    expect(recovery.reapedCount).toBe(1);
    expect(recovery.reDrivenCount).toBe(1);

    expect(rs.getRun(orphan.id)?.status).toBe("error");
    // The re-drive produced a fresh terminal verdict (pass), so the task is no
    // longer verdict-pending.
    expect(rs.hasPassingVerdict(id)).toBe(true);
  });

  it("flag off: no reviewer run fires on drive", async () => {
    await setup();
    const id = await taskInReview();
    // Turn the company-model flag off.
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true, companyModel: false } });
    const gate = new ReviewerGate({ store, evaluate: passEvaluator });
    const result = await gate.driveReviewForTask(id);
    expect(result.outcome).toBe("skipped-flag-off");
    expect(store.getTaskReviewerStore().listRunsForTask(id)).toHaveLength(0);
  });

  it("idempotency: a second drive after a pass verdict is a no-op", async () => {
    await setup();
    const id = await taskInReview();
    const gate = new ReviewerGate({ store, evaluate: passEvaluator });
    await gate.driveReviewForTask(id);
    const again = await gate.driveReviewForTask(id);
    expect(again.outcome).toBe("skipped-verdict-exists");
    expect(store.getTaskReviewerStore().listRunsForTask(id)).toHaveLength(1);
  });
});
