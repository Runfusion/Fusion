/*
FNXC:WorkflowResolvedColumns 2026-07-30-20:30 (issue panels reported nothing fixed on a renamed board):

`aggregateGithubIssueAnalytics` and its GitLab twin filtered their resolved-issue query on
`"column" = 'done'`. On a renamed board that matches nothing, so `fixed` is ZERO, the resolved-issue
list is empty, and `net` reports every filed issue as still outstanding — while the team closes
issues all week. Nothing errors.

WHY NO EXISTING CHECK SAW IT. The lifecycle census parses TypeScript comparisons; the id lives inside
a SQL string. The sweep that converted these files' TypeScript guards left the queries alone and both
files scored as converted.

BOTH PROVIDERS ARE COVERED because they are copies, and a copy is exactly what gets half-fixed. The
two files carry the same query with only the provider literal differing, so a change applied to one
and not the other type-checks, passes that provider's test, and leaves the other silently broken.
*/

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { aggregateGithubIssueAnalytics } from "../../github-issue-analytics.js";
import { aggregateGitlabIssueAnalytics } from "../../gitlab-issue-analytics.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../index.js";

const IN_RANGE = "2026-06-15T12:00:00.000Z";
const RANGE = { from: "2026-06-01T00:00:00.000Z", to: "2026-06-30T23:59:59.999Z" };

pgDescribe("issue analytics under a renamed board vocabulary", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_issue_analytics_lanes",
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
    ir.id = "custom:renamed-issue-analytics";
    for (const node of ir.nodes ?? []) node.column = rename(node.column);
    for (const column of ir.columns ?? []) column.id = rename(column.id) as string;

    const ids = (ir.columns ?? []).map((column) => column.id);
    expect(ids).toContain("shipped");
    expect(ids).not.toContain("done");

    await h.store().createWorkflowDefinition({ name: "Renamed", kind: "workflow", ir } as never);
  }

  /** An imported issue task resting in `lane`, closed inside the query range. */
  async function seedResolvedIssue(provider: "github" | "gitlab", lane: string): Promise<void> {
    const store = h.store();
    const id = `KB-${provider.toUpperCase()}`;
    await store.createTaskWithReservedId(
      { description: id, column: "todo" },
      { taskId: id, createdAt: IN_RANGE, updatedAt: IN_RANGE, applyDefaultWorkflowSteps: false },
    );
    /* Seeded directly: these provider-tracking columns are not settable through updateTask, and the
       query keys on source_issue_closed_at falling inside the range. */
    await h.adminDb().execute(sql`
      UPDATE project.tasks
         SET "column" = ${lane},
             source_issue_provider = ${provider},
             source_issue_repository = 'acme/widgets',
             source_issue_number = 42,
             source_issue_url = 'https://example.invalid/42',
             source_issue_closed_at = ${IN_RANGE},
             updated_at = ${IN_RANGE}
       WHERE id = ${id}`);
    store.taskCache.delete(id);
  }

  const layer = () => Object.assign(h.layer(), { projectId: "p1" });

  /* Both providers, both vocabularies. The renamed rows are the defect; the default rows are the
     control that proves a generally broken aggregator cannot hide behind them. */
  const CASES = [
    { provider: "github" as const, run: aggregateGithubIssueAnalytics },
    { provider: "gitlab" as const, run: aggregateGitlabIssueAnalytics },
  ];

  for (const { provider, run } of CASES) {
    it(`${provider}: default vocabulary counts a resolved issue`, async () => {
      await seedResolvedIssue(provider, "done");

      const result = await run(layer(), RANGE, h.store());

      expect(result.fixed).toBe(1);
    });

    it(`${provider}: renamed vocabulary counts a resolved issue`, async () => {
      await seedRenamedWorkflow();
      await seedResolvedIssue(provider, "shipped");

      const result = await run(layer(), RANGE, h.store());

      expect(result.fixed).toBe(1);
    });

    /*
    The paired negative: resolving real lanes must not degrade into "every column is complete". An
    issue whose task is still being worked is not fixed — otherwise the panel overstates resolution,
    which is worse than understating it because a plausible number invites no scrutiny.
    */
    it(`${provider}: renamed vocabulary does NOT count an issue still in the WIP lane`, async () => {
      await seedRenamedWorkflow();
      await seedResolvedIssue(provider, "building");

      const result = await run(layer(), RANGE, h.store());

      expect(result.fixed).toBe(0);
    });

    it(`${provider}: without a lane store, the legacy id still answers`, async () => {
      await seedResolvedIssue(provider, "done");

      const result = await run(layer(), RANGE);

      expect(result.fixed).toBe(1);
    });
  }
});
