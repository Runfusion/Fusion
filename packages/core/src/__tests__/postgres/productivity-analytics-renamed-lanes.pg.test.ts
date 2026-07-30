/*
FNXC:WorkflowResolvedColumns 2026-07-30-19:30 (task-duration stats computed from an empty set):

`aggregateProductivityAnalytics` filtered its duration query on `"column" = 'done'`. On a renamed
board that matches nothing, so the whole task-duration distribution — median, p90, the spread — is
computed from an EMPTY row set and reports zeros while the project ships work. Nothing errors.

WHY NO EXISTING CHECK SAW IT. The lifecycle census parses TypeScript comparisons; this id lives
inside a SQL string. The sweep that converted this file's TypeScript guards left the query alone and
the file scored as converted.

The cases are DIFFERENTIAL: the same finished task, aggregated under two vocabularies whose roles are
identical and only the ids differ. `shipped` collides with no legacy id, so a surviving `'done'`
cannot pass by luck.
*/

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { aggregateProductivityAnalytics } from "../../productivity-analytics.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../index.js";

const IN_RANGE = "2026-06-15T12:00:00.000Z";
const RANGE = { from: "2026-06-01T00:00:00.000Z", to: "2026-06-30T23:59:59.999Z" };

pgDescribe("productivity analytics under a renamed board vocabulary", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_productivity_lanes",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seedRenamedWorkflow(): Promise<void> {
    const RENAME: Record<string, string> = {
      todo: "drafting",
      "in-progress": "building",
      "in-review": "checking",
      done: "shipped",
    };
    const rename = (id: string | undefined) => (id && RENAME[id]) ?? id;
    const ir = JSON.parse(JSON.stringify(BUILTIN_CODING_WORKFLOW_IR)) as {
      id: string;
      nodes?: { column?: string }[];
      columns?: { id: string }[];
    };
    ir.id = "custom:renamed-productivity";
    for (const node of ir.nodes ?? []) node.column = rename(node.column);
    for (const column of ir.columns ?? []) column.id = rename(column.id) as string;

    const ids = (ir.columns ?? []).map((column) => column.id);
    expect(ids).toContain("shipped");
    expect(ids).not.toContain("done");

    await h.store().createWorkflowDefinition({ name: "Renamed", kind: "workflow", ir } as never);
  }

  /** A finished task with real active/planning time, so it lands in the duration distribution. */
  async function seedFinishedTask(lane: string): Promise<void> {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: "KB-DUR", column: "todo" },
      { taskId: "KB-DUR", createdAt: IN_RANGE, updatedAt: IN_RANGE, applyDefaultWorkflowSteps: false },
    );
    /* Seeded directly: the query needs execution_completed_at inside the range plus non-zero
       cumulative time, neither of which moveTask would produce. */
    await h.adminDb().execute(sql`
      UPDATE project.tasks
         SET "column" = ${lane},
             execution_completed_at = ${IN_RANGE},
             cumulative_active_ms = 60000,
             cumulative_planning_ms = 30000,
             updated_at = ${IN_RANGE}
       WHERE id = 'KB-DUR'`);
    store.taskCache.delete("KB-DUR");
  }

  const run = (withStore: boolean) => aggregateProductivityAnalytics(
    Object.assign(h.layer(), { projectId: "p1" }),
    RANGE,
    withStore ? h.store() : undefined,
  );

  /* Control: the default vocabulary sees the finished task. Passes before and after the fix. */
  it("default vocabulary: a finished task contributes to the duration stats", async () => {
    await seedFinishedTask("done");

    const result = await run(true);

    expect(result.taskDuration.completedTasks).toBe(1);
    expect(result.taskDuration.medianMs).toBe(90_000);
  });

  /* The defect: before the fix this row set was empty on a renamed board. */
  it("renamed vocabulary: a task in the RENAMED complete lane contributes", async () => {
    await seedRenamedWorkflow();
    await seedFinishedTask("shipped");

    const result = await run(true);

    expect(result.taskDuration.completedTasks).toBe(1);
    expect(result.taskDuration.medianMs).toBe(90_000);
  });

  /*
  The paired negative: resolving the real lanes must not degrade into "every column is complete".
  Unfinished work must stay out of the duration distribution, or the fix trades a zero for a wrong
  median — worse, because a plausible number invites no scrutiny.
  */
  it("renamed vocabulary: a task still in the WIP lane does NOT contribute", async () => {
    await seedRenamedWorkflow();
    await seedFinishedTask("building");

    const result = await run(true);

    expect(result.taskDuration.completedTasks).toBe(0);
    expect(result.taskDuration.medianMs).toBeNull();
  });

  /* Omitting the store must keep the legacy answer, so an unconverted caller is byte-identical. */
  it("without a lane store, the legacy id still answers", async () => {
    await seedFinishedTask("done");

    const result = await run(false);

    expect(result.taskDuration.completedTasks).toBe(1);
    expect(result.taskDuration.medianMs).toBe(90_000);
  });
});
