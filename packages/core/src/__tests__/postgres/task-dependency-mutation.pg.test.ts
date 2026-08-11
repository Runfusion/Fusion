/**
 * FNXC:SqliteFinalRemoval 2026-06-25-00:00:
 * PostgreSQL-backed counterpart of task-dependency-mutation.test.ts.
 *
 * Migrated from `createSharedTaskStoreTestHarness` (SQLite) to
 * `createSharedPgTaskStoreTestHarness`. Validates dependency mutation
 * operations (replace/add/remove/set) work identically against PostgreSQL
 * backend mode.
 */
import { afterEach, beforeEach, describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { TaskStore } from "../../store.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../workflows/builtin-coding-workflow-ir.js";

const pgTest = pgDescribe;

const SPEC_LOCK_PROMPT = `# Task\n\n## Mission\n\nKeep dependency scope observable.\n\n## File Scope\n\n- packages/core/src/store.ts\n\n## Steps\n\n1. Preserve evidence\n\n## Completion Criteria\n\n- [ ] Evidence is retained\n\n## Do NOT\n\n- Hide dependency changes\n\n## Dependencies\n\n- None\n`;

pgTest("TaskStore dependency mutations (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_dep_mut",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  let store: TaskStore;

  beforeEach(async () => {
    await h.beforeEach();
    store = h.store();
  });

  afterEach(h.afterEach);

  it("captures a comparable drift revision after a live dependency mutation", async () => {
    const prerequisite = await store.createTask({ description: "locked prerequisite", column: "done" });
    const dependent = await store.createTask({ description: "locked dependent", column: "todo" });
    await store.updateTask(dependent.id, { prompt: SPEC_LOCK_PROMPT });
    await store.lockCurrentPlan(dependent.id, "approved-dependency-scope", SPEC_LOCK_PROMPT);
    await store.updateTask(dependent.id, { approvedPlanFingerprint: "approved-dependency-scope" });

    await store.updateTaskDependencies(dependent.id, { operation: "add", dependency: prerequisite.id });

    const [current, report] = await Promise.all([
      store.getLatestCurrentPlanEvidence(dependent.id),
      store.getLatestSpecDriftReport(dependent.id),
    ]);
    expect(current?.version).toBe(2);
    expect(current?.plan.sections.dependencies.canonical).toContain(`task-dependency:${prerequisite.id}`);
    expect(report).toEqual(expect.objectContaining({
      alignment: "diverged-needs-review",
      findings: expect.arrayContaining([expect.objectContaining({ kind: "silent-expansion", category: "dependencies" })]),
    }));
  });

  it("captures a comparable drift revision after a live lineage mutation", async () => {
    const task = await store.createTask({ description: "locked lineage", column: "todo" });
    await store.updateTask(task.id, { prompt: SPEC_LOCK_PROMPT });
    await store.lockCurrentPlan(task.id, "approved-lineage-scope", SPEC_LOCK_PROMPT);
    await store.updateTask(task.id, { approvedPlanFingerprint: "approved-lineage-scope" });

    await store.updateTask(task.id, { missionId: "M-re-scoped", sliceId: "S-re-scoped" });

    const [current, report] = await Promise.all([
      store.getLatestCurrentPlanEvidence(task.id),
      store.getLatestSpecDriftReport(task.id),
    ]);
    expect(current?.version).toBe(2);
    expect(current?.plan.sections.lineage.canonical).toContain("mission:M-re-scoped");
    expect(report).toEqual(expect.objectContaining({
      alignment: "diverged-needs-review",
      findings: expect.arrayContaining([expect.objectContaining({ kind: "silent-expansion", category: "lineage" })]),
    }));
  });

  it("replaces an obsolete dependency and clears stale blockers when the replacement is done", async () => {
    const obsolete = await store.createTask({ description: "obsolete prerequisite" });
    const canonical = await store.createTask({ description: "canonical prerequisite", column: "done" });
    const dependent = await store.createTask({
      description: "dependent task",
      column: "todo",
      dependencies: [obsolete.id],
    });
    await store.updateTask(dependent.id, { status: "queued", blockedBy: obsolete.id });

    const updated = await store.updateTaskDependencies(dependent.id, {
      operation: "replace",
      from: obsolete.id,
      to: canonical.id,
    });

    expect(updated.dependencies).toEqual([canonical.id]);
    expect(updated.blockedBy).toBeUndefined();
    // A newly introduced prerequisite invalidates any in-flight planning handoff.
    expect(updated.status).toBe("needs-replan");
    /*
    FNXC:WorkflowLifecycleColumns 2026-08-02-03:20 (fleet — this assertion pinned a live bug):
    THE RE-SPECIFICATION TARGET IS THE BOARD'S INTAKE COLUMN, and on today's default lineage that is
    `todo`, not `triage`. U11 (#2515) merged Todo into Planning KEEPING the id `todo` and DELETING
    `triage` — measured from `resolveDefaultWorkflowIr()`:

      todo[intake,hold,reset-on-entry]  in-progress[wip,...]  in-review[merge,...]  done[complete]  archived

    So the old code wrote a column the shipped board does not declare, and this expectation locked that in.
    A test asserting `"triage"` was not protecting behaviour; it was protecting a stale literal that
    outlived its column.

    The rest of the re-specification contract is unchanged and still asserted above: dependencies replaced,
    stale blocker cleared, status cleared. What changes is that a board whose intake and hold are the SAME
    column performs no move — and therefore emits no `task:moved` for one, which is correct: announcing a
    move into the column the card already occupies re-runs reset-on-entry effects in every listener.
    */
    expect(updated.column).toBe("todo");

    const reloaded = await store.getTask(dependent.id);
    expect(reloaded.dependencies).toEqual([canonical.id]);
    expect(reloaded.blockedBy).toBeUndefined();

    const taskJson = JSON.parse(
      await readFile(join(h.rootDir(), ".fusion", "tasks", dependent.id, "task.json"), "utf-8"),
    ) as { dependencies: string[]; blockedBy?: string; column: string; status?: string };
    expect(taskJson.dependencies).toEqual([canonical.id]);
    expect(taskJson.blockedBy).toBeUndefined();
    expect(taskJson.status).toBe("needs-replan");
    // Same reasoning as above: the intake column of the default lineage is `todo` post-U11.
    expect(taskJson.column).toBe("todo");
  });

  /*
  FNXC:PlanningDependencyReseed 2026-08-04-01:57:
  A dependency re-seed commits its task fence and pending continuation retirement
  in one transaction for both public dependency APIs. A list-then-transition
  implementation could otherwise cancel a worker after it claimed the
  continuation between those independent writes.
  */
  it("atomically fences the task and cancels only its pending continuation", async () => {
    const prerequisite = await store.createTask({ description: "new prerequisite", column: "done" });
    const dependent = await store.createTask({ description: "dependent", column: "todo" });
    const pending = await store.replaceActiveTaskWorkflowContinuation({
      runId: `${dependent.id}:continuation:0`, taskId: dependent.id, nodeId: "plan-review",
      kind: "task", state: "runnable", stableWorkflowRunId: `${dependent.id}:workflow`,
      continuationSequence: 0, waitReason: "planning", sourceColumn: "todo", targetColumn: "todo", irHash: "ir-v1",
    });

    await store.updateTaskDependencies(dependent.id, { operation: "add", dependency: prerequisite.id });

    expect((await store.getTask(dependent.id)).status).toBe("needs-replan");
    expect((await store.getWorkflowWorkItem(pending.id))?.state).toBe("cancelled");
  });

  it("uses the same atomic invalidation for updateTask dependency patches", async () => {
    const prerequisite = await store.createTask({ description: "patch prerequisite", column: "done" });
    const dependent = await store.createTask({ description: "patch dependent", column: "todo" });
    const pending = await store.replaceActiveTaskWorkflowContinuation({
      runId: `${dependent.id}:continuation:0`, taskId: dependent.id, nodeId: "plan-review",
      kind: "task", state: "held", stableWorkflowRunId: `${dependent.id}:workflow`,
      continuationSequence: 0, waitReason: "planning", sourceColumn: "todo", targetColumn: "todo", irHash: "ir-v1",
    });

    await store.updateTask(dependent.id, { dependencies: [prerequisite.id] });

    expect((await store.getTask(dependent.id)).status).toBe("needs-replan");
    expect((await store.getWorkflowWorkItem(pending.id))?.state).toBe("cancelled");
  });

  /*
  FNXC:SpecLock 2026-08-09-20:34:
  A mission/slice link is planning lineage. It must retire the same acceptance projection as a
  dependency mutation even though no dependency is added and the task remains in its current lane.
  */
  it("invalidates accepted plan evidence when mission lineage changes", async () => {
    const task = await store.createTask({ description: "lineage mutation" });
    await store.updateTask(task.id, {
      approvedPlanFingerprint: "sha256:accepted",
      workflowStepResults: [{
        workflowStepId: "plan-review",
        workflowStepName: "Plan Review",
        status: "passed",
        completedAt: "2026-08-09T20:34:00.000Z",
      }],
    });

    const updated = await store.updateTask(task.id, { missionId: "M-locked", sliceId: "S-locked" });

    expect(updated.missionId).toBe("M-locked");
    expect(updated.sliceId).toBe("S-locked");
    expect(updated.status).toBe("needs-replan");
    expect(updated.approvedPlanFingerprint).toBeUndefined();
    expect(updated.workflowStepResults).toEqual([expect.objectContaining({
      workflowStepId: "plan-review",
      status: "passed",
      supersededAt: expect.any(String),
      supersededReason: "dependency-change",
    })]);
  });

  it("keeps invalidation and continuation cancellation authoritative in a combined updateTask patch", async () => {
    const prerequisite = await store.createTask({ description: "combined prerequisite", column: "done" });
    const dependent = await store.createTask({ description: "combined dependent", column: "todo" });
    const pending = await store.replaceActiveTaskWorkflowContinuation({
      runId: `${dependent.id}:continuation:0`, taskId: dependent.id, nodeId: "plan-review",
      kind: "task", state: "runnable", stableWorkflowRunId: `${dependent.id}:workflow`,
      continuationSequence: 0, waitReason: "planning", sourceColumn: "todo", targetColumn: "todo", irHash: "ir-v1",
    });

    await store.updateTask(dependent.id, {
      dependencies: [prerequisite.id],
      status: null,
      approvedPlanFingerprint: "sha256:current",
      awaitingApprovalReason: "plan-review-replan-cap",
      workflowStepResults: [{
        workflowStepId: "plan-review",
        workflowStepName: "Plan Review",
        status: "passed",
        completedAt: "2026-08-04T02:00:00.000Z",
      }],
    });

    const updated = await store.getTask(dependent.id);
    expect(updated.status).toBe("needs-replan");
    expect(updated.approvedPlanFingerprint).toBeUndefined();
    expect(updated.awaitingApprovalReason).toBeUndefined();
    expect(updated.workflowStepResults).toEqual([
      expect.objectContaining({
        workflowStepId: "plan-review",
        status: "passed",
        supersededAt: expect.any(String),
        supersededReason: "dependency-change",
      }),
    ]);
    expect((await store.getWorkflowWorkItem(pending.id))?.state).toBe("cancelled");
  });

  it.each(["dedicated", "generic"] as const)(
    "preserves but supersedes Plan Review approval through the %s dependency API",
    async (api) => {
      const prerequisite = await store.createTask({ description: `${api} prerequisite`, column: "done" });
      const dependent = await store.createTask({ description: `${api} dependent`, column: "todo" });
      await store.updateTask(dependent.id, {
        workflowStepResults: [{
          workflowStepId: "plan-review",
          workflowStepName: "Plan Review",
          status: "passed",
          completedAt: "2026-08-04T01:00:00.000Z",
        }],
      });
      const pending = await store.replaceActiveTaskWorkflowContinuation({
        runId: `${dependent.id}:continuation:0`, taskId: dependent.id, nodeId: "plan-review",
        kind: "task", state: "runnable", stableWorkflowRunId: `${dependent.id}:workflow`,
        continuationSequence: 0, waitReason: "planning", sourceColumn: "todo", targetColumn: "todo", irHash: "ir-v1",
      });

      if (api === "dedicated") {
        await store.updateTaskDependencies(dependent.id, { operation: "add", dependency: prerequisite.id });
      } else {
        await store.updateTask(dependent.id, { dependencies: [prerequisite.id] });
      }

      const updated = await store.getTask(dependent.id);
      expect(updated.status).toBe("needs-replan");
      expect(updated.workflowStepResults).toEqual([
        expect.objectContaining({
          workflowStepId: "plan-review",
          status: "passed",
          supersededAt: expect.any(String),
          supersededReason: "dependency-change",
        }),
      ]);
      expect((await store.getWorkflowWorkItem(pending.id))?.state).toBe("cancelled");
    },
  );

  it.each(["dedicated", "generic"] as const)(
    "invalidates and rehomes an exhausted split-column Plan Review through the %s dependency API",
    async (api) => {
      const definition = await store.createWorkflowDefinition({
        name: `split review dependency ${api}`,
        ir: {
          ...BUILTIN_CODING_WORKFLOW_IR,
          id: `split-review-dependency-${api}`,
          nodes: BUILTIN_CODING_WORKFLOW_IR.nodes.map((node) =>
            node.id === "plan-review" ? { ...node, column: "in-review" } : node
          ),
        },
      });
      const prerequisite = await store.createTask({
        description: `${api} prerequisite`,
        column: "done",
        workflowId: definition.id,
      } as never);
      const dependent = await store.createTask({
        description: `${api} dependent`,
        workflowId: definition.id,
      } as never);
      const intakeColumn = dependent.column;
      await store.moveTask(dependent.id, "in-review", {
        moveSource: "engine",
        recoveryRehome: true,
        bypassGuards: true,
      });
      await store.updateTask(dependent.id, {
        status: "awaiting-approval",
        awaitingApprovalReason: "plan-review-replan-cap",
        approvedPlanFingerprint: "sha256:stale",
        workflowStepResults: [{
          workflowStepId: "plan-review",
          workflowStepName: "Plan Review",
          status: "failed",
          verdict: "REVISE",
          completedAt: "2026-08-04T05:00:00.000Z",
        }],
      } as never);

      if (api === "dedicated") {
        await store.updateTaskDependencies(dependent.id, {
          operation: "add",
          dependency: prerequisite.id,
        });
      } else {
        await store.updateTask(dependent.id, { dependencies: [prerequisite.id] });
      }

      const updated = await store.getTask(dependent.id);
      expect(updated.column).toBe(intakeColumn);
      expect(updated.status).toBe("needs-replan");
      expect(updated.awaitingApprovalReason).toBeUndefined();
      expect(updated.approvedPlanFingerprint).toBeUndefined();
      expect(updated.workflowStepResults).toContainEqual(expect.objectContaining({
        workflowStepId: "plan-review",
        supersededReason: "dependency-change",
      }));
    },
  );

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-02:05 (PR #2720 review — greptile):
  DISTINCT HOLD AND INTAKE LANES, the configuration the default lineage does not exercise.

  Post-U11 the default board merges hold and intake into one column, so every existing case here runs
  the branch where the re-specification "move" goes nowhere. A board that declares them SEPARATELY is
  supported and takes the other path — and both halves of this branch (the destination write and the
  move timestamp) behave differently there.

  Paired with the merged-lane case below, these pin the rule: the column moves only when the lanes
  differ, and `columnMovedAt` moves only when the column does.
  */
  async function splitLaneWorkflow() {
    return store.createWorkflowDefinition({
      name: "split-lanes",
      ir: {
        version: "v2",
        name: "split-lanes",
        columns: [
          { id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] },
          { id: "ready", name: "Ready", traits: [{ trait: "hold", config: { release: "capacity" } }] },
          { id: "building", name: "Building", traits: [{ trait: "wip" }] },
          { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
        ],
        nodes: [{ id: "start", kind: "start", column: "inbox" }, { id: "end", kind: "end", column: "shipped" }],
        edges: [{ from: "start", to: "end" }],
      },
    } as never);
  }

  it("sends a HOLD-lane card back to a DISTINCT intake lane when a dependency is added", async () => {
    const definition = await splitLaneWorkflow();
    const blocker = await store.createTask({ description: "prerequisite", workflowId: definition.id } as never);
    const dependent = await store.createTask({ description: "dependent", workflowId: definition.id } as never);
    await store.moveTask(dependent.id, "ready" as never, { bypassGuards: true } as never);

    const before = await store.getTask(dependent.id);

    const updated = await store.updateTaskDependencies(dependent.id, {
      operation: "add",
      dependency: blocker.id,
    } as never);

    expect(updated.column).toBe("inbox");
    expect(updated.status).toBe("needs-replan");
    // A real move, so the move timestamp advances.
    expect(updated.columnMovedAt).not.toBe(before.columnMovedAt);
  });

  it("does NOT refresh columnMovedAt when hold and intake are the SAME column", async () => {
    /*
    The default lineage. The card does not move, so the move timestamp must not advance — refreshing it
    restarts time-in-column and every staleness sweep that reads it, making a dependency edit look like
    a fresh arrival.
    */
    const blocker = await store.createTask({ description: "prerequisite" });
    const dependent = await store.createTask({ description: "dependent" });
    const before = await store.getTask(dependent.id);

    const updated = await store.updateTaskDependencies(dependent.id, {
      operation: "add",
      dependency: blocker.id,
    } as never);

    expect(updated.column).toBe(before.column);
    expect(updated.columnMovedAt).toBe(before.columnMovedAt);
  });

  it("removes dependencies and recomputes stale blockers", async () => {
    const active = await store.createTask({ description: "active prerequisite" });
    const resolved = await store.createTask({ description: "resolved prerequisite", column: "done" });
    const dependent = await store.createTask({
      description: "dependent task",
      dependencies: [active.id, resolved.id],
    });
    await store.updateTask(dependent.id, { blockedBy: active.id });

    await expect(
      store.updateTaskDependencies(dependent.id, { operation: "remove", dependency: "FN-404" }),
    ).rejects.toThrow(/does not depend on/);

    const updated = await store.updateTaskDependencies(dependent.id, {
      operation: "remove",
      dependency: active.id,
    });

    expect(updated.dependencies).toEqual([resolved.id]);
    expect(updated.blockedBy).toBeUndefined();
  });

  it("rejects missing replacements, duplicates, self dependencies, and cycles", async () => {
    const a = await store.createTask({ description: "a" });
    const b = await store.createTask({ description: "b", dependencies: [a.id] });
    const c = await store.createTask({ description: "c", dependencies: [a.id] });

    await expect(
      store.updateTaskDependencies(c.id, { operation: "replace", from: b.id, to: a.id }),
    ).rejects.toThrow(/does not depend on/);

    await expect(
      store.updateTaskDependencies(c.id, { operation: "add", dependency: a.id }),
    ).rejects.toThrow(/already depends on/);

    await expect(
      store.updateTaskDependencies(c.id, { operation: "add", dependency: c.id }),
    ).rejects.toThrow(/cannot depend on itself/);

    await expect(
      store.updateTaskDependencies(a.id, { operation: "add", dependency: c.id }),
    ).rejects.toThrow(/Dependency cycle detected/);
  });
});
