/*
FNXC:WorkflowResolvedColumns 2026-07-30-17:40 (analytics reported an idle project on a renamed board):

`aggregateTeamAnalytics` filtered on `"column" = 'done'` and `"column" IN ('in-progress','in-review')`
directly in SQL. On a board whose lanes are renamed, every one of those matched nothing: per-agent
completed counts, the project total, and the in-flight breakdown all came back ZERO.

Nothing errors, which is what makes it expensive. A dashboard reading "0 tasks completed" for a team
that shipped all week looks like an idle project, not a bug, and wrong-but-plausible numbers are the
least likely defect for anyone to file.

WHY NO EXISTING CHECK SAW IT. The lifecycle census parses TypeScript comparisons; these ids live
inside SQL strings, which are string data. The conversion sweep that fixed this file's TypeScript
guards left the queries untouched, and the file scored as converted.

The cases are DIFFERENTIAL: the same seeded work, aggregated twice, under two vocabularies whose
roles are identical and only the ids differ. `shipped` and `building` collide with no legacy id, so a
surviving `'done'` cannot pass by luck.
*/

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { aggregateTeamAnalytics } from "../../board/team-analytics.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../index.js";

const IN_RANGE = "2026-06-15T12:00:00.000Z";
const RANGE = { from: "2026-06-01T00:00:00.000Z", to: "2026-06-30T23:59:59.999Z", now: Date.parse(IN_RANGE) };

pgDescribe("team analytics under a renamed board vocabulary", () => {
  /*
  FNXC:MultiProjectIsolation 2026-08-15-22:10:
  FN-8957 scoped every agent/task analytics read to `layer.projectId`. This file aggregates under
  projectId "p1", so the harness must BIND that same project: an unbound harness writes store rows
  under the GUC default partition ('__legacy_unscoped__' / '') and the scoped aggregate then reads
  zero rows — an isolation false-negative, not the lane-vocabulary defect this file pins.
  Raw adminDb seeds below carry an explicit project_id = 'p1' for the same reason (adminDb bypasses
  the bound GUC, so column defaults would land the row in the legacy partition).
  */
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_team_analytics_lanes",
    projectId: "p1",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** The builtin coding workflow with only its column ids renamed. */
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
    ir.id = "custom:renamed-team-analytics";
    for (const node of ir.nodes ?? []) node.column = rename(node.column);
    for (const column of ir.columns ?? []) column.id = rename(column.id) as string;

    const ids = (ir.columns ?? []).map((column) => column.id);
    expect(ids).toContain("shipped");
    expect(ids).not.toContain("done");

    await h.store().createWorkflowDefinition({ name: "Renamed", kind: "workflow", ir } as never);
  }

  /** One agent with a completed task and one still in flight, in the given lanes. */
  async function seedAgentWork(completeLane: string, wipLane: string): Promise<void> {
    const store = h.store();
    const adminDb = h.adminDb();
    await adminDb.execute(sql`
      INSERT INTO project.agents (id, project_id, name, role, state, created_at, updated_at)
      VALUES ('agent-1', 'p1', 'Agent One', 'executor', 'idle', ${IN_RANGE}, ${IN_RANGE})`);

    for (const [id, lane] of [["KB-DONE", completeLane], ["KB-WIP", wipLane]] as const) {
      await store.createTaskWithReservedId(
        { description: id, column: "todo" },
        { taskId: id, createdAt: IN_RANGE, updatedAt: IN_RANGE, applyDefaultWorkflowSteps: false },
      );
      /* Seeded directly: the aggregator reads assigned_agent_id and column_moved_at, and moveTask
         would stamp columnMovedAt with `now` rather than a date inside the query range. */
      await adminDb.execute(sql`
        UPDATE project.tasks
           SET "column" = ${lane}, assigned_agent_id = 'agent-1', column_moved_at = ${IN_RANGE}
         WHERE id = ${id}`);
      store.taskCache.delete(id);
    }
  }

  /* Control: the default vocabulary counts the completed task. Passes before and after the fix, so a
     generally broken aggregator cannot hide behind the renamed case below. */
  it("default vocabulary: a completed task is counted", async () => {
    await seedAgentWork("done", "in-progress");

    const team = await aggregateTeamAnalytics(Object.assign(h.layer(), { projectId: "p1" }), RANGE, h.store());

    expect(team.totals.tasksCompleted).toBe(1);
  });

  /*
  The defect. Before the fix `"column" = 'done'` matched nothing on this board and the whole project
  reported zero completed work.
  */
  it("renamed vocabulary: a task in the RENAMED complete lane is counted", async () => {
    await seedRenamedWorkflow();
    await seedAgentWork("shipped", "building");

    const team = await aggregateTeamAnalytics(Object.assign(h.layer(), { projectId: "p1" }), RANGE, h.store());

    expect(team.totals.tasksCompleted).toBe(1);
  });

  /*
  The paired negative: resolving the real lanes must not degrade into "every column counts". A task
  still in the WIP lane is not completed work, under either vocabulary — otherwise the fix would turn
  an undercount into an overcount, which is harder to notice.
  */
  it("renamed vocabulary: a task in the WIP lane is NOT counted as completed", async () => {
    await seedRenamedWorkflow();
    await seedAgentWork("building", "building");

    const team = await aggregateTeamAnalytics(Object.assign(h.layer(), { projectId: "p1" }), RANGE, h.store());

    expect(team.totals.tasksCompleted).toBe(0);
  });

  /* Omitting the store must keep the legacy answer, so an unconverted caller is byte-identical. */
  it("without a lane store, the legacy ids still answer", async () => {
    await seedAgentWork("done", "in-progress");

    const team = await aggregateTeamAnalytics(Object.assign(h.layer(), { projectId: "p1" }), RANGE);

    expect(team.totals.tasksCompleted).toBe(1);
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-20:55:
  THE OTHER HALF OF THE PAIR. `completeLanes` (asserted above) and `activeLanes` are declared two
  lines apart in `aggregateTeamAnalytics`; every case above asserts only `totals.tasksCompleted`, so
  the in-flight query `activeLanes` feeds was never observed. Blinding `activeLanes` back to
  `["in-progress","in-review"]` left this whole file green while blinding `completeLanes` failed it —
  one resolver pinned, its neighbour not, in a file named for exactly this concern.

  A per-agent `tasksInProgress: 0` beside a nonzero completed count and real token spend is the same
  wrong-but-plausible shape the header describes: an agent that looks idle while it is working.

  TWO THINGS HAVE TO BE RIGHT, and this asserts both. The SQL must ASK for the board's real wip lane
  (`activeLanes`), and `buildTeamAnalytics` must RECOGNISE the row it gets back — it classifies via
  `isWipColumnRole(query.columnFlagsByName?.get(columnName), columnName)`, which without flags falls
  back to `columnName === "in-progress"` and drops a renamed lane it already fetched. Supplying
  `columnFlagsByName` is therefore part of the caller contract, not test scaffolding: widening the
  query alone would still report zero.
  */
  const RENAMED_WIP_FLAGS = new Map([
    ["building", { countsTowardWip: true, humanReview: false, complete: false, intake: false, hold: false, mergeBlocker: false }],
  ]);

  it("default vocabulary: an in-flight task is counted as in-progress", async () => {
    await seedAgentWork("done", "in-progress");

    const team = await aggregateTeamAnalytics(Object.assign(h.layer(), { projectId: "p1" }), RANGE, h.store());

    expect(team.agents.find((agent) => agent.agentId === "agent-1")?.tasksInProgress).toBe(1);
  });

  it("renamed vocabulary: an in-flight task in the RENAMED wip lane is counted as in-progress", async () => {
    await seedRenamedWorkflow();
    await seedAgentWork("shipped", "building");

    const team = await aggregateTeamAnalytics(
      Object.assign(h.layer(), { projectId: "p1" }),
      { ...RANGE, columnFlagsByName: RENAMED_WIP_FLAGS as never },
      h.store(),
    );

    expect(team.agents.find((agent) => agent.agentId === "agent-1")?.tasksInProgress).toBe(1);
  });

  it("both vocabularies report the SAME in-flight count — no column-id literal survives on this path", async () => {
    await seedRenamedWorkflow();
    await seedAgentWork("shipped", "building");
    const renamed = await aggregateTeamAnalytics(
      Object.assign(h.layer(), { projectId: "p1" }),
      { ...RANGE, columnFlagsByName: RENAMED_WIP_FLAGS as never },
      h.store(),
    );

    expect(renamed.agents.find((agent) => agent.agentId === "agent-1")?.tasksInProgress).toBe(1);
  });
});
