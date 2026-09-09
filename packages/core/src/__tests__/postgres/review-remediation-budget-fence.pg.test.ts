import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { TaskStore } from "../../store.js";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("review remediation budget publication fence (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_review_remediation_budget",
    projectId: "review-budget-project",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seed(id: string) {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: `${id} review remediation budget`, column: "in-review" },
      { taskId: id, applyDefaultWorkflowSteps: false },
    );
    await store.updateTask(id, {
      steps: [{ name: "Implement", status: "done" }],
      currentStep: 0,
      prompt: "# Task\n\n## File Scope\n\n- `old.ts`\n",
      log: [],
      postReviewFixCount: 0,
    });
  }

  function lastSlotPatch(current: Awaited<ReturnType<TaskStore["getTask"]>>) {
    if ((current.postReviewFixCount ?? 0) >= 1 || current.steps?.some((step) => step.status === "pending")) return null;
    return {
      steps: [...(current.steps ?? []), { name: "Fix: review finding", status: "pending" as const }],
      currentStep: current.steps?.length ?? 0,
      prompt: `${current.prompt}\n- \`new.ts\``,
      log: [...(current.log ?? []), {
        timestamp: new Date().toISOString(),
        action: "Review remediation (attempt 1/1)",
        outcome: "Workflow revision key: code-review",
      }],
      postReviewFixCount: (current.postReviewFixCount ?? 0) + 1,
    };
  }

  it("serializes two store instances at the final slot", async () => {
    await seed("FN-315-A");
    const first = h.store();
    const second = new TaskStore(h.rootDir(), h.globalDir(), { asyncLayer: h.layer() });

    const outcomes = await Promise.all([
      first.publishReviewRemediationFenced("FN-315-A", lastSlotPatch),
      second.publishReviewRemediationFenced("FN-315-A", lastSlotPatch),
    ]);

    expect(outcomes.filter((outcome) => outcome.applied)).toHaveLength(1);
    const live = await first.getTask("FN-315-A");
    expect(live.steps?.filter((step) => step.status === "pending")).toHaveLength(1);
    expect(live.log?.filter((entry) => entry.action.includes("attempt 1/1"))).toHaveLength(1);
    expect(live.postReviewFixCount).toBe(1);
  });

  it("keys colliding task ids by project as well as id", async () => {
    await seed("FN-315-SCOPE");
    await h.adminSql()`
      INSERT INTO project.tasks (project_id, id, title, description, priority, "column", status, steps, current_step, log, post_review_fix_count, created_at, updated_at)
      SELECT 'other-review-project', id, title, description, priority, "column", status, steps, current_step, log, post_review_fix_count, created_at, updated_at
      FROM project.tasks
      WHERE project_id = 'review-budget-project' AND id = 'FN-315-SCOPE'
    `;
    const other = new TaskStore(h.rootDir(), h.globalDir(), {
      asyncLayer: { ...h.layer(), projectId: "other-review-project" },
    });

    await expect(other.publishReviewRemediationFenced("FN-315-SCOPE", lastSlotPatch)).resolves.toMatchObject({ applied: true });

    expect((await other.getTask("FN-315-SCOPE")).postReviewFixCount).toBe(1);
    expect((await h.store().getTask("FN-315-SCOPE")).postReviewFixCount).toBe(0);
  });

  it("commits none of the bounded fields on refusal or callback failure", async () => {
    await seed("FN-315-B");
    const store = h.store();
    const before = await store.getTask("FN-315-B");

    await expect(store.publishReviewRemediationFenced("FN-315-B", () => null)).resolves.toMatchObject({ applied: false, reason: "refused" });
    await expect(store.publishReviewRemediationFenced("FN-315-B", () => { throw new Error("injected compute failure"); })).rejects.toThrow("injected compute failure");

    const after = await store.getTask("FN-315-B");
    expect({ steps: after.steps, currentStep: after.currentStep, prompt: after.prompt, log: after.log, count: after.postReviewFixCount })
      .toEqual({ steps: before.steps, currentStep: before.currentStep, prompt: before.prompt, log: before.log, count: before.postReviewFixCount });
  });
});
